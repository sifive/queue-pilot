import { classifyReason } from "@queuepilot/shared";

const PENDING_RE = /^(PD|PENDING)/i;
const RUNNING_RE = /^(R|RUNNING)/i;

const roundHours = (seconds = 0) => Math.round(((seconds || 0) / 3600) * 10) / 10;
const uniq = (values) => [...new Set(values.filter(Boolean))];
const byPendingAge = (a, b) => (b.pendingSeconds || 0) - (a.pendingSeconds || 0) || String(a.jobId).localeCompare(String(b.jobId));
const byElapsedAge = (a, b) => (b.elapsedSeconds || 0) - (a.elapsedSeconds || 0) || String(a.jobId).localeCompare(String(b.jobId));
const byCount = (a, b) => (b.pendingCount || b.runningCount || b.jobCount || 0) - (a.pendingCount || a.runningCount || a.jobCount || 0)
  || (b.maxWaitHours || b.maxElapsedHours || 0) - (a.maxWaitHours || a.maxElapsedHours || 0);

function avg(values) {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function reasonMixFor(jobs) {
  const mix = {};
  for (const job of jobs) {
    const category = job.category || classifyReason(job.reason, job.priority).category;
    mix[category] = (mix[category] || 0) + 1;
  }
  return mix;
}

function summarizeJob(job) {
  return {
    jobId: job.jobId,
    name: job.name,
    state: job.state,
    user: job.user,
    account: job.account,
    partition: job.partition,
    category: job.category,
    wckey: job.wckey,
    workdir: job.workdir,
    waitHours: job.waitHours,
    elapsedHours: job.elapsedHours,
  };
}

export function diagnoseJob(job, opts = {}) {
  const cls = classifyReason(job.reason, job.priority);
  const held = cls.category === "held" || Number(job.priority) === 0;
  const starved = opts.bucketP90Wait ? (job.pendingSeconds || 0) > opts.bucketP90Wait : false;
  const findings = [];
  if (held) findings.push({ type: "held", severity: "warn", message: "priority=0: held or partition deeply constrained." });
  if (cls.category === "licenses") findings.push({ type: "license_bound", severity: "warn", message: cls.explain });
  if (starved) findings.push({ type: "starvation", severity: "warn", message: `Pending ${job.pendingSeconds}s, beyond p90 of its bucket.` });
  return { jobId: job.jobId, category: cls.category, explain: cls.explain, held, starved, findings };
}

export function parseDependencyIds(dependency = "") {
  const text = String(dependency || "").trim();
  if (!text || text === "None" || text === "(null)") return [];
  return [...new Set(text.match(/\b\d+(?:_\d+)?\b/g) || [])];
}

// Reduce a workdir to its build root so siblings of a flow group together.
export function buildPath(workdir = "") {
  const m = workdir.match(/^(.*?\/builds)\//);
  if (m) return m[1];
  return workdir.split("/").slice(0, 7).join("/") || null;
}

export function flowKeyForJob(job) {
  return (job.wckey || "").trim() || buildPath(job.workdir) || "";
}

export function annotateJobs(jobs) {
  const base = jobs.map((job) => {
    const diagnosis = diagnoseJob(job);
    return {
      ...job,
      ...diagnosis,
      isPending: PENDING_RE.test(job.state),
      isRunning: RUNNING_RE.test(job.state),
      waitHours: roundHours(job.pendingSeconds),
      elapsedHours: roundHours(job.elapsedSeconds),
      flowKey: flowKeyForJob(job),
      workdirRoot: buildPath(job.workdir),
      dependencyIds: parseDependencyIds(job.dependency),
      dependencyParentIds: [],
      originParentIds: [],
      blockerIds: [],
      blockerSource: "none",
      workdirHref: job.workdir ? `file://${encodeURI(job.workdir)}` : "",
    };
  });

  const byId = new Map(base.map((job) => [String(job.jobId), job]));
  for (const job of base) {
    job.dependencyParentIds = job.dependencyIds.filter((id) => byId.has(String(id)));
  }

  const flowGroups = new Map();
  for (const job of base) {
    const key = job.flowKey || `job:${job.jobId}`;
    if (!flowGroups.has(key)) flowGroups.set(key, []);
    flowGroups.get(key).push(job);
  }

  for (const jobsInFlow of flowGroups.values()) {
    const memberIds = new Set(jobsInFlow.map((job) => String(job.jobId)));
    const roots = jobsInFlow.filter((job) => job.dependencyParentIds.every((id) => !memberIds.has(String(id))));
    const runningRoots = roots.filter((job) => job.isRunning);
    const originJobs = runningRoots.length ? runningRoots : (roots.length ? roots : jobsInFlow);
    const runningOrigins = originJobs.filter((job) => job.isRunning);

    for (const job of jobsInFlow) {
      job.originParentIds = originJobs.map((candidate) => candidate.jobId);
      if (job.dependencyParentIds.length > 0) {
        job.blockerIds = [...job.dependencyParentIds];
        job.blockerSource = "dependency";
      } else if (job.isPending && runningOrigins.length > 0) {
        job.blockerIds = runningOrigins.filter((candidate) => candidate.jobId !== job.jobId).map((candidate) => candidate.jobId);
        job.blockerSource = job.blockerIds.length > 0 ? "origin_flow" : "none";
      }
    }
  }

  return base.sort((a, b) => {
    if (a.isPending !== b.isPending) return a.isPending ? -1 : 1;
    return byPendingAge(a, b);
  });
}

function buildFlowGroups(annotatedJobs) {
  const byId = new Map(annotatedJobs.map((job) => [String(job.jobId), job]));
  const grouped = new Map();

  for (const job of annotatedJobs) {
    const key = job.flowKey || `job:${job.jobId}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        flowKey: key,
        label: job.wckey || job.workdirRoot || `Job ${job.jobId}`,
        wckey: job.wckey || "",
        workdirRoot: job.workdirRoot || "",
        jobIds: [],
        pendingJobIds: [],
        runningJobIds: [],
        users: new Set(),
        accounts: new Set(),
        partitions: new Set(),
      });
    }
    const group = grouped.get(key);
    group.jobIds.push(job.jobId);
    if (job.isPending) group.pendingJobIds.push(job.jobId);
    if (job.isRunning) group.runningJobIds.push(job.jobId);
    if (job.user) group.users.add(job.user);
    if (job.account) group.accounts.add(job.account);
    if (job.partition) group.partitions.add(job.partition);
  }

  return [...grouped.values()].map((group) => {
    const jobs = group.jobIds.map((jobId) => byId.get(String(jobId))).filter(Boolean);
    const pendingJobs = jobs.filter((job) => job.isPending).sort(byPendingAge);
    const runningJobs = jobs.filter((job) => job.isRunning).sort(byElapsedAge);
    const blockerIds = uniq(pendingJobs.flatMap((job) => job.blockerIds));
    const originParentIds = uniq(jobs.flatMap((job) => job.originParentIds));
    const blockers = blockerIds.map((id) => byId.get(String(id))).filter(Boolean).map(summarizeJob);
    const originParents = originParentIds.map((id) => byId.get(String(id))).filter(Boolean).map(summarizeJob);
    const pendingHours = pendingJobs.map((job) => job.waitHours);
    const elapsedHours = runningJobs.map((job) => job.elapsedHours);
    return {
      flowKey: group.flowKey,
      label: group.label,
      wckey: group.wckey,
      workdirRoot: group.workdirRoot,
      jobCount: jobs.length,
      pendingCount: pendingJobs.length,
      runningCount: runningJobs.length,
      maxWaitHours: pendingHours.length ? Math.max(...pendingHours) : 0,
      avgWaitHours: avg(pendingHours),
      maxElapsedHours: elapsedHours.length ? Math.max(...elapsedHours) : 0,
      avgElapsedHours: avg(elapsedHours),
      reasonMix: reasonMixFor(pendingJobs.length ? pendingJobs : jobs),
      blockerIds,
      blockers,
      blockerSource: pendingJobs.find((job) => job.blockerSource && job.blockerSource !== "none")?.blockerSource || "none",
      originParentIds,
      originParents,
      jobIds: group.jobIds,
      pendingJobIds: group.pendingJobIds,
      runningJobIds: group.runningJobIds,
      users: [...group.users].sort(),
      accounts: [...group.accounts].sort(),
      partitions: [...group.partitions].sort(),
    };
  }).sort(byCount);
}

// Fan-out logjam: running parents with pending jobs in the same flow.
export function detectFanoutLogjam(jobs) {
  const flowGroups = buildFlowGroups(annotateJobs(jobs));
  return flowGroups
    .filter((group) => group.runningCount > 0 && group.pendingCount > 0)
    .map((group) => ({
      type: "fanout_logjam",
      flowKey: group.flowKey,
      parentJobId: group.runningJobIds[0],
      parentJobIds: group.runningJobIds,
      originParentIds: group.originParentIds,
      blockedChildren: group.pendingCount,
      reasonMix: group.reasonMix,
      message: `Flow ${group.label} has ${group.runningCount} active parent run(s) with ${group.pendingCount} pending child job(s).`,
      childJobIds: group.pendingJobIds,
      blockers: group.blockers,
      originParents: group.originParents,
      maxWaitHours: group.maxWaitHours,
    }))
    .sort((a, b) => b.blockedChildren - a.blockedChildren || b.maxWaitHours - a.maxWaitHours);
}

export function buildDiagnosticsDataset(jobs) {
  const annotatedJobs = annotateJobs(jobs);
  const jobsById = new Map(annotatedJobs.map((job) => [String(job.jobId), job]));
  const flowGroups = buildFlowGroups(annotatedJobs);
  const pendingJobs = annotatedJobs.filter((job) => job.isPending);
  const runningJobs = annotatedJobs.filter((job) => job.isRunning);
  const logjams = flowGroups
    .filter((group) => group.runningCount > 0 && group.pendingCount > 0)
    .map((group) => ({
      ...group,
      blockedChildren: group.pendingCount,
      runningParents: group.runningJobIds.map((id) => jobsById.get(String(id))).filter(Boolean).map(summarizeJob),
      childJobIds: [...group.pendingJobIds],
      message: `Flow ${group.label} is split between running parents and pending children.`,
    }))
    .sort((a, b) => b.blockedChildren - a.blockedChildren || b.maxWaitHours - a.maxWaitHours);

  return {
    summary: {
      totalJobs: annotatedJobs.length,
      pendingCount: pendingJobs.length,
      runningCount: runningJobs.length,
      logjamCount: logjams.length,
      uniqueFlows: flowGroups.length,
    },
    jobs: annotatedJobs,
    flows: flowGroups,
    logjams: {
      summary: {
        count: logjams.length,
        blockedChildren: logjams.reduce((sum, item) => sum + item.blockedChildren, 0),
      },
      items: logjams,
    },
    pending: {
      summary: {
        count: pendingJobs.length,
        maxWaitHours: pendingJobs.length ? Math.max(...pendingJobs.map((job) => job.waitHours)) : 0,
        avgWaitHours: avg(pendingJobs.map((job) => job.waitHours)),
        groupedFlows: flowGroups.filter((group) => group.pendingCount > 0).length,
      },
      groups: flowGroups.filter((group) => group.pendingCount > 0).sort((a, b) => b.maxWaitHours - a.maxWaitHours || b.pendingCount - a.pendingCount),
    },
    running: {
      summary: {
        count: runningJobs.length,
        maxElapsedHours: runningJobs.length ? Math.max(...runningJobs.map((job) => job.elapsedHours)) : 0,
        avgElapsedHours: avg(runningJobs.map((job) => job.elapsedHours)),
        groupedFlows: flowGroups.filter((group) => group.runningCount > 0).length,
      },
      groups: flowGroups.filter((group) => group.runningCount > 0).sort((a, b) => b.runningCount - a.runningCount || b.maxElapsedHours - a.maxElapsedHours),
    },
    filters: {
      wckeys: uniq(annotatedJobs.map((job) => job.wckey)).sort(),
      users: uniq(annotatedJobs.map((job) => job.user)).sort(),
      accounts: uniq(annotatedJobs.map((job) => job.account)).sort(),
      partitions: uniq(annotatedJobs.map((job) => job.partition)).sort(),
    },
  };
}
