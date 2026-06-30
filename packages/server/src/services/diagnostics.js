import { classifyReason } from "@queuepilot/shared";

const PENDING_RE = /^(PD|PENDING)/i;
const RUNNING_RE = /^(R|RUNNING)/i;

const roundHours = (seconds = 0) => Math.round(((seconds || 0) / 3600) * 10) / 10;
const uniq = (values) => [...new Set(values.filter(Boolean))];
const byPendingAge = (a, b) => (b.pendingSeconds || 0) - (a.pendingSeconds || 0) || String(a.jobId).localeCompare(String(b.jobId));
const byElapsedAge = (a, b) => (b.elapsedSeconds || 0) - (a.elapsedSeconds || 0) || String(a.jobId).localeCompare(String(b.jobId));
const byCount = (a, b) => (b.pendingCount || b.runningCount || b.jobCount || 0) - (a.pendingCount || a.runningCount || a.jobCount || 0)
  || (b.maxWaitHours || b.maxElapsedHours || 0) - (a.maxWaitHours || a.maxElapsedHours || 0);
const DEFAULT_JOB_LIMIT = 200;
const DEFAULT_GRAPH_SAMPLE_LIMIT = 8;
const NULLISH_FLOW_VALUES = new Set(["", "(null)", "null", "none", "/root"]);

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

function summarizeParent(job) {
  return {
    jobId: job.jobId,
    name: job.name,
    state: job.state,
  };
}

function detailedJob(job, jobsById) {
  const parentIds = job.blockerIds?.length ? job.blockerIds : (job.originParentIds || []).filter((jobId) => jobId !== job.jobId);
  return {
    jobId: job.jobId,
    name: job.name,
    state: job.state,
    user: job.user,
    account: job.account,
    partition: job.partition,
    reason: job.reason,
    category: job.category,
    explain: job.explain,
    wckey: job.wckey,
    flowKey: job.flowKey,
    workdir: job.workdir,
    workdirRoot: job.workdirRoot,
    workdirHref: job.workdirHref,
    waitHours: job.waitHours,
    elapsedHours: job.elapsedHours,
    blockerIds: job.blockerIds,
    originParentIds: job.originParentIds,
    parents: parentIds.map((jobId) => jobsById.get(String(jobId))).filter(Boolean).slice(0, 4).map(summarizeParent),
  };
}

function searchTextForJob(job) {
  return [
    job.jobId,
    job.name,
    job.user,
    job.account,
    job.partition,
    job.state,
    job.reason,
    job.wckey,
    job.flowKey,
    job.workdir,
    job.dependency,
    ...(job.blockerIds || []),
    ...(job.originParentIds || []),
  ].join(" ").toLowerCase();
}

function matchesJobSearch(job, searchTerm) {
  if (!searchTerm) return true;
  return searchTextForJob(job).includes(searchTerm);
}

function matchesGroupSearch(group, searchTerm, jobsById) {
  if (!searchTerm) return true;
  const direct = [
    group.label,
    group.flowKey,
    group.wckey,
    group.workdirRoot,
    ...group.users,
    ...group.accounts,
    ...group.partitions,
    ...group.blockers.map((parent) => `${parent.jobId} ${parent.name}`),
    ...group.originParents.map((parent) => `${parent.jobId} ${parent.name}`),
  ].join(" ").toLowerCase();
  if (direct.includes(searchTerm)) return true;
  return (group.jobIds || []).some((jobId) => {
    const job = jobsById.get(String(jobId));
    return job ? matchesJobSearch(job, searchTerm) : false;
  });
}

