import { classifyReason } from "@queuepilot/shared";
import { readDiagnosticsCache, writeDiagnosticsCache } from "../db.js";
import { summarizeBlockedRunnerJobs } from "./queue.js";

const PENDING_RE = /^(PD|PENDING)/i;
const RUNNING_RE = /^(R|RUNNING)/i;
const NULLISH_FLOW_VALUES = new Set(["", "(null)", "null", "none", "/root"]);

const DEFAULT_JOB_LIMIT = 200;
const MAX_JOB_LIMIT = 500;
const DEFAULT_GRAPH_SAMPLE_LIMIT = 8;
const INTERNAL_GRAPH_SAMPLE_LIMIT = 8;

const DEFAULT_DRAIN_SLICE_SECONDS = 1800;
const MAX_DRAIN_SLICE_SECONDS = 4 * 3600;

const HOT_ARTIFACT_LIMIT = 8;
const DEFAULT_MAX_PERSISTED_GRAPH_JSON_CHARS = 20_000_000;
const DEFAULT_MAX_PERSISTED_JOBS_JSON_CHARS = 20_000_000;
export const DIAGNOSTICS_ARTIFACT_VERSION = "6";

const hotArtifacts = new Map();
const inflightArtifacts = new Map();

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

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampInt(value, fallback, max = fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function flowIdentity(job) {
  return job.flowKey || `job:${job.jobId}`;
}

function flowLabelForJob(job) {
  return job.wckey || job.flowKey || job.workdirRoot || `Job ${job.jobId}`;
}

function estimateDrainSliceSeconds(job) {
  const remaining = Math.max(0, (job.timelimitSeconds || 0) - (job.elapsedSeconds || 0));
  const observed = Math.max(job.elapsedSeconds || 0, DEFAULT_DRAIN_SLICE_SECONDS);
  const estimate = remaining || observed;
  return Math.max(900, Math.min(estimate, MAX_DRAIN_SLICE_SECONDS));
}

function queueLaneKey(partition = "", account = "") {
  return `${partition || ""}::${account || ""}`;
}

function countAheadFlows(jobs = []) {
  const byFlow = new Map();
  for (const job of jobs) {
    const key = `${job.account || ""}::${flowIdentity(job)}`;
    if (!byFlow.has(key)) {
      byFlow.set(key, {
        flowKey: flowIdentity(job),
        label: flowLabelForJob(job),
        account: job.account || "",
        partition: job.partition || "",
        partitions: job.partition ? [job.partition] : [],
        count: 0,
      });
    }
    const flow = byFlow.get(key);
    flow.count += 1;
    if (job.partition && !flow.partitions.includes(job.partition)) flow.partitions.push(job.partition);
  }
  return [...byFlow.values()]
    .map((flow) => ({
      ...flow,
      partitions: [...flow.partitions].sort(),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function combineQueuePressure(queuePressures, jobsById, extra = {}) {
  const pressures = queuePressures.filter(Boolean);
  const aheadJobIds = uniq(pressures.flatMap((pressure) => pressure.aheadJobIds || []));
  const aheadJobs = aheadJobIds.map((jobId) => jobsById.get(String(jobId))).filter(Boolean);
  const topFlows = countAheadFlows(aheadJobs);
  return {
    partition: pressures.length === 1 ? pressures[0].partition : (extra.partition || ""),
    account: pressures.length === 1 ? pressures[0].account : (extra.account || ""),
    aheadJobs: aheadJobIds.length,
    aheadJobIds,
    externalFlows: topFlows.length,
    drainSeconds: pressures.length ? Math.max(...pressures.map((pressure) => pressure.drainSeconds || 0)) : 0,
    topFlows,
    partitions: uniq(pressures.map((pressure) => pressure.partition)).sort(),
    accounts: uniq(pressures.map((pressure) => pressure.account)).sort(),
  };
}

function summarizeQueuePressure(queuePressure) {
  if (!queuePressure) return null;
  return {
    partition: queuePressure.partition || "",
    account: queuePressure.account || "",
    aheadJobs: queuePressure.aheadJobs || 0,
    externalFlows: queuePressure.externalFlows || 0,
    drainSeconds: queuePressure.drainSeconds || 0,
    drainHours: roundHours(queuePressure.drainSeconds || 0),
    topFlows: (queuePressure.topFlows || []).slice(0, 4).map((flow) => ({
      flowKey: flow.flowKey,
      label: flow.label,
      account: flow.account || "",
      partition: flow.partition || "",
      partitions: flow.partitions || [],
      count: flow.count || 0,
    })),
    partitions: queuePressure.partitions || [],
    accounts: queuePressure.accounts || [],
  };
}

function reasonMixFor(jobs) {
  const mix = {};
  for (const job of jobs) {
    const category = job.category || classifyReason(job.reason, job.priority).category;
    mix[category] = (mix[category] || 0) + 1;
  }
  return mix;
}

function summarizeJob(job, extra = {}) {
  return {
    jobId: job.jobId,
    name: job.name,
    state: job.state,
    user: job.user,
    account: job.account,
    partition: job.partition,
    category: job.category,
    ...extra,
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
    workdirHref: job.workdir ? `file://${encodeURI(job.workdir)}` : "",
    waitHours: job.waitHours,
    elapsedHours: job.elapsedHours,
    blockerIds: job.blockerIds,
    originParentIds: job.originParentIds,
    parents: parentIds.map((jobId) => jobsById.get(String(jobId))).filter(Boolean).slice(0, 4).map(summarizeParent),
  };
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
  return (job.searchText || "").includes(searchTerm);
}

function matchesGroupSearch(group, searchTerm, matchedJobIds = null) {
  if (!searchTerm) return true;
  if ((group.searchText || "").includes(searchTerm)) return true;
  if (!matchedJobIds || matchedJobIds.size === 0) return false;
  return (group.jobIds || []).some((jobId) => matchedJobIds.has(String(jobId)));
}

function groupSummarySearchText(group) {
  return [
    group.label,
    group.flowKey,
    group.wckey,
    group.workdirRoot,
    ...group.users,
    ...group.accounts,
    ...group.partitions,
    ...group.blockerIds,
    ...group.originParentIds,
  ].join(" ").toLowerCase();
}

function sampleJobsByIds(jobIds, jobsById, limit = INTERNAL_GRAPH_SAMPLE_LIMIT, mapFn = summarizeJob) {
  return jobIds.slice(0, limit).map((jobId) => jobsById.get(String(jobId))).filter(Boolean).map(mapFn);
}

function serializeGroupArtifact(group, jobsById) {
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
    blockerCount: group.blockerIds.length,
    originParentCount: group.originParentIds.length,
    blockers: sampleJobsByIds(group.blockerIds, jobsById),
    originParents: sampleJobsByIds(group.originParentIds, jobsById),
    pendingJobs: sampleJobsByIds(group.pendingJobIds, jobsById),
    runningJobs: sampleJobsByIds(group.runningJobIds, jobsById),
    userLabel: compactList(group.users),
    accountLabel: compactList(group.accounts),
    partitionLabel: compactList(group.partitions),
    isControlPlane: isControlPlaneGroup(group),
    searchText: group.searchText,
    jobIds: [...group.jobIds],
    blockerIds: [...group.blockerIds],
    originParentIds: [...group.originParentIds],
    pendingJobIds: [...group.pendingJobIds],
    runningJobIds: [...group.runningJobIds],
  };
}

function compactArtifactJob(job) {
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
    waitHours: job.waitHours,
    elapsedHours: job.elapsedHours,
    blockerIds: job.blockerIds,
    blockerSource: job.blockerSource,
    originParentIds: job.originParentIds,
    isPending: job.isPending,
    isRunning: job.isRunning,
    isControlPlane: job.isControlPlane,
    searchText: job.searchText,
  };
}

function emptyPersistedJobsPayload(total = 0) {
  return { items: [], total, truncated: true };
}

function hasUsableArtifactJobs(artifact) {
  return Array.isArray(artifact?.jobs?.items) && !artifact?.jobs?.truncated;
}

function persistedSummaryPayload(artifact) {
  return {
    summary: artifact.summary || {},
    details: artifact.details || {},
    filters: artifact.filters || {},
  };
}

function compactPersistedGroup(group) {
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
    blockerCount: group.blockerCount,
    originParentCount: group.originParentCount,
    blockers: group.blockers,
    originParents: group.originParents,
    pendingJobs: group.pendingJobs,
    runningJobs: group.runningJobs,
    userLabel: group.userLabel,
    accountLabel: group.accountLabel,
    partitionLabel: group.partitionLabel,
    isControlPlane: group.isControlPlane,
    searchText: group.searchText,
  };
}

function compactPersistedLogjam(group) {
  return {
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    blockedChildren: group.blockedChildren,
    runningCount: group.runningCount,
    accountLabel: group.accountLabel,
    maxWaitHours: group.maxWaitHours,
    maxElapsedHours: group.maxElapsedHours,
    reasonMix: group.reasonMix,
    blockerCount: group.blockerCount,
    originParentCount: group.originParentCount,
    runningParentCount: group.runningParentCount,
    accountScopes: group.accountScopes || [],
    originParents: group.originParents,
    runningParents: group.runningParents,
    children: group.children,
    externalQueuePressure: group.externalQueuePressure,
    message: group.message,
    isControlPlane: group.isControlPlane,
    searchText: group.searchText,
  };
}

function compactPersistedGraph(graph = {}, { includeSearchText = true, includeAll = true } = {}) {
  const normalizeGroups = (groups = []) => groups.map((group) => {
    const compact = compactPersistedGroup(group);
    if (!includeSearchText) delete compact.searchText;
    return compact;
  });
  const normalizeLogjams = (groups = []) => groups.map((group) => {
    const compact = compactPersistedLogjam(group);
    if (!includeSearchText) delete compact.searchText;
    return compact;
  });
  return {
    all: includeAll ? normalizeGroups(graph.all) : [],
    logjams: normalizeLogjams(graph.logjams),
    control: normalizeGroups(graph.control),
    pending: normalizeGroups(graph.pending),
    running: normalizeGroups(graph.running),
    truncated: false,
  };
}

function emptyPersistedGraphPayload() {
  return {
    all: [],
    logjams: [],
    control: [],
    pending: [],
    running: [],
    truncated: true,
  };
}

function hasUsableArtifactGraph(artifact) {
  return Array.isArray(artifact?.graph?.logjams)
    && Array.isArray(artifact?.graph?.pending)
    && Array.isArray(artifact?.graph?.running)
    && !artifact?.graph?.truncated;
}

function hasSearchableArtifactGraph(artifact) {
  if (!hasUsableArtifactGraph(artifact)) return false;
  const sections = ["all", "logjams", "control", "pending", "running"];
  return sections.every((section) => {
    const groups = artifact?.graph?.[section];
    return !Array.isArray(groups) || groups.length === 0 || Array.isArray(groups[0]?.jobIds);
  });
}

function serializeJobsForCache(jobsPayload, maxChars = DEFAULT_MAX_PERSISTED_JOBS_JSON_CHARS) {
  try {
    const json = JSON.stringify(jobsPayload);
    if (json.length <= maxChars) return json;
    return JSON.stringify(emptyPersistedJobsPayload(jobsPayload?.total || jobsPayload?.items?.length || 0));
  } catch (error) {
    if (error instanceof RangeError) {
      return JSON.stringify(emptyPersistedJobsPayload(jobsPayload?.total || jobsPayload?.items?.length || 0));
    }
    throw error;
  }
}

function serializeGraphForCache(graphPayload, maxChars = DEFAULT_MAX_PERSISTED_GRAPH_JSON_CHARS) {
  const attempts = [
    compactPersistedGraph(graphPayload, { includeAll: true, includeSearchText: true }),
    compactPersistedGraph(graphPayload, { includeAll: false, includeSearchText: true }),
    compactPersistedGraph(graphPayload, { includeAll: false, includeSearchText: false }),
  ];

  for (const payload of attempts) {
    try {
      const json = JSON.stringify(payload);
      if (json.length <= maxChars) return json;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }

  return JSON.stringify(emptyPersistedGraphPayload());
}

function serializeLogjamArtifact(group, jobsById) {
  const parentQueuePressure = new Map((group.parentQueuePressure || []).map((pressure) => [String(pressure.jobId), pressure]));
  const compactParentPressure = (pressure) => ({
    account: pressure?.account || "",
    aheadJobs: pressure?.aheadJobs || 0,
    drainHours: roundHours(pressure?.drainSeconds || 0),
  });
  const summarizeAccountScope = (scope) => ({
    account: scope.account || "",
    blockedChildren: scope.blockedChildren || 0,
    runningCount: scope.runningCount || 0,
    originParentCount: scope.originParentCount || 0,
    runningParentCount: scope.runningParentCount || 0,
    maxWaitHours: scope.maxWaitHours || 0,
    maxElapsedHours: scope.maxElapsedHours || 0,
    reasonMix: scope.reasonMix || {},
    externalQueuePressure: summarizeQueuePressure(scope.externalQueuePressure),
  });
  const summarizeParentWithPressure = (jobId) => {
    const job = jobsById.get(String(jobId));
    if (!job) return null;
    return {
      jobId: job.jobId,
      name: job.name,
      state: job.state,
      account: job.account || "",
      partition: job.partition || "",
      externalQueuePressure: compactParentPressure(parentQueuePressure.get(String(jobId)) || group.externalQueuePressure),
    };
  };
  return {
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    blockedChildren: group.pendingCount,
    runningCount: group.runningCount,
    accountLabel: compactList(group.accounts),
    maxWaitHours: group.maxWaitHours,
    maxElapsedHours: group.maxElapsedHours,
    reasonMix: group.reasonMix,
    blockerCount: group.blockerIds.length,
    originParentCount: group.originParentIds.length,
    runningParentCount: group.runningJobIds.length,
    accountScopes: (group.accountScopes || []).map(summarizeAccountScope),
    originParents: group.originParentIds.slice(0, INTERNAL_GRAPH_SAMPLE_LIMIT).map(summarizeParentWithPressure).filter(Boolean),
    runningParents: group.runningJobIds.slice(0, INTERNAL_GRAPH_SAMPLE_LIMIT).map(summarizeParentWithPressure).filter(Boolean),
    children: sampleJobsByIds(group.pendingJobIds, jobsById),
    externalQueuePressure: summarizeQueuePressure(group.externalQueuePressure),
    message: group.externalQueuePressure?.aheadJobs
      ? `Flow ${group.label} has ${group.runningCount} active parent run(s), ${group.pendingCount} pending child job(s), and ${group.externalQueuePressure.aheadJobs} higher-priority same-account job(s) from other flows ahead in queue.`
      : `Flow ${group.label} has ${group.runningCount} active parent run(s) with ${group.pendingCount} pending child job(s).`,
    isControlPlane: isControlPlaneGroup(group),
    searchText: group.searchText,
    jobIds: [...group.jobIds],
    blockerIds: [...group.blockerIds],
    originParentIds: [...group.originParentIds],
    pendingJobIds: [...group.pendingJobIds],
    runningJobIds: [...group.runningJobIds],
  };
}

function toPublicGroup(group, options = {}) {
  const normalized = typeof options === "number" ? { sampleLimit: options } : options;
  const sampleLimit = normalized.sampleLimit ?? DEFAULT_GRAPH_SAMPLE_LIMIT;
  const mode = normalized.mode || "full";

  const base = {
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
    isControlPlane: group.isControlPlane,
  };

  if (mode === "running") {
    return {
      ...base,
      originParentCount: group.originParentCount,
      originParents: group.originParents.slice(0, sampleLimit),
      runningJobs: group.runningJobs.slice(0, sampleLimit),
      userLabel: group.userLabel,
    };
  }

  if (mode === "pending") {
    return {
      ...base,
      reasonMix: group.reasonMix,
      blockerSource: group.blockerSource,
      blockerCount: group.blockerCount,
      originParentCount: group.originParentCount,
      blockers: group.blockers.slice(0, sampleLimit),
      originParents: group.originParents.slice(0, sampleLimit),
      pendingJobs: group.pendingJobs.slice(0, sampleLimit),
      userLabel: group.userLabel,
      accountLabel: group.accountLabel,
      partitionLabel: group.partitionLabel,
    };
  }

  if (mode === "control") {
    return {
      ...base,
      reasonMix: group.reasonMix,
      originParentCount: group.originParentCount,
      originParents: group.originParents.slice(0, sampleLimit),
      pendingJobs: group.pendingJobs.slice(0, sampleLimit),
      runningJobs: group.runningJobs.slice(0, sampleLimit),
    };
  }

  return {
    ...base,
    reasonMix: group.reasonMix,
    blockerSource: group.blockerSource,
    blockerCount: group.blockerCount,
    originParentCount: group.originParentCount,
    blockers: group.blockers.slice(0, sampleLimit),
    originParents: group.originParents.slice(0, sampleLimit),
    pendingJobs: group.pendingJobs.slice(0, sampleLimit),
    runningJobs: group.runningJobs.slice(0, sampleLimit),
    userLabel: group.userLabel,
    accountLabel: group.accountLabel,
    partitionLabel: group.partitionLabel,
  };
}

function toPublicLogjam(group, sampleLimit = DEFAULT_GRAPH_SAMPLE_LIMIT) {
  return {
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    blockedChildren: group.blockedChildren,
    runningCount: group.runningCount,
    accountLabel: group.accountLabel,
    maxWaitHours: group.maxWaitHours,
    maxElapsedHours: group.maxElapsedHours,
    reasonMix: group.reasonMix,
    blockerCount: group.blockerCount,
    originParentCount: group.originParentCount,
    runningParentCount: group.runningParentCount,
    accountScopes: (group.accountScopes || []).map((scope) => ({
      account: scope.account,
      blockedChildren: scope.blockedChildren,
      runningCount: scope.runningCount,
      originParentCount: scope.originParentCount,
      runningParentCount: scope.runningParentCount,
      maxWaitHours: scope.maxWaitHours,
      maxElapsedHours: scope.maxElapsedHours,
      reasonMix: scope.reasonMix,
      externalQueuePressure: scope.externalQueuePressure,
    })),
    originParents: group.originParents.slice(0, sampleLimit),
    runningParents: group.runningParents.slice(0, sampleLimit),
    children: group.children.slice(0, sampleLimit),
    externalQueuePressure: group.externalQueuePressure,
    message: group.message,
    isControlPlane: group.isControlPlane,
  };
}

function diagnosticsSummary(annotatedJobs, flowGroups, logjams, controlGroups) {
  const pendingJobs = annotatedJobs.filter((job) => job.isPending);
  const runningJobs = annotatedJobs.filter((job) => job.isRunning);
  return {
    totalJobs: annotatedJobs.length,
    pendingCount: pendingJobs.length,
    runningCount: runningJobs.length,
    logjamCount: logjams.length,
    uniqueFlows: flowGroups.length,
    controlPlaneFlows: controlGroups.length,
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

function toArtifactCacheKey(cluster, snapshotId, version = DIAGNOSTICS_ARTIFACT_VERSION) {
  return `${cluster}:${snapshotId}:${version}`;
}

function getHotArtifact(cacheKey) {
  if (!hotArtifacts.has(cacheKey)) return null;
  const value = hotArtifacts.get(cacheKey);
  hotArtifacts.delete(cacheKey);
  hotArtifacts.set(cacheKey, value);
  return value;
}

function setHotArtifact(cacheKey, artifact) {
  hotArtifacts.delete(cacheKey);
  hotArtifacts.set(cacheKey, artifact);
  while (hotArtifacts.size > HOT_ARTIFACT_LIMIT) {
    const oldest = hotArtifacts.keys().next().value;
    hotArtifacts.delete(oldest);
  }
}

function hydrateArtifactFromRow(row) {
  try {
    const summaryPayload = JSON.parse(row.summary_json || "{}");
    return {
      version: String(row.version),
      builtAt: Number(row.built_at) || Math.floor(Date.now() / 1000),
      summary: summaryPayload.summary || summaryPayload,
      details: summaryPayload.details || {},
      filters: summaryPayload.filters || {},
      graph: JSON.parse(row.graph_json || "{}"),
      jobs: JSON.parse(row.jobs_json || "{}"),
    };
  } catch {
    return null;
  }
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
      searchText: "",
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
      job.searchText = searchTextForJob(job);
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
  const byLane = new Map();

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
    const laneKey = queueLaneKey(job.partition, job.account);
    if (!byLane.has(laneKey)) {
      byLane.set(laneKey, {
        partition: job.partition || "",
        account: job.account || "",
        pending: [],
        running: [],
      });
    }
    const lane = byLane.get(laneKey);
    if (job.isPending) lane.pending.push(job);
    if (job.isRunning) lane.running.push(job);
  }

  return [...grouped.values()].map((group) => {
    const jobs = group.jobIds.map((jobId) => byId.get(String(jobId))).filter(Boolean);
    const pendingJobs = jobs.filter((job) => job.isPending).sort(byPendingAge);
    const runningJobs = jobs.filter((job) => job.isRunning).sort(byElapsedAge);
    const blockerIds = uniq(pendingJobs.flatMap((job) => job.blockerIds));
    const originParentIds = uniq(jobs.flatMap((job) => job.originParentIds));
    const pendingHours = pendingJobs.map((job) => job.waitHours);
    const elapsedHours = runningJobs.map((job) => job.elapsedHours);
    const pendingLaneKeys = [...new Set(pendingJobs.map((job) => queueLaneKey(job.partition, job.account)))];
    const laneQueuePressure = pendingLaneKeys
      .map((laneKey) => {
        const lane = byLane.get(laneKey) || { partition: "", account: "", pending: [], running: [] };
        const lanePending = pendingJobs.filter((job) => queueLaneKey(job.partition, job.account) === laneKey);
        const minPriority = Math.min(...lanePending.map((job) => Number(job.priority) || 0));
        const aheadJobs = lane.pending.filter((job) => flowIdentity(job) !== group.flowKey && (Number(job.priority) || 0) > minPriority);
        const servicePool = lane.running;
        const drainSliceSeconds = mean(servicePool.map(estimateDrainSliceSeconds));
        const topFlows = countAheadFlows(aheadJobs);
        return {
          partition: lane.partition,
          account: lane.account,
          aheadJobs: aheadJobs.length,
          aheadJobIds: aheadJobs.map((job) => job.jobId),
          externalFlows: topFlows.length,
          drainSeconds: aheadJobs.length && drainSliceSeconds
            ? Math.round((aheadJobs.length / Math.max(1, servicePool.length || 1)) * drainSliceSeconds)
            : 0,
          topFlows,
        };
      })
      .sort((a, b) => b.aheadJobs - a.aheadJobs || b.drainSeconds - a.drainSeconds);
    const scopedAccounts = [...new Set(jobs.map((job) => job.account || ""))];
    const accountScopes = scopedAccounts.map((account) => {
      const accountPendingJobs = pendingJobs.filter((job) => (job.account || "") === account);
      const accountRunningJobs = runningJobs.filter((job) => (job.account || "") === account);
      const accountJobs = jobs.filter((job) => (job.account || "") === account);
      const accountOriginParentIds = uniq(accountJobs.flatMap((job) => job.originParentIds))
        .filter((jobId) => (byId.get(String(jobId))?.account || "") === account);
      const accountPressures = laneQueuePressure.filter((pressure) => (pressure.account || "") === account);
      return {
        account,
        blockedChildren: accountPendingJobs.length,
        pendingCount: accountPendingJobs.length,
        runningCount: accountRunningJobs.length,
        originParentCount: accountOriginParentIds.length,
        runningParentCount: accountRunningJobs.length,
        maxWaitHours: accountPendingJobs.length ? Math.max(...accountPendingJobs.map((job) => job.waitHours)) : 0,
        avgWaitHours: avg(accountPendingJobs.map((job) => job.waitHours)),
        maxElapsedHours: accountRunningJobs.length ? Math.max(...accountRunningJobs.map((job) => job.elapsedHours)) : 0,
        avgElapsedHours: avg(accountRunningJobs.map((job) => job.elapsedHours)),
        reasonMix: reasonMixFor(accountPendingJobs.length ? accountPendingJobs : accountJobs),
        partitions: uniq(jobs.filter((job) => (job.account || "") === account).map((job) => job.partition)).sort(),
        externalQueuePressure: combineQueuePressure(accountPressures, byId, { account }),
      };
    }).sort((a, b) => b.blockedChildren - a.blockedChildren || b.maxWaitHours - a.maxWaitHours || a.account.localeCompare(b.account));
    const externalQueuePressure = combineQueuePressure(laneQueuePressure, byId);
    const accountPressureByAccount = new Map(accountScopes.map((scope) => [scope.account || "", scope.externalQueuePressure]));
    const lanePressureByKey = new Map(laneQueuePressure.map((pressure) => [queueLaneKey(pressure.partition, pressure.account), pressure]));
    const parentQueuePressure = uniq([...originParentIds, ...group.runningJobIds])
      .map((jobId) => byId.get(String(jobId)))
      .filter(Boolean)
      .map((job) => {
        const partitionPressure = lanePressureByKey.get(queueLaneKey(job.partition, job.account));
        const accountPressure = accountPressureByAccount.get(job.account || "");
        const queuePressure = partitionPressure || accountPressure || externalQueuePressure;
        return {
          jobId: job.jobId,
          ...queuePressure,
          partition: queuePressure.partition || job.partition || "",
          account: queuePressure.account || job.account || "",
        };
      });
    const materialized = {
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
      blockerSource: pendingJobs.find((job) => job.blockerSource && job.blockerSource !== "none")?.blockerSource || "none",
      originParentIds,
      jobIds: group.jobIds,
      pendingJobIds: group.pendingJobIds,
      runningJobIds: group.runningJobIds,
      accountScopes,
      externalQueuePressure,
      parentQueuePressure,
      users: [...group.users].sort(),
      accounts: [...group.accounts].sort(),
      partitions: [...group.partitions].sort(),
    };
    materialized.searchText = groupSummarySearchText(materialized);
    return materialized;
  }).sort(byCount);
}

export function buildDiagnosticsArtifact(jobs, opts = {}) {
  const builtAt = opts.builtAt || Math.floor(Date.now() / 1000);
  const annotatedJobs = annotateJobs(jobs);
  const jobsById = new Map(annotatedJobs.map((job) => [String(job.jobId), job]));
  const flowGroups = buildFlowGroups(annotatedJobs);
  const controlGroups = flowGroups.filter((group) => isControlPlaneGroup(group));
  const controlFlowKeys = new Set(controlGroups.map((group) => group.flowKey));
  const indexedJobs = annotatedJobs.map((job) => ({ ...job, isControlPlane: controlFlowKeys.has(job.flowKey || `job:${job.jobId}`) }));
  const indexedById = new Map(indexedJobs.map((job) => [String(job.jobId), job]));

  const standardGroups = flowGroups.filter((group) => !controlFlowKeys.has(group.flowKey));
  const logjamGroups = standardGroups
    .filter((group) => group.runningCount > 0 && group.pendingCount > 0)
    .sort((a, b) => b.pendingCount - a.pendingCount || b.maxWaitHours - a.maxWaitHours);

  const pendingGroups = standardGroups
    .filter((group) => group.pendingCount > 0)
    .sort((a, b) => b.maxWaitHours - a.maxWaitHours || b.pendingCount - a.pendingCount);
  const runningGroups = standardGroups
    .filter((group) => group.runningCount > 0)
    .sort((a, b) => b.runningCount - a.runningCount || b.maxElapsedHours - a.maxElapsedHours);

  const graph = {
    all: flowGroups.map((group) => serializeGroupArtifact(group, indexedById)),
    logjams: logjamGroups.map((group) => serializeLogjamArtifact(group, indexedById)),
    control: controlGroups.map((group) => serializeGroupArtifact(group, indexedById)),
    pending: pendingGroups.map((group) => serializeGroupArtifact(group, indexedById)),
    running: runningGroups.map((group) => serializeGroupArtifact(group, indexedById)),
  };

  const pendingJobs = indexedJobs.filter((job) => job.isPending && !job.isControlPlane);
  const runningJobs = indexedJobs.filter((job) => job.isRunning && !job.isControlPlane);
  const controlJobs = indexedJobs.filter((job) => job.isControlPlane);

  const summary = diagnosticsSummary(indexedJobs, flowGroups, logjamGroups, controlGroups);
  summary.blockedRunnersByAccount = summarizeBlockedRunnerJobs(indexedJobs);
  const details = {
    control: {
      count: controlJobs.length,
      groupedFlows: controlGroups.length,
      maxWaitHours: controlJobs.length ? Math.max(...controlJobs.map((job) => job.waitHours)) : 0,
      maxElapsedHours: controlJobs.length ? Math.max(...controlJobs.map((job) => job.elapsedHours)) : 0,
    },
    pending: pageSummary(graph.pending, pendingJobs, "pending"),
    running: pageSummary(graph.running, runningJobs, "running"),
  };
  const filters = {
    wckeys: uniq(indexedJobs.map((job) => job.wckey)).sort(),
    users: uniq(indexedJobs.map((job) => job.user)).sort(),
    accounts: uniq(indexedJobs.map((job) => job.account)).sort(),
    partitions: uniq(indexedJobs.map((job) => job.partition)).sort(),
  };
  const jobIndex = indexedJobs.map(compactArtifactJob);

  return {
    version: DIAGNOSTICS_ARTIFACT_VERSION,
    builtAt,
    summary,
    details,
    filters,
    graph,
    jobs: { items: jobIndex, total: jobIndex.length, truncated: false },
  };
}

export async function getOrBuildDiagnosticsArtifact({
  db,
  cluster,
  snapshot,
  jobs,
  loadJobs,
  requireJobs = false,
  requireGraph = false,
  requireSearchableGraph = false,
  maxPersistedGraphJsonChars = DEFAULT_MAX_PERSISTED_GRAPH_JSON_CHARS,
  maxPersistedJobsJsonChars = DEFAULT_MAX_PERSISTED_JOBS_JSON_CHARS,
}) {
  const resolveJobs = async () => {
    if (Array.isArray(jobs)) return jobs;
    if (typeof loadJobs === "function") return loadJobs();
    return [];
  };

  if (!snapshot?.id) return buildDiagnosticsArtifact(await resolveJobs());
  const cacheKey = toArtifactCacheKey(cluster, snapshot.id, DIAGNOSTICS_ARTIFACT_VERSION);
  const hot = getHotArtifact(cacheKey);
  if (hot
    && (!requireJobs || hasUsableArtifactJobs(hot))
    && (!requireGraph || hasUsableArtifactGraph(hot))
    && (!requireSearchableGraph || hasSearchableArtifactGraph(hot))
  ) return hot;

  const persisted = readDiagnosticsCache(db, cluster);
  if (persisted
    && Number(persisted.snapshot_id) === Number(snapshot.id)
    && String(persisted.version) === String(DIAGNOSTICS_ARTIFACT_VERSION)
  ) {
    const artifact = hydrateArtifactFromRow(persisted);
    if (artifact
      && (!requireJobs || hasUsableArtifactJobs(artifact))
      && (!requireGraph || hasUsableArtifactGraph(artifact))
      && (!requireSearchableGraph || hasSearchableArtifactGraph(artifact))
    ) {
      setHotArtifact(cacheKey, artifact);
      return artifact;
    }
  }

  if (inflightArtifacts.has(cacheKey)) return inflightArtifacts.get(cacheKey);
  const building = Promise.resolve().then(() => {
    return resolveJobs().then((sourceJobs) => buildDiagnosticsArtifact(sourceJobs));
  }).then((artifact) => {
    writeDiagnosticsCache(db, {
      cluster,
      snapshotId: Number(snapshot.id),
      version: artifact.version,
      builtAt: artifact.builtAt,
      summaryJson: JSON.stringify(persistedSummaryPayload(artifact)),
      graphJson: serializeGraphForCache(artifact.graph, maxPersistedGraphJsonChars),
      jobsJson: serializeJobsForCache(artifact.jobs, maxPersistedJobsJsonChars),
    });
    setHotArtifact(cacheKey, artifact);
    return artifact;
  }).finally(() => inflightArtifacts.delete(cacheKey));
  inflightArtifacts.set(cacheKey, building);
  return building;
}

export function renderDiagnosticsResponse(artifact, options = {}) {
  const section = options.section || "summary";
  const view = options.view || "graph";
  const searchTerm = String(options.search || "").trim().toLowerCase();
  const jobLimit = clampInt(options.jobLimit, DEFAULT_JOB_LIMIT, MAX_JOB_LIMIT);
  const jobOffset = clampInt(options.jobOffset, 0, 1000000);
  const sampleLimit = clampInt(options.sampleLimit, DEFAULT_GRAPH_SAMPLE_LIMIT, INTERNAL_GRAPH_SAMPLE_LIMIT);

  const jobs = artifact.jobs?.items || [];
  const jobsById = new Map(jobs.map((job) => [String(job.jobId), job]));
  const matchedJobIds = searchTerm
    ? new Set(jobs.filter((job) => matchesJobSearch(job, searchTerm)).map((job) => String(job.jobId)))
    : null;
  const groupMatches = (group) => matchesGroupSearch(group, searchTerm, matchedJobIds);

  if (section === "summary") return { summary: artifact.summary };

  if (section === "logjams") {
    const filtered = (artifact.graph?.logjams || []).filter(groupMatches);
    return {
      summary: artifact.summary,
      data: {
        kind: "groups",
        total: filtered.length,
        shown: filtered.length,
        limit: null,
        items: filtered.map((group) => toPublicLogjam(group, sampleLimit)),
      },
    };
  }

  if (section === "control") {
    const filtered = (artifact.graph?.control || []).filter(groupMatches);
    const flowKeys = new Set(filtered.map((group) => group.flowKey));
    const detailJobs = jobs.filter((job) => job.isControlPlane && flowKeys.has(job.flowKey || `job:${job.jobId}`));
    const details = searchTerm ? {
      count: detailJobs.length,
      groupedFlows: filtered.length,
      maxWaitHours: detailJobs.length ? Math.max(...detailJobs.map((job) => job.waitHours)) : 0,
      maxElapsedHours: detailJobs.length ? Math.max(...detailJobs.map((job) => job.elapsedHours)) : 0,
    } : (artifact.details?.control || {
      count: detailJobs.length,
      groupedFlows: filtered.length,
      maxWaitHours: 0,
      maxElapsedHours: 0,
    });
    return {
      summary: artifact.summary,
      details,
      data: {
        kind: "groups",
        total: filtered.length,
        shown: filtered.length,
        limit: null,
        items: filtered.map((group) => toPublicGroup(group, { mode: "control", sampleLimit })),
      },
    };
  }

  if (section === "pending" || section === "running") {
    const mode = section;
    const graphGroups = mode === "pending" ? (artifact.graph?.pending || []) : (artifact.graph?.running || []);
    const filteredGroups = graphGroups.filter(groupMatches);
    const filteredJobs = jobs.filter((job) =>
      !job.isControlPlane &&
      (mode === "pending" ? job.isPending : job.isRunning) &&
      matchesJobSearch(job, searchTerm)
    );
    const details = searchTerm
      ? pageSummary(filteredGroups, filteredJobs, mode)
      : (artifact.details?.[mode] || pageSummary(filteredGroups, filteredJobs, mode));

    if (view === "list") {
      const sortedJobs = [...filteredJobs].sort(mode === "pending" ? byPendingAge : byElapsedAge);
      return {
        summary: artifact.summary,
        details,
        data: {
          kind: "jobs",
          total: sortedJobs.length,
          offset: jobOffset,
          limit: jobLimit,
          items: sortedJobs.slice(jobOffset, jobOffset + jobLimit).map((job) => detailedJob(job, jobsById)),
        },
      };
    }

    return {
      summary: artifact.summary,
      details,
      data: {
        kind: "groups",
        total: filteredGroups.length,
        shown: filteredGroups.length,
        limit: null,
        items: filteredGroups.map((group) => toPublicGroup(group, { mode, sampleLimit })),
      },
    };
  }

  return buildDiagnosticsDataset(jobs);
}

export function buildDiagnosticsView(jobs, options = {}) {
  const artifact = buildDiagnosticsArtifact(jobs);
  return renderDiagnosticsResponse(artifact, options);
}

// Fan-out logjam: running parents with pending jobs in the same flow.
export function detectFanoutLogjam(jobs) {
  const artifact = buildDiagnosticsArtifact(jobs);
  return (artifact.graph?.logjams || [])
    .map((group) => ({
      type: "fanout_logjam",
      flowKey: group.flowKey,
      parentJobId: group.runningJobIds[0],
      parentJobIds: group.runningJobIds,
      originParentIds: group.originParentIds,
      blockedChildren: group.blockedChildren,
      reasonMix: group.reasonMix,
      message: group.message,
      childJobIds: group.pendingJobIds,
      blockers: group.blockers,
      originParents: group.originParents,
      maxWaitHours: group.maxWaitHours,
    }))
    .sort((a, b) => b.blockedChildren - a.blockedChildren || b.maxWaitHours - a.maxWaitHours);
}

export function buildDiagnosticsDataset(jobs) {
  const artifact = buildDiagnosticsArtifact(jobs);
  const pendingJobs = artifact.jobs.items.filter((job) => job.isPending && !job.isControlPlane);
  const runningJobs = artifact.jobs.items.filter((job) => job.isRunning && !job.isControlPlane);
  const logjamItems = (artifact.graph.logjams || []).map((group) => toPublicLogjam(group, INTERNAL_GRAPH_SAMPLE_LIMIT));
  return {
    summary: artifact.summary,
    jobs: artifact.jobs.items,
    flows: (artifact.graph.all || []).map((group) => ({
      ...toPublicGroup(group, INTERNAL_GRAPH_SAMPLE_LIMIT),
      blockerIds: group.blockerIds,
      originParentIds: group.originParentIds,
      pendingJobIds: group.pendingJobIds,
      runningJobIds: group.runningJobIds,
    })),
    logjams: {
      summary: {
        count: logjamItems.length,
        blockedChildren: logjamItems.reduce((sum, item) => sum + (item.blockedChildren || 0), 0),
      },
      items: logjamItems,
    },
    pending: {
      summary: pageSummary(artifact.graph.pending || [], pendingJobs, "pending"),
      groups: (artifact.graph.pending || []).map((group) => ({
        ...toPublicGroup(group, INTERNAL_GRAPH_SAMPLE_LIMIT),
        blockerIds: group.blockerIds,
        originParentIds: group.originParentIds,
        pendingJobIds: group.pendingJobIds,
        runningJobIds: group.runningJobIds,
      })),
    },
    running: {
      summary: pageSummary(artifact.graph.running || [], runningJobs, "running"),
      groups: (artifact.graph.running || []).map((group) => ({
        ...toPublicGroup(group, INTERNAL_GRAPH_SAMPLE_LIMIT),
        blockerIds: group.blockerIds,
        originParentIds: group.originParentIds,
        pendingJobIds: group.pendingJobIds,
        runningJobIds: group.runningJobIds,
      })),
    },
    filters: artifact.filters,
  };
}

export function resetDiagnosticsArtifactCacheForTest() {
  hotArtifacts.clear();
  inflightArtifacts.clear();
}