function clampInt(value, fallback, max = fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function graphJobSamples(jobIds, jobsById, limit = DEFAULT_GRAPH_SAMPLE_LIMIT) {
  return jobIds.slice(0, limit).map((jobId) => jobsById.get(String(jobId))).filter(Boolean).map(summarizeJob);
}

function compactList(values, limit = 3) {
  const items = values.filter(Boolean);
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} +${items.length - limit}`;
}

function normalizedFlowValue(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isNullishFlowValue(value = "") {
  return NULLISH_FLOW_VALUES.has(normalizedFlowValue(value));
}

export function isControlPlaneGroup(group) {
  const workdirRoot = normalizedFlowValue(group.workdirRoot);
  const label = normalizedFlowValue(group.label);
  const flowKey = normalizedFlowValue(group.flowKey);
  const wckey = normalizedFlowValue(group.wckey);
  return workdirRoot === "/root"
    || (isNullishFlowValue(label) && (workdirRoot === "/root" || isNullishFlowValue(flowKey) || isNullishFlowValue(wckey)));
}

function serializeGroup(group, jobsById, sampleLimit = DEFAULT_GRAPH_SAMPLE_LIMIT) {
  return {
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    jobCount: group.jobCount,
    pendingCount: group.pendingCount,
    runningCount: group.runningCount,
    maxWaitHours: group.maxWaitHours,
    avgWaitHours: group.avgWaitHours,
    maxElapsedHours: group.maxElapsedHours,
    avgElapsedHours: group.avgElapsedHours,
    reasonMix: group.reasonMix,
    blockerSource: group.blockerSource,
    blockers: group.blockers,
    originParents: group.originParents,
    pendingJobs: graphJobSamples(group.pendingJobIds, jobsById, sampleLimit),
    runningJobs: graphJobSamples(group.runningJobIds, jobsById, sampleLimit),
    userLabel: compactList(group.users),
    accountLabel: compactList(group.accounts),
    partitionLabel: compactList(group.partitions),
    isControlPlane: isControlPlaneGroup(group),
  };
}

function diagnosticsSummary(annotatedJobs, flowGroups, logjams) {
  const pendingJobs = annotatedJobs.filter((job) => job.isPending);
  const runningJobs = annotatedJobs.filter((job) => job.isRunning);
  return {
    totalJobs: annotatedJobs.length,
    pendingCount: pendingJobs.length,
    runningCount: runningJobs.length,
    logjamCount: logjams.length,
    uniqueFlows: flowGroups.length,
  };
}

function pageSummary(groups, jobs, mode) {
  if (mode === "pending") {
    return {
      count: jobs.length,
      groupedFlows: groups.length,
      maxWaitHours: jobs.length ? Math.max(...jobs.map((job) => job.waitHours)) : 0,
      avgWaitHours: avg(jobs.map((job) => job.waitHours)),
    };
  }
  return {
    count: jobs.length,
    groupedFlows: groups.length,
    maxElapsedHours: jobs.length ? Math.max(...jobs.map((job) => job.elapsedHours)) : 0,
    avgElapsedHours: avg(jobs.map((job) => job.elapsedHours)),
  };
}

function serializeLogjam(group, jobsById, sampleLimit = DEFAULT_GRAPH_SAMPLE_LIMIT) {
  return {
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    blockedChildren: group.pendingCount,
    runningCount: group.runningCount,
    maxWaitHours: group.maxWaitHours,
    reasonMix: group.reasonMix,
    originParents: group.originParents,
    runningParents: graphJobSamples(group.runningJobIds, jobsById, sampleLimit),
    children: graphJobSamples(group.pendingJobIds, jobsById, sampleLimit),
    message: `Flow ${group.label} has ${group.runningCount} active parent run(s) with ${group.pendingCount} pending child job(s).`,
    isControlPlane: isControlPlaneGroup(group),
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
      controlPlaneFlows: flowGroups.filter((group) => isControlPlaneGroup(group)).length,
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

export function buildDiagnosticsView(jobs, options = {}) {
  const section = options.section || "summary";
  const view = options.view || "graph";
  const searchTerm = String(options.search || "").trim().toLowerCase();
  const jobLimit = clampInt(options.jobLimit, DEFAULT_JOB_LIMIT, 500);
  const jobOffset = clampInt(options.jobOffset, 0, 1000000);
  const sampleLimit = clampInt(options.sampleLimit, DEFAULT_GRAPH_SAMPLE_LIMIT, 20);

  const annotatedJobs = annotateJobs(jobs);
  const jobsById = new Map(annotatedJobs.map((job) => [String(job.jobId), job]));
  const flowGroups = buildFlowGroups(annotatedJobs);
  const controlGroups = flowGroups.filter((group) => isControlPlaneGroup(group));
  const standardGroups = flowGroups.filter((group) => !isControlPlaneGroup(group));
  const logjamGroups = standardGroups
    .filter((group) => group.runningCount > 0 && group.pendingCount > 0)
    .sort((a, b) => b.pendingCount - a.pendingCount || b.maxWaitHours - a.maxWaitHours);
  const summary = diagnosticsSummary(annotatedJobs, flowGroups, logjamGroups);

  if (section === "summary") return { summary };

  if (section === "logjams") {
    const filtered = logjamGroups.filter((group) => matchesGroupSearch(group, searchTerm, jobsById));
    return {
      summary,
      data: {
        kind: "groups",
        total: filtered.length,
        shown: filtered.length,
        limit: null,
        items: filtered.map((group) => serializeLogjam(group, jobsById, sampleLimit)),
      },
    };
  }

  if (section === "control") {
    const filtered = controlGroups.filter((group) => matchesGroupSearch(group, searchTerm, jobsById));
    const controlFlowKeys = new Set(controlGroups.map((group) => group.flowKey));
    const controlJobs = annotatedJobs.filter((job) => controlFlowKeys.has(job.flowKey || `job:${job.jobId}`));
    return {
      summary,
      details: {
        count: controlJobs.length,
        groupedFlows: filtered.length,
        maxWaitHours: controlJobs.length ? Math.max(...controlJobs.map((job) => job.waitHours)) : 0,
        maxElapsedHours: controlJobs.length ? Math.max(...controlJobs.map((job) => job.elapsedHours)) : 0,
      },
      data: {
        kind: "groups",
        total: filtered.length,
        shown: filtered.length,
        limit: null,
        items: filtered.map((group) => serializeGroup(group, jobsById, sampleLimit)),
      },
    };
  }

  if (section === "pending" || section === "running") {
    const mode = section;
    const visibleGroups = standardGroups;
    const visibleFlowKeys = new Set(visibleGroups.map((group) => group.flowKey));
    const groupFilter = (group) => mode === "pending" ? group.pendingCount > 0 : group.runningCount > 0;
    const jobFilter = (job) => mode === "pending" ? job.isPending : job.isRunning;
    const filteredGroups = visibleGroups.filter((group) => groupFilter(group) && matchesGroupSearch(group, searchTerm, jobsById));
    const filteredJobs = annotatedJobs.filter((job) =>
      visibleFlowKeys.has(job.flowKey || `job:${job.jobId}`) &&
      jobFilter(job) &&
      matchesJobSearch(job, searchTerm)
    );
    const details = pageSummary(filteredGroups, filteredJobs, mode);

    if (view === "list") {
      return {
        summary,
        details,
        data: {
          kind: "jobs",
          total: filteredJobs.length,
          offset: jobOffset,
          limit: jobLimit,
          items: filteredJobs.slice(jobOffset, jobOffset + jobLimit).map((job) => detailedJob(job, jobsById)),
        },
      };
    }

    return {
      summary,
      details,
      data: {
        kind: "groups",
        total: filteredGroups.length,
        shown: filteredGroups.length,
        limit: null,
        items: filteredGroups.map((group) => serializeGroup(group, jobsById, sampleLimit)),
      },
    };
  }

  return buildDiagnosticsDataset(jobs);
}
