import React, { startTransition, useDeferredValue, useEffect, useState } from "react";
import { api } from "./api.js";
import { FlowGraph } from "./FlowGraph.jsx";
import {
  readUrlFilters,
  resolveLogjamAccountSelection,
  resolveSectionSearch,
  syncUrlFilters,
} from "./page-state.js";

const PAGE_META = {
  pressure: { label: "Pressure", kicker: "Queue posture", title: "Cluster pressure by account and partition" },
  logjams: { label: "Logjams", kicker: "True blockers", title: "Trace the flows where running parents are holding pending work behind them" },
  control: { label: "Control Plane", kicker: "Orchestration", title: "Separate the /root and (null) orchestration flows from normal verification traffic" },
  pending: { label: "Pending", kicker: "Waiting traffic", title: "Search and inspect pending jobs without loading the entire farm into the browser" },
  running: { label: "Running", kicker: "Active traffic", title: "Inspect currently running flows with aggregated graph and paged list views" },
  watchlist: { label: "Watchlist", kicker: "Jobs of interest", title: "Track saved job matchers with ETA and diagnosis context" },
};

const PAGE_ORDER = ["pressure", "logjams", "control", "pending", "running", "watchlist"];
const LIST_JOB_LIMIT = 200;
const HERO_SUMMARY_ITEMS = [
  { key: "pending", label: "Pending" },
  { key: "running", label: "Running" },
  { key: "logjams", label: "Logjams" },
  { key: "flows", label: "Flows" },
];
const REASON_COLORS = {
  priority: "#0f766e",
  resources: "#b45309",
  licenses: "#b91c1c",
  dependency: "#1d4ed8",
  qos: "#5b21b6",
  partition: "#334155",
  association: "#7c2d12",
  reservation: "#0f766e",
  node_unavail: "#475569",
  held: "#111827",
  other: "#64748b",
};
const REASON_HELP = {
  priority: "Priority means the jobs are queued behind higher-priority work in the same scheduling lane.",
  resources: "Resources means the jobs are waiting for CPUs, memory, nodes, or another partition capacity constraint.",
  licenses: "Licenses means the jobs are blocked on a checked-out license feature before they can start.",
  dependency: "Dependency means the jobs are waiting for an upstream Slurm dependency to complete.",
  qos: "QoS means a quality-of-service limit is gating dispatch.",
  partition: "Partition means the requested partition cannot dispatch the job under current limits or availability.",
  association: "Association means a Slurm account, user, or association limit is blocking dispatch.",
  reservation: "Reservation means the jobs are tied to a reservation window or reservation conflict.",
  node_unavail: "Node unavailable means the requested nodes are down, drained, or otherwise unavailable.",
  held: "Held means the jobs have zero effective priority or were explicitly held/requeued.",
  other: "Other covers pending reasons that do not map cleanly into the main queue categories.",
};
const ACCOUNT_PRESSURE_HEADERS = [
  { key: "account", label: "Account", help: "The Slurm account used for fairshare and scheduling isolation." },
  { key: "blockedRunners", label: "Blocked Runners", help: "Blocked Runners = active parent runs in this account that still have pending child work and no active dispatched runner jobs, shown as blocked of total active parent runs." },
  { key: "pending", label: "Pending", help: "Count of pending jobs currently queued in this account." },
  { key: "running", label: "Running", help: "Count of running jobs currently active in this account." },
  { key: "ratio", label: "Ratio", help: "Queue ratio = pending jobs divided by running jobs. If running is zero, the raw pending count is shown." },
  { key: "dominantReason", label: "Dominant Reason", help: "The most common pending reason category among the account's queued jobs." },
  { key: "licenseBound", label: "License-Bound", help: "Pending jobs currently blocked by license availability." },
  { key: "oldestPending", label: "Oldest Pending", help: "The oldest queued wait time among pending jobs in this account." },
];
const PARTITION_PRESSURE_HEADERS = [
  { key: "partition", label: "Partition", help: "The Slurm partition where the jobs are queued or running." },
  { key: "pending", label: "Pending", help: "Count of pending jobs currently queued in this partition." },
  { key: "running", label: "Running", help: "Count of running jobs currently active in this partition." },
  { key: "ratio", label: "Ratio", help: "Queue ratio = pending jobs divided by running jobs. If running is zero, the raw pending count is shown." },
  { key: "dominantReason", label: "Dominant Reason", help: "The most common pending reason category among the partition's queued jobs." },
  { key: "licenseBound", label: "License-Bound", help: "Pending jobs currently blocked by license availability in this partition." },
  { key: "oldestPending", label: "Oldest Pending", help: "The oldest queued wait time among pending jobs in this partition." },
];

const readPage = () => {
  if (typeof window === "undefined") return "pressure";
  const hash = window.location.hash.replace(/^#/, "");
  return PAGE_META[hash] ? hash : "pressure";
};

const fmtCompactDuration = (seconds) => {
  const total = Math.max(0, Math.round(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

const fmtHours = (hours) => `${Number(hours || 0).toFixed(hours >= 10 ? 0 : 1)}h`;
const fmtRatio = (value) => Number(value || 0).toFixed(2);
const text = (value) => String(value || "").trim();
const wckeyLabel = (value) => text(value) || "No WCKey";
const accountLabel = (value) => text(value) || "No account";
const TIMELINE_WINDOWS = [2, 4, 6, 12, 24, 48, 72];

function groupJobsByFlow(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.flowKey || job.wckey || job.workdirRoot || `job:${job.jobId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: wckeyLabel(items[0]?.wckey || items[0]?.flowKey || items[0]?.workdirRoot),
    items: [...items].sort((a, b) => (b.waitHours || b.elapsedHours || 0) - (a.waitHours || a.elapsedHours || 0)),
  })).sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

function flowAnchorId(index) {
  return `logjam-flow-${index}`;
}

function jumpToFlow(anchorId) {
  if (typeof document === "undefined") return;
  document.getElementById(anchorId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fmtTimelineOffset(hours) {
  if (!hours) return "Now";
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${fmtCompactDuration(Math.abs(hours) * 3600)}`;
}

function timelineWindow(hours, cap = 72, fallback = 6) {
  const safe = Math.max(0, Number(hours) || 0);
  const capped = Math.min(safe, cap);
  return TIMELINE_WINDOWS.find((value) => value >= capped) || fallback;
}

function timelinePosition(hours, pastWindowHours, futureWindowHours) {
  const min = -pastWindowHours;
  const max = futureWindowHours;
  const clamped = Math.min(max, Math.max(min, hours));
  return ((clamped - min) / (max - min)) * 100;
}

function timelineBubbleSize(count) {
  return Math.max(11, Math.min(28, Math.round(8 + Math.sqrt(Math.max(1, count || 1)) * 1.55)));
}

function queuePressureWaitHours(queuePressure) {
  return Math.max(0, Number(queuePressure?.drainHours) || 0);
}

function shortFlowLabel(value, max = 58) {
  const label = wckeyLabel(value);
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

function compactTextList(values, limit = 2) {
  const items = [...new Set((values || []).map((value) => text(value)).filter(Boolean))];
  if (items.length <= limit) return items.join(", ");
  return `${items.slice(0, limit).join(", ")} +${items.length - limit}`;
}

function summarizeVictimPreview(group) {
  const blockers = group.externalQueuePressure?.topFlows || [];
  if (!blockers.length) return "No dominant external blocker flow sampled";
  const [first, second] = blockers;
  const firstLabel = `${shortFlowLabel(first.label, 32)} (${first.count})`;
  if (!second) return firstLabel;
  return `${firstLabel} and ${shortFlowLabel(second.label, 26)} (${second.count})`;
}

function summarizeBlockerImpact(blocker) {
  const partitions = compactTextList(blocker.partitions, 2);
  return [
    `${blocker.blockingJobs} ahead`,
    `${blocker.affectedFlows} victim flow${blocker.affectedFlows === 1 ? "" : "s"}`,
    partitions,
  ].filter(Boolean).join(" · ");
}

function logjamAccountScopes(group) {
  const scopes = Array.isArray(group.accountScopes) && group.accountScopes.length
    ? group.accountScopes
    : [{
      account: text(group.accountLabel),
      blockedChildren: group.blockedChildren,
      runningCount: group.runningCount,
      runningParentCount: group.runningParentCount || group.runningCount,
      maxWaitHours: group.maxWaitHours,
      maxElapsedHours: group.maxElapsedHours,
      externalQueuePressure: group.externalQueuePressure,
    }];
  return scopes.map((scope) => ({
    account: text(scope.account),
    accountName: accountLabel(scope.account || group.accountLabel),
    flowKey: group.flowKey,
    label: group.label,
    wckey: group.wckey,
    workdirRoot: group.workdirRoot,
    anchorId: group.anchorId,
    blockedChildren: scope.blockedChildren ?? group.blockedChildren ?? 0,
    runningCount: scope.runningCount ?? group.runningCount ?? 0,
    originParentCount: scope.originParentCount ?? group.originParentCount ?? 0,
    runningParents: scope.runningParentCount ?? scope.runningCount ?? group.runningParentCount ?? group.runningCount ?? 0,
    maxWaitHours: scope.maxWaitHours ?? group.maxWaitHours ?? 0,
    maxElapsedHours: scope.maxElapsedHours ?? group.maxElapsedHours ?? 0,
    reasonMix: scope.reasonMix || group.reasonMix,
    launchHours: Math.max(0, Number(scope.maxElapsedHours ?? group.maxElapsedHours) || 0),
    projectedWaitHours: queuePressureWaitHours(scope.externalQueuePressure || group.externalQueuePressure),
    externalQueuePressure: scope.externalQueuePressure || group.externalQueuePressure,
  }));
}

function buildLogjamOverview(groups) {
  const victimScopes = groups.flatMap(logjamAccountScopes);
  const scopeByKey = new Map(victimScopes.map((scope) => [`${scope.account}::${scope.flowKey}`, scope]));
  const byAccount = new Map();

  for (const scope of victimScopes) {
    const key = scope.account || "";
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        account: key,
        label: scope.accountName,
        blockedChildren: 0,
        runningParents: 0,
        maxProjectedWait: 0,
        maxLaunchAge: 0,
        victims: [],
        blockerMap: new Map(),
      });
    }

    const accountEntry = byAccount.get(key);
    accountEntry.victims.push(scope);
    accountEntry.blockedChildren += scope.blockedChildren || 0;
    accountEntry.runningParents += scope.runningParents || 0;
    accountEntry.maxProjectedWait = Math.max(accountEntry.maxProjectedWait, scope.projectedWaitHours || 0);
    accountEntry.maxLaunchAge = Math.max(accountEntry.maxLaunchAge, scope.launchHours || 0);

    for (const flow of scope.externalQueuePressure?.topFlows || []) {
      const blockerAccount = text(flow.account) || key;
      if (blockerAccount !== key) continue;
      const blockerKey = `${blockerAccount}::${flow.flowKey || flow.label}`;
      const linkedScope = scopeByKey.get(blockerKey);
      if (!accountEntry.blockerMap.has(blockerKey)) {
        accountEntry.blockerMap.set(blockerKey, {
          key: blockerKey,
          account: blockerAccount,
          accountName: accountEntry.label,
          label: flow.label,
          flowKey: flow.flowKey || flow.label,
          anchorId: linkedScope?.anchorId || "",
          blockingJobs: 0,
          affectedFlows: 0,
          projectedWaitHours: 0,
          launchHours: linkedScope?.launchHours || 0,
          runningParents: linkedScope?.runningParents || 0,
          blockedChildren: linkedScope?.blockedChildren || 0,
          partitions: new Set(linkedScope?.externalQueuePressure?.partitions || []),
        });
      }
      const blocker = accountEntry.blockerMap.get(blockerKey);
      blocker.blockingJobs += flow.count || 0;
      blocker.affectedFlows += 1;
      blocker.projectedWaitHours = Math.max(blocker.projectedWaitHours, scope.projectedWaitHours || 0);
      if (linkedScope) {
        blocker.anchorId = blocker.anchorId || linkedScope.anchorId || "";
        blocker.launchHours = Math.max(blocker.launchHours, linkedScope.launchHours || 0);
        blocker.runningParents = Math.max(blocker.runningParents, linkedScope.runningParents || 0);
        blocker.blockedChildren = Math.max(blocker.blockedChildren, linkedScope.blockedChildren || 0);
      }
      if (flow.partition) blocker.partitions.add(flow.partition);
      for (const partition of flow.partitions || []) blocker.partitions.add(partition);
    }
  }

  const accounts = [...byAccount.values()]
    .map((accountEntry) => ({
      account: accountEntry.account,
      label: accountEntry.label,
      blockedChildren: accountEntry.blockedChildren,
      runningParents: accountEntry.runningParents,
      maxProjectedWait: accountEntry.maxProjectedWait,
      maxLaunchAge: accountEntry.maxLaunchAge,
      victims: [...accountEntry.victims].sort((a, b) =>
        (b.blockedChildren || 0) - (a.blockedChildren || 0)
        || (b.projectedWaitHours || 0) - (a.projectedWaitHours || 0)
        || a.label.localeCompare(b.label)
      ),
      blockers: [...accountEntry.blockerMap.values()]
        .map((blocker) => ({
          ...blocker,
          partitions: [...blocker.partitions].sort(),
        }))
        .sort((a, b) => b.blockingJobs - a.blockingJobs || b.affectedFlows - a.affectedFlows || a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.blockedChildren - a.blockedChildren || b.maxProjectedWait - a.maxProjectedWait || a.label.localeCompare(b.label));

  const totalBlockedChildren = victimScopes.reduce((sum, scope) => sum + (scope.blockedChildren || 0), 0);
  const totalRunningParents = victimScopes.reduce((sum, scope) => sum + (scope.runningParents || 0), 0);
  const maxProjectedWait = Math.max(
    0,
    ...accounts.map((account) => account.maxProjectedWait || 0),
    ...accounts.flatMap((account) => account.blockers.map((blocker) => blocker.projectedWaitHours || 0))
  );
  const maxLaunchAge = Math.max(
    0,
    ...accounts.map((account) => account.maxLaunchAge || 0),
    ...accounts.flatMap((account) => account.blockers.map((blocker) => blocker.launchHours || 0))
  );

  return {
    totalBlockedChildren,
    totalRunningParents,
    maxProjectedWait,
    pastWindowHours: timelineWindow(maxLaunchAge, 72, 72),
    futureWindowHours: timelineWindow(maxProjectedWait, 24, 24),
    accounts,
  };
}

function buildLogjamTimelineWindow(account) {
  const maxProjectedWait = Math.max(
    0,
    account?.maxProjectedWait || 0,
    ...(account?.blockers || []).map((blocker) => blocker.projectedWaitHours || 0)
  );
  const maxLaunchAge = Math.max(
    0,
    account?.maxLaunchAge || 0,
    ...(account?.blockers || []).map((blocker) => blocker.launchHours || 0)
  );
  return {
    pastWindowHours: timelineWindow(maxLaunchAge, 72, 72),
    futureWindowHours: timelineWindow(maxProjectedWait, 24, 24),
  };
}

function matchingItemsByAccount(items, account) {
  return (items || []).filter((item) => text(item?.account) === account);
}

function itemsForAccount(items, account) {
  const list = items || [];
  const matches = matchingItemsByAccount(list, account);
  const hasAccountMetadata = list.some((item) => item && Object.prototype.hasOwnProperty.call(item, "account"));
  if (matches.length || hasAccountMetadata) return matches;
  return list;
}

function scopeLogjamGroup(group, account) {
  const scope = logjamAccountScopes(group).find((candidate) => candidate.account === account);
  if (!scope) return null;

  const originParentsForAccount = matchingItemsByAccount(group.originParents, account);
  const runningParentsForAccount = matchingItemsByAccount(group.runningParents, account);
  const childrenForAccount = matchingItemsByAccount(group.children, account);
  const externalQueuePressure = scope.externalQueuePressure || group.externalQueuePressure;
  const runningParentCount = scope.runningParents ?? scope.runningCount ?? group.runningParentCount ?? group.runningCount ?? 0;
  const originParentCount = scope.originParentCount
    || originParentsForAccount.length
    || runningParentCount
    || group.originParentCount
    || 0;
  const blockedChildren = scope.blockedChildren ?? group.blockedChildren ?? 0;
  const reasonMix = Object.keys(scope.reasonMix || {}).length ? scope.reasonMix : group.reasonMix;

  return {
    ...group,
    accountLabel: scope.accountName,
    blockedChildren,
    runningCount: scope.runningCount ?? group.runningCount ?? 0,
    originParentCount,
    runningParentCount,
    maxWaitHours: scope.maxWaitHours ?? group.maxWaitHours ?? 0,
    maxElapsedHours: scope.maxElapsedHours ?? group.maxElapsedHours ?? 0,
    reasonMix,
    externalQueuePressure,
    originParents: itemsForAccount(group.originParents, account),
    runningParents: itemsForAccount(group.runningParents, account),
    children: itemsForAccount(group.children, account),
    message: externalQueuePressure?.aheadJobs
      ? `Flow ${group.label} under account ${scope.accountName} has ${runningParentCount} active parent run(s), ${blockedChildren} pending child job(s), and ${externalQueuePressure.aheadJobs} higher-priority same-account job(s) from other flows ahead in queue.`
      : `Flow ${group.label} under account ${scope.accountName} has ${runningParentCount} active parent run(s) with ${blockedChildren} pending child job(s).`,
  };
}

function ratioHeatStyle(value, min, max) {
  const numeric = Number(value) || 0;
  const span = Math.max(0.0001, (max || 0) - (min || 0));
  const ratio = Math.max(0, Math.min(1, (numeric - (min || 0)) / span));
  const hue = Math.round(132 - ratio * 128);
  const lightness = 92 - ratio * 16;
  const textColor = ratio > 0.66 ? "#7f1d1d" : ratio < 0.34 ? "#14532d" : "#1f2937";
  return {
    background: `hsla(${hue}, 72%, ${lightness}%, 0.92)`,
    color: textColor,
    borderColor: `hsla(${hue}, 58%, ${Math.max(42, lightness - 26)}%, 0.28)`,
  };
}

function timelineMarkers(pastWindowHours, futureWindowHours) {
  const candidates = [
    { key: "start", hours: -pastWindowHours, priority: 3 },
    { key: "past-mid", hours: -pastWindowHours / 2, priority: 1 },
    { key: "now", hours: 0, priority: 4 },
    { key: "future-mid", hours: futureWindowHours / 2, priority: 1 },
    { key: "end", hours: futureWindowHours, priority: 2 },
  ];
  const unique = candidates.filter((candidate, index, values) =>
    values.findIndex((other) => Math.abs(other.hours - candidate.hours) < 0.001) === index
  ).map((candidate) => ({
    ...candidate,
    position: timelinePosition(candidate.hours, pastWindowHours, futureWindowHours),
    label: fmtTimelineOffset(candidate.hours),
  }));
  const minGap = 11;
  const kept = [];
  for (const marker of [...unique].sort((a, b) => b.priority - a.priority || a.position - b.position)) {
    if (kept.every((existing) => Math.abs(existing.position - marker.position) >= minGap)) {
      kept.push(marker);
    }
  }
  return kept.sort((a, b) => a.position - b.position);
}

function relativeSnapshot(takenAt) {
  if (!takenAt) return "No cached snapshot";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(takenAt));
  if (diff < 60) return `Snapshot ${diff}s ago`;
  if (diff < 3600) return `Snapshot ${Math.floor(diff / 60)}m ago`;
  return `Snapshot ${Math.floor(diff / 3600)}h ago`;
}

function pageDetail(page, data, view) {
  if (!data) return null;
  if (page === "pressure") return null;
  if (page === "logjams") return `${data.data?.total || 0} logjam flows`;
  if (page === "control") return `${data.data?.total || 0} control-plane flows`;
  if (page === "pending" || page === "running") {
    if (view === "list") {
      const start = (data.data?.offset || 0) + 1;
      const end = Math.min((data.data?.offset || 0) + (data.data?.items?.length || 0), data.data?.total || 0);
      return `Jobs ${data.data?.total ? `${start}-${end}` : "0"} of ${data.data?.total || 0}`;
    }
    return `${data.data?.total || 0} flow groups`;
  }
  return null;
}

export default function App() {
  const [cluster, setCluster] = useState(() => readUrlFilters().cluster || "");
  const [clusters, setClusters] = useState([]);
  const [clustersReady, setClustersReady] = useState(false);
  const [page, setPage] = useState(readPage());
  const [pressure, setPressure] = useState(null);
  const [summary, setSummary] = useState(null);
  const [sectionData, setSectionData] = useState(null);
  const [watchItems, setWatchItems] = useState([]);
  const [watchStatuses, setWatchStatuses] = useState({});
  const [search, setSearch] = useState("");
  const [pendingView, setPendingView] = useState("graph");
  const [runningView, setRunningView] = useState("graph");
  const [jobOffsets, setJobOffsets] = useState({ pending: 0, running: 0 });
  const [logjamAccount, setLogjamAccount] = useState(() => readUrlFilters().account || "");
  const [refreshToken, setRefreshToken] = useState(0);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingSection, setLoadingSection] = useState(false);
  const [loadingWatchlist, setLoadingWatchlist] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());
  const sectionSearch = resolveSectionSearch(search, deferredSearch);
  const currentView = page === "pending" ? pendingView : page === "running" ? runningView : "graph";
  const searchPending = page !== "pressure" && page !== "watchlist" && (search.trim() !== sectionSearch || loadingSection);
  const pageRefreshing = page === "watchlist"
    ? loadingWatchlist
    : page === "pressure"
      ? loadingSummary
      : page === "logjams"
        ? loadingSection
        : (loadingSummary || loadingSection);

  useEffect(() => {
    api.clusters().then((data) => {
      const requestedCluster = readUrlFilters().cluster;
      setClusters(data.clusters);
      setCluster((current) => {
        if (current && data.clusters.includes(current)) return current;
        if (requestedCluster && data.clusters.includes(requestedCluster)) return requestedCluster;
        return data.default;
      });
      setClustersReady(true);
    });
  }, []);

  useEffect(() => {
    if (!clustersReady || !cluster) return;
    syncUrlFilters({ cluster, account: logjamAccount });
  }, [cluster, clustersReady, logjamAccount]);

  useEffect(() => {
    const onHashChange = () => startTransition(() => setPage(readPage()));
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = "pressure";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    setJobOffsets({ pending: 0, running: 0 });
  }, [cluster, deferredSearch, pendingView, runningView]);

  useEffect(() => {
    if (page === "pressure" || page === "watchlist") return;
    setSectionData(null);
  }, [cluster, page]);

  useEffect(() => {
    if (!clustersReady || !cluster) return;
    const controller = new AbortController();
    setLoadingSummary(true);
    Promise.all([
      api.pressure(cluster, { signal: controller.signal }),
      api.diagnose(cluster, { section: "summary" }, { signal: controller.signal }),
    ])
      .then(([pressureData, summaryData]) => {
        setPressure(pressureData);
        setSummary(summaryData);
      })
      .catch((error) => {
        if (error.name !== "AbortError") throw error;
      })
      .finally(() => setLoadingSummary(false));
    return () => controller.abort();
  }, [cluster, clustersReady, refreshToken]);

  useEffect(() => {
    if (!clustersReady || !cluster || page === "pressure" || page === "watchlist") {
      setSectionData(null);
      return;
    }
    const controller = new AbortController();
    const query = { section: page, search: sectionSearch };
    if (page === "logjams" || page === "control") query.sampleLimit = 6;
    if (page === "pending" || page === "running") {
      query.view = currentView;
      if (currentView === "graph") query.sampleLimit = 6;
      else {
        query.jobLimit = LIST_JOB_LIMIT;
        query.jobOffset = jobOffsets[page];
      }
    }
    setLoadingSection(true);
    api.diagnose(cluster, query, { signal: controller.signal })
      .then((data) => setSectionData(data))
      .catch((error) => {
        if (error.name !== "AbortError") throw error;
      })
      .finally(() => setLoadingSection(false));
    return () => controller.abort();
  }, [cluster, clustersReady, page, currentView, sectionSearch, jobOffsets, refreshToken]);

  useEffect(() => {
    if (page !== "watchlist") return;
    let cancelled = false;
    setLoadingWatchlist(true);
    api.watch().then(async (result) => {
      if (cancelled) return;
      setWatchItems(result.items);
      const statuses = {};
      for (const item of result.items) statuses[item.id] = await api.watchStatus(item.id);
      if (!cancelled) setWatchStatuses(statuses);
    }).finally(() => {
      if (!cancelled) setLoadingWatchlist(false);
    });
    return () => {
      cancelled = true;
    };
  }, [page, cluster, refreshToken]);

  const currentPage = PAGE_META[page] || PAGE_META.pressure;
  const navigate = (nextPage) => {
    startTransition(() => setPage(nextPage));
    window.location.hash = nextPage;
  };
  const refreshCurrentPage = () => setRefreshToken((value) => value + 1);
  const openAccountPage = (targetPage, account) => {
    if (targetPage === "logjams") {
      setSearch("");
      setLogjamAccount(account);
    } else {
      setSearch(account);
    }
    navigate(targetPage);
  };
  const activeSummary = sectionData?.summary || summary?.summary;
  const snapshotTakenAt = sectionData?.snapshotTakenAt || summary?.snapshotTakenAt || pressure?.snapshotTakenAt;
  const heroSummary = {
    pending: activeSummary?.pendingCount ?? pressure?.pendingCount ?? 0,
    running: activeSummary?.runningCount ?? pressure?.runningCount ?? 0,
    logjams: activeSummary?.logjamCount ?? 0,
    flows: activeSummary?.uniqueFlows ?? 0,
  };
  const headerDetail = pageDetail(page, page === "pressure" ? pressure : sectionData, currentView);

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />
      <header className="hero">
        <button type="button" className="hero-main hero-home-button" onClick={() => navigate("pressure")}>
          <div className="hero-title-row">
            <div className="hero-kicker">QueuePilot / EDA Queue Triage</div>
          </div>
          <div className="hero-heading">
            <h1>{currentPage.label}</h1>
            <p>{currentPage.title}</p>
          </div>
        </button>
        <div className="hero-side">
          <section className="hero-summary-strip" aria-label="Cluster totals">
            {HERO_SUMMARY_ITEMS.map((item) => (
              <article key={item.key} className="hero-summary-card">
                <div>{item.label}</div>
                <strong>{heroSummary[item.key]}</strong>
              </article>
            ))}
          </section>
          <div className="hero-controls compact">
            <label className="cluster-picker">
              <span>Cluster</span>
              <select value={cluster} onChange={(event) => setCluster(event.target.value)}>
                {clusters.map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            {page !== "pressure" && page !== "watchlist" ? (
              <label className="search-box">
                <span>Search</span>
                <div className="search-input-wrap">
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="job id, WCKey, blocker, workdir, user, account"
                  />
                  {searchPending ? (
                    <div className="field-status" aria-live="polite" aria-label="Search in progress">
                      <BusySpinner tone="light" size="sm" />
                    </div>
                  ) : null}
                </div>
              </label>
            ) : null}
          </div>
        </div>
      </header>

      <main className="page-shell">
        <PageHeader
          kicker={currentPage.kicker}
          title={currentPage.title}
          detail={headerDetail}
          snapshotTakenAt={snapshotTakenAt}
          refreshing={pageRefreshing}
          onRefresh={refreshCurrentPage}
        />

        {page === "pressure" && (
          <PressurePage
            pressure={pressure}
            loading={loadingSummary}
            onOpenLogjams={(account) => openAccountPage("logjams", account)}
            onOpenPending={(account) => openAccountPage("pending", account)}
            onOpenRunning={(account) => openAccountPage("running", account)}
          />
        )}
        {page === "logjams" && (
          <LogjamsPage
            response={sectionData}
            loading={loadingSection}
            selectedAccount={logjamAccount}
            onSelectedAccountChange={setLogjamAccount}
          />
        )}
        {page === "control" && <ControlPlanePage response={sectionData} loading={loadingSection} />}
        {page === "pending" && (
          <PendingPage
            response={sectionData}
            loading={loadingSection}
            view={pendingView}
            onViewChange={setPendingView}
            offset={jobOffsets.pending}
            onPageChange={(offset) => setJobOffsets((current) => ({ ...current, pending: offset }))}
          />
        )}
        {page === "running" && (
          <RunningPage
            response={sectionData}
            loading={loadingSection}
            view={runningView}
            onViewChange={setRunningView}
            offset={jobOffsets.running}
            onPageChange={(offset) => setJobOffsets((current) => ({ ...current, running: offset }))}
          />
        )}
        {page === "watchlist" && <WatchlistPage items={watchItems} statuses={watchStatuses} />}
      </main>

      <nav className="top-nav bottom-nav">
        {PAGE_ORDER.map((item) => (
          <button key={item} className={item === page ? "nav-pill active" : "nav-pill"} onClick={() => navigate(item)}>
            <span>{PAGE_META[item].label}</span>
            <small>{PAGE_META[item].kicker}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}

function ControlPlanePage({ response, loading }) {
  const details = response?.details || {};
  const groups = response?.data?.items || [];
  if (loading && !response) {
    return <LoadingState title="Loading control-plane flows" detail="Grouping the /root and (null) orchestration traffic now." />;
  }
  if (!loading && groups.length === 0) {
    return <EmptyState title="No control-plane flows match the current filter" detail="This page isolates the /root and (null) orchestration flows from the normal job traffic." />;
  }
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing control-plane flows" /> : null}
      <div className="page-toolbar">
        <div className="metric-row">
          <MetricChip label="Control flows" value={details.groupedFlows || 0} />
          <MetricChip label="Jobs" value={details.count || 0} />
          <MetricChip label="Max wait" value={fmtHours(details.maxWaitHours || 0)} />
          <MetricChip label="Max runtime" value={fmtHours(details.maxElapsedHours || 0)} />
        </div>
      </div>
      {groups.map((group) => (
        <section key={group.flowKey} className="panel">
          <div className="panel-header">
            <div>
              <h3>{wckeyLabel(group.wckey || group.label)}</h3>
              <p className="panel-subtitle">Dedicated orchestration flow view for Slurm and Jenkins control-plane activity.</p>
            </div>
            <div className="metric-row">
              <MetricChip label="Running" value={group.runningCount} />
              <MetricChip label="Blocked" value={group.pendingCount} />
              <MetricChip label="Jobs" value={group.jobCount} />
            </div>
          </div>
          <FlowGraph mode="control" group={group} />
        </section>
      ))}
    </div>
  );
}

function PageHeader({ kicker, title, detail, snapshotTakenAt, refreshing, onRefresh }) {
  return (
    <div className="page-header">
      <div>
        <div className="section-kicker">{kicker}</div>
        <h2>{title}</h2>
      </div>
      <div className="page-header-actions">
        {typeof detail === "string" && detail ? <div className="detail-chip">{detail}</div> : detail}
        <div className="snapshot-toolbar">
          <div className="detail-chip">{relativeSnapshot(snapshotTakenAt)}</div>
          <button type="button" className="refresh-button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? <BusySpinner size="sm" /> : null}
            <span>Refresh</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function PressurePage({ pressure, loading, onOpenLogjams, onOpenPending, onOpenRunning }) {
  if (!pressure) {
    return <LoadingState title="Loading pressure snapshot" detail="Pulling the latest cached account and partition pressure view." />;
  }
  const sortedAccounts = [...pressure.accounts].sort((a, b) =>
    (b.blockedRunners || 0) - (a.blockedRunners || 0)
    || (b.totalParentRunners || 0) - (a.totalParentRunners || 0)
    || (b.pending || 0) - (a.pending || 0)
    || accountLabel(a.account).localeCompare(accountLabel(b.account))
  );
  const ratioValues = sortedAccounts.map((account) => Number(account.queueRatio) || 0);
  const minRatio = ratioValues.length ? Math.min(...ratioValues) : 0;
  const maxRatio = ratioValues.length ? Math.max(...ratioValues) : 0;
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing cluster pressure" /> : null}
      <section className="panel">
        <div className="panel-header">
          <h3>Account hotspots</h3>
          <div className="detail-chip">Served from the latest collector snapshot</div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              {ACCOUNT_PRESSURE_HEADERS.map((header) => (
                <th key={header.key}>
                  <HeaderLabel label={header.label} help={header.help} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedAccounts.map((account) => (
              <tr key={account.account}>
                <td>
                  <span className={account.licenseBound > 0 ? "table-value-chip warning" : "table-value-chip neutral"}>
                    {account.account}
                  </span>
                </td>
                <td>
                  <button type="button" className="table-link-button" onClick={() => onOpenLogjams(account.account)}>
                    {account.blockedRunners || 0} of {account.totalParentRunners || 0}
                  </button>
                </td>
                <td>
                  <button type="button" className="table-link-button" onClick={() => onOpenPending(account.account)}>
                    {account.pending}
                  </button>
                </td>
                <td>
                  <button type="button" className="table-link-button" onClick={() => onOpenRunning(account.account)}>
                    {account.running}
                  </button>
                </td>
                <td>
                  <span className="table-value-chip ratio" style={ratioHeatStyle(account.queueRatio, minRatio, maxRatio)}>
                    {fmtRatio(account.queueRatio)}
                  </span>
                </td>
                <td><ReasonDisplay category={account.dominantReason} /></td>
                <td>
                  <span className={account.licenseBound > 0 ? "table-value-chip warning" : "table-value-chip neutral"}>
                    {account.licenseBound}
                  </span>
                </td>
                <td>
                  <span className={account.oldestPending > 4 * 3600 ? "table-value-chip danger" : "table-value-chip neutral"}>
                    {fmtCompactDuration(account.oldestPending)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Partition posture</h3>
          <div className="detail-chip">{relativeSnapshot(pressure.snapshotTakenAt)}</div>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              {PARTITION_PRESSURE_HEADERS.map((header) => (
                <th key={header.key}>
                  <HeaderLabel label={header.label} help={header.help} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pressure.partitions.map((partition) => (
              <tr key={partition.partition}>
                <td>{partition.partition}</td>
                <td>{partition.pending}</td>
                <td>{partition.running}</td>
                <td>{fmtRatio(partition.queueRatio)}</td>
                <td><ReasonDisplay category={partition.dominantReason} /></td>
                <td>{partition.licenseBound}</td>
                <td>{fmtCompactDuration(partition.oldestPending)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function LogjamsPage({ response, loading, selectedAccount, onSelectedAccountChange }) {
  const groups = (response?.data?.items || []).map((group, index) => ({
    ...group,
    anchorId: flowAnchorId(index),
  }));
  const overview = buildLogjamOverview(groups);
  const resolvedAccount = resolveLogjamAccountSelection({
    availableAccounts: overview.accounts,
    selectedAccount,
    responseReady: Boolean(response),
  });

  useEffect(() => {
    if (resolvedAccount !== selectedAccount) {
      onSelectedAccountChange(resolvedAccount);
    }
  }, [onSelectedAccountChange, resolvedAccount, selectedAccount]);

  const activeAccount = overview.accounts.find((account) => account.account === resolvedAccount) || overview.accounts[0] || null;
  const activeTimeline = activeAccount ? buildLogjamTimelineWindow(activeAccount) : { pastWindowHours: 72, futureWindowHours: 24 };
  const victimOrder = new Map((activeAccount?.victims || []).map((scope, index) => [scope.flowKey, index]));
  const scopedGroups = activeAccount
    ? groups
      .map((group) => scopeLogjamGroup(group, activeAccount.account))
      .filter(Boolean)
      .sort((a, b) => (victimOrder.get(a.flowKey) ?? 9999) - (victimOrder.get(b.flowKey) ?? 9999))
    : [];

  if (loading && !response) {
    return <LoadingState title="Loading logjams" detail="Tracing blocker chains across the full cached flow set." />;
  }
  if (!loading && groups.length === 0) {
    return <EmptyState title="No logjams detected" detail="There are no flows with both running parents and pending children in the current filtered snapshot." />;
  }
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing logjams" /> : null}
      <section className="panel logjam-overview-panel">
        <div className="panel-header">
          <div>
            <h3>Blockers and victims at a glance</h3>
            <p className="panel-subtitle">Select one account at a time to isolate the victim lanes, same-account blockers, and the matching flow cards below.</p>
          </div>
          <div className="metric-row">
            <MetricChip label="Account views" value={overview.accounts.length} />
            <MetricChip label="Victim flows" value={activeAccount?.victims.length || 0} />
            <MetricChip label="Blocked children" value={activeAccount?.blockedChildren || 0} />
            <MetricChip label="Wait horizon" value={fmtHours(activeAccount?.maxProjectedWait || 0)} />
          </div>
        </div>

        {activeAccount ? (
          <div className="logjam-filter-bar">
            <label className="logjam-account-picker">
              <span>Account view</span>
              <select value={activeAccount.account} onChange={(event) => onSelectedAccountChange(event.target.value)}>
                {overview.accounts.map((account) => (
                  <option key={account.account || account.label} value={account.account}>
                    {account.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="detail-chip">{activeAccount.label} · {activeAccount.blockers.length} blocker flow{activeAccount.blockers.length === 1 ? "" : "s"}</div>
          </div>
        ) : null}

        <div className="logjam-summary-grid">
          {activeAccount ? (
            <section key={activeAccount.account || activeAccount.label} className="logjam-summary-card logjam-account-card">
              <div className="logjam-summary-head">
                <div>
                  <strong>{activeAccount.label}</strong>
                  <div className="logjam-summary-subhead">{activeAccount.victims.length} victim lane{activeAccount.victims.length === 1 ? "" : "s"} · {activeAccount.blockers.length} blocker flow{activeAccount.blockers.length === 1 ? "" : "s"}</div>
                </div>
                <span className="detail-chip">{activeAccount.blockedChildren} blocked · {fmtHours(activeAccount.maxProjectedWait || 0)} wait</span>
              </div>

              <div className="logjam-account-columns">
                <div className="logjam-account-column">
                  <h5>Victims</h5>
                  <div className="logjam-summary-list">
                    {activeAccount.victims.slice(0, 6).map((scope) => (
                      <button key={`${scope.account}::${scope.flowKey}`} type="button" className="logjam-summary-item" onClick={() => jumpToFlow(scope.anchorId)}>
                        <span>{shortFlowLabel(scope.label, 48)}</span>
                        <small>{scope.blockedChildren} blocked · {fmtHours(scope.projectedWaitHours)} wait</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="logjam-account-column">
                  <h5>Blockers</h5>
                  <div className="logjam-summary-list">
                    {activeAccount.blockers.length > 0 ? activeAccount.blockers.slice(0, 6).map((blocker) => (
                      blocker.anchorId ? (
                        <button key={blocker.key} type="button" className="logjam-summary-item" onClick={() => jumpToFlow(blocker.anchorId)}>
                          <span>{shortFlowLabel(blocker.label, 48)}</span>
                          <small>{summarizeBlockerImpact(blocker)}</small>
                        </button>
                      ) : (
                        <div key={blocker.key} className="logjam-summary-item blocker">
                          <span>{shortFlowLabel(blocker.label, 48)}</span>
                          <small>{summarizeBlockerImpact(blocker)}</small>
                        </div>
                      )
                    )) : <div className="logjam-summary-empty">No same-account blocker flows sampled.</div>}
                  </div>
                </div>
              </div>
            </section>
          ) : null}
        </div>

        {activeAccount ? <LogjamTimeline account={activeAccount} window={activeTimeline} /> : null}
      </section>

      {scopedGroups.map((group) => (
        <section key={group.flowKey} id={group.anchorId} className="panel logjam-flow-panel">
          <div className="panel-header">
            <div>
              <h3>{wckeyLabel(group.wckey || group.label)}</h3>
              <p className="panel-subtitle">Scoped to account {group.accountLabel} so the blockers, victims, and queue pressure stay in the same Slurm lane.</p>
            </div>
            <div className="metric-row">
              <MetricChip label="Blocked children" value={group.blockedChildren} />
              <MetricChip label="Running parents" value={group.runningParentCount || group.runningCount} />
              <MetricChip label="Oldest wait" value={fmtHours(group.maxWaitHours)} />
            </div>
          </div>
          <FlowGraph mode="logjam" group={group} />
          <div className="inline-note">{group.message}</div>
        </section>
      ))}
    </div>
  );
}

function LogjamTimelineRow({ entry, overview, nowPosition, axisMarkers, kind }) {
  const launchHours = Math.max(0, Number(entry.launchHours) || 0);
  const projectedHours = Math.max(0, Number(entry.projectedWaitHours) || 0);
  const launchPosition = timelinePosition(-launchHours, overview.pastWindowHours, overview.futureWindowHours);
  const projectedPosition = timelinePosition(projectedHours, overview.pastWindowHours, overview.futureWindowHours);
  const currentSize = timelineBubbleSize(kind === "victim" ? entry.runningParents || 1 : entry.blockingJobs || entry.runningParents || 1);
  const futureSize = timelineBubbleSize(kind === "victim" ? entry.blockedChildren || 1 : entry.blockingJobs || entry.affectedFlows || 1);
  const pastLeft = Math.min(launchPosition, nowPosition);
  const pastWidth = Math.max(Math.abs(nowPosition - launchPosition), 0.8);
  const futureLeft = Math.min(nowPosition, projectedPosition);
  const futureWidth = Math.max(Math.abs(projectedPosition - nowPosition), projectedHours > 0 ? 0.8 : 0);
  const labelSubtitle = kind === "victim"
    ? `${entry.blockedChildren} blocked children · ${entry.runningParents} running parents`
    : `${entry.blockingJobs} ahead jobs · ${entry.affectedFlows} victim flow${entry.affectedFlows === 1 ? "" : "s"}`;
  const preview = kind === "victim" ? summarizeVictimPreview(entry) : summarizeBlockerImpact(entry);

  const renderMarker = (tone, size, position, title, ariaLabel) => {
    const style = {
      left: `calc(${position}% - ${size / 2}px)`,
      width: `${size}px`,
      height: `${size}px`,
    };
    if (entry.anchorId) {
      return (
        <button
          type="button"
          className={`logjam-track-marker ${tone}`}
          style={style}
          onClick={() => jumpToFlow(entry.anchorId)}
          aria-label={ariaLabel}
          title={title}
        />
      );
    }
    return <div className={`logjam-track-marker ${tone} is-static`} style={style} title={title} />;
  };

  const label = (
    <>
      <span>{shortFlowLabel(entry.label, 52)}</span>
      <small>{labelSubtitle}</small>
    </>
  );

  return (
    <div className="logjam-timeline-row">
      {entry.anchorId ? (
        <button type="button" className="logjam-timeline-label" onClick={() => jumpToFlow(entry.anchorId)}>
          {label}
        </button>
      ) : (
        <div className="logjam-timeline-label is-static">
          {label}
        </div>
      )}

      <div className="logjam-timeline-track">
        <div className="logjam-track-base" />
        {axisMarkers.filter((marker) => marker.hours !== 0).map((marker) => (
          <div
            key={marker.key}
            className="logjam-track-guide"
            style={{ left: `${marker.position}%` }}
            aria-hidden="true"
          />
        ))}
        <div className="logjam-track-now" style={{ left: `${nowPosition}%` }} />
        <div className={`logjam-track-span past ${kind === "blocker" ? "blocker" : ""}`} style={{ left: `${pastLeft}%`, width: `${pastWidth}%` }} />
        <div className={`logjam-track-span future ${kind === "blocker" ? "blocker" : ""}`} style={{ left: `${futureLeft}%`, width: `${futureWidth}%` }} />

        {renderMarker(
          "launch",
          10,
          launchPosition,
          `${shortFlowLabel(entry.label, 80)} launched ${fmtHours(launchHours)} ago`,
          `Jump to ${entry.label} launch details`
        )}

        {renderMarker(
          kind === "victim" ? "parent" : "blocker",
          currentSize,
          nowPosition,
          kind === "victim"
            ? `${entry.runningParents} parent run(s) currently active`
            : `${entry.blockingJobs} same-account job(s) ahead across ${entry.affectedFlows} victim flow(s)`,
          `Jump to ${entry.label} current blocker details`
        )}

        {renderMarker(
          kind === "victim" ? "victim" : "release",
          futureSize,
          projectedPosition,
          kind === "victim"
            ? `${entry.blockedChildren} blocked child job(s), projected in ${fmtHours(projectedHours)}`
            : `${entry.blockingJobs} ahead job(s) expected to drain in ${fmtHours(projectedHours)}`,
          `Jump to ${entry.label} projected wait details`
        )}
      </div>

      <div className="logjam-timeline-meta">
        <strong>{fmtHours(launchHours)}</strong>
        <span>launch age</span>
        <strong>{fmtHours(projectedHours)}</strong>
        <span>{kind === "victim" ? "expected wait" : "drain tail"}</span>
        <small>{preview}</small>
      </div>
    </div>
  );
}

function LogjamTimeline({ account, window }) {
  const markers = timelineMarkers(window.pastWindowHours, window.futureWindowHours);
  const nowPosition = timelinePosition(0, window.pastWindowHours, window.futureWindowHours);

  return (
    <section className="logjam-timeline-shell">
      <div className="logjam-timeline-header">
        <div>
          <h4>Launch timeline</h4>
          <p className="panel-subtitle">Left of now shows launch age; right of now shows how long the same-account backlog is expected to keep the selected account lane blocked.</p>
        </div>
        <div className="detail-chip">{fmtTimelineOffset(-window.pastWindowHours)} to {fmtTimelineOffset(window.futureWindowHours)}</div>
      </div>

      <div className="logjam-timeline-axis-row">
        <div className="logjam-timeline-axis-spacer" aria-hidden="true" />
        <div className="logjam-timeline-axis">
          {markers.map((marker) => (
            <div
              key={marker.key}
              className={marker.hours === 0 ? "logjam-axis-tick is-now" : "logjam-axis-tick"}
              style={{ left: `${marker.position}%` }}
            >
              <span>{marker.label}</span>
            </div>
          ))}
        </div>
        <div className="logjam-timeline-axis-spacer" aria-hidden="true" />
      </div>

      <div className="logjam-timeline-rows">
        <section key={account.account || account.label} className="logjam-timeline-account">
          <div className="logjam-timeline-account-head">
            <div>
              <strong>{account.label}</strong>
              <small>{account.victims.length} victim lane{account.victims.length === 1 ? "" : "s"} · {account.blockers.length} blocker flow{account.blockers.length === 1 ? "" : "s"}</small>
            </div>
            <div className="detail-chip">{account.blockedChildren} blocked · {fmtHours(account.maxProjectedWait || 0)} wait</div>
          </div>

          <div className="logjam-timeline-band">
            <div className="logjam-timeline-band-label">Blockers</div>
            <div className="logjam-timeline-band-rows">
              {account.blockers.length > 0 ? account.blockers.map((blocker) => (
                <LogjamTimelineRow key={blocker.key} entry={blocker} overview={window} nowPosition={nowPosition} axisMarkers={markers} kind="blocker" />
              )) : <div className="logjam-timeline-empty">No same-account blocker flows sampled for this account.</div>}
            </div>
          </div>

          <div className="logjam-timeline-band">
            <div className="logjam-timeline-band-label">Victims</div>
            <div className="logjam-timeline-band-rows">
              {account.victims.map((victim) => (
                <LogjamTimelineRow key={`${victim.account}::${victim.flowKey}`} entry={victim} overview={window} nowPosition={nowPosition} axisMarkers={markers} kind="victim" />
              ))}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function PendingPage({ response, loading, view, onViewChange, offset, onPageChange }) {
  const details = response?.details || {};
  const groups = response?.data?.items || [];
  const jobs = response?.data?.items || [];
  if (loading && !response) {
    return <LoadingState title="Loading pending jobs" detail="Fetching the pending view and grouping parent blockers now." />;
  }
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing pending jobs" /> : null}
      <div className="page-toolbar">
        <div className="metric-row">
          <MetricChip label="Flows with pending" value={details.groupedFlows || 0} />
          <MetricChip label="Pending jobs" value={details.count || 0} />
          <MetricChip label="Oldest wait" value={fmtHours(details.maxWaitHours || 0)} />
        </div>
        <ViewToggle value={view} onChange={onViewChange} />
      </div>

      {view === "graph" ? (
        !loading && groups.length === 0 ? <EmptyState title="No pending jobs match the current filter" detail="Try clearing the search or switching clusters." /> : (
          <>
            {groups.map((group) => (
              <section key={group.flowKey} className="panel">
                <div className="panel-header">
                  <div>
                    <h3>{wckeyLabel(group.wckey || group.label)}</h3>
                    <p className="panel-subtitle">Flow tags stay at the root; upstream blockers and waiting buckets stay collapsed.</p>
                  </div>
                  <div className="metric-row">
                    <MetricChip label="Pending jobs" value={group.pendingCount} />
                    <MetricChip label="Avg wait" value={fmtHours(group.avgWaitHours)} />
                    <MetricChip label="Oldest wait" value={fmtHours(group.maxWaitHours)} />
                  </div>
                </div>
                <FlowGraph mode="pending" group={group} />
              </section>
            ))}
          </>
        )
      ) : (
        <JobsList
          title="Pending jobs grouped by WCKey"
          jobs={jobs}
          mode="pending"
          total={response?.data?.total || 0}
          limit={response?.data?.limit || LIST_JOB_LIMIT}
          offset={offset}
          onPageChange={onPageChange}
        />
      )}
    </div>
  );
}

function RunningPage({ response, loading, view, onViewChange, offset, onPageChange }) {
  const details = response?.details || {};
  const groups = response?.data?.items || [];
  const jobs = response?.data?.items || [];
  if (loading && !response) {
    return <LoadingState title="Loading running jobs" detail="Collecting the active runners and their grouped flow context." />;
  }
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing running jobs" /> : null}
      <div className="page-toolbar">
        <div className="metric-row">
          <MetricChip label="Running flows" value={details.groupedFlows || 0} />
          <MetricChip label="Running jobs" value={details.count || 0} />
          <MetricChip label="Longest runtime" value={fmtHours(details.maxElapsedHours || 0)} />
        </div>
        <ViewToggle value={view} onChange={onViewChange} />
      </div>

      {view === "graph" ? (
        !loading && groups.length === 0 ? <EmptyState title="No running jobs match the current filter" detail="Try clearing the search or switching clusters." /> : (
          <>
            {groups.map((group) => (
              <section key={group.flowKey} className="panel">
                <div className="panel-header">
                  <div>
                    <h3>{wckeyLabel(group.wckey || group.label)}</h3>
                    <p className="panel-subtitle">Grouped active runners under one inherited flow identity.</p>
                  </div>
                  <div className="metric-row">
                    <MetricChip label="Running jobs" value={group.runningCount} />
                    <MetricChip label="Avg runtime" value={fmtHours(group.avgElapsedHours)} />
                    <MetricChip label="Longest runtime" value={fmtHours(group.maxElapsedHours)} />
                  </div>
                </div>
                <FlowGraph mode="running" group={group} />
              </section>
            ))}
          </>
        )
      ) : (
        <JobsList
          title="Running jobs grouped by WCKey"
          jobs={jobs}
          mode="running"
          total={response?.data?.total || 0}
          limit={response?.data?.limit || LIST_JOB_LIMIT}
          offset={offset}
          onPageChange={onPageChange}
        />
      )}
    </div>
  );
}

function WatchlistPage({ items, statuses }) {
  if (items.length === 0) {
    return <EmptyState title="No watchlist items yet" detail="POST /api/watch with a matcher to pin jobs, users, WCKeys, or workdirs." />;
  }
  return (
    <div className="stack">
      {items.map((item) => {
        const jobs = statuses[item.id]?.jobs || [];
        return (
          <section key={item.id} className="panel">
            <div className="panel-header">
              <div>
                <h3>{item.label}</h3>
                <p className="panel-subtitle">Matcher: {JSON.stringify(item.matcher)}</p>
              </div>
              <MetricChip label="Matching jobs" value={jobs.length} />
            </div>
            <div className="watch-grid">
              {jobs.map(({ job, diagnosis, eta }) => (
                <article key={job.jobId} className="watch-card">
                  <div className="watch-card-head">
                    <strong>{job.jobId}</strong>
                    <ReasonPill category={diagnosis.category} />
                  </div>
                  <div>{job.name}</div>
                  <div className="muted">{job.user} / {job.account}</div>
                  <div className="muted">WCKey: {wckeyLabel(job.wckey)}</div>
                  <div className="muted">Pending: {fmtCompactDuration(job.pendingSeconds)}</div>
                  <div className="muted">ETA start {fmtCompactDuration(eta.etaStartSeconds)} / finish {fmtCompactDuration(eta.etaFinishSeconds)}</div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function JobsList({ title, jobs, mode, total, limit, offset, onPageChange }) {
  const groups = groupJobsByFlow(jobs);
  if (groups.length === 0) return <EmptyState title="No jobs match the current filter" detail="Try clearing the search or switching clusters." />;
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <div className="detail-chip">{total} matching jobs</div>
      </div>
      <PaginationBar total={total} limit={limit} offset={offset} onPageChange={onPageChange} />
      {groups.map((group) => (
        <div key={group.key} className="job-group">
          <div className="job-group-head">
            <div>
              <strong>{group.label}</strong>
              <div className="muted">{group.items[0]?.workdirRoot || group.items[0]?.workdir || "No shared workdir root"}</div>
            </div>
            <MetricChip label="Jobs" value={group.items.length} />
          </div>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Job</th>
                <th>Owner</th>
                <th>{mode === "pending" ? "Reason" : "State"}</th>
                <th>{mode === "pending" ? "Wait" : "Runtime"}</th>
                <th>Parents</th>
                <th>Workdir</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((job) => (
                <tr key={job.jobId}>
                  <td>
                    <div><strong>{job.jobId}</strong> {job.name}</div>
                    <div className="muted">{wckeyLabel(job.wckey)}</div>
                  </td>
                  <td>{job.user}<div className="muted">{job.account}</div></td>
                  <td>{mode === "pending" ? <ReasonPill category={job.category} /> : job.state}</td>
                  <td>{mode === "pending" ? fmtHours(job.waitHours) : fmtHours(job.elapsedHours)}</td>
                  <td><ParentList job={job} /></td>
                  <td><WorkdirLink job={job} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <PaginationBar total={total} limit={limit} offset={offset} onPageChange={onPageChange} />
    </section>
  );
}

function PaginationBar({ total, limit, offset, onPageChange }) {
  if (total <= limit) return null;
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  return (
    <div className="pagination-bar">
      <span className="muted">Showing {start}-{end} of {total}</span>
      <div className="toggle-group">
        <button className="toggle-pill" onClick={() => onPageChange(Math.max(0, offset - limit))} disabled={offset === 0}>Prev</button>
        <button className="toggle-pill" onClick={() => onPageChange(offset + limit)} disabled={offset + limit >= total}>Next</button>
      </div>
    </div>
  );
}

function WorkdirLink({ job }) {
  if (!job.workdirHref) return <span className="muted">n/a</span>;
  return <a className="workdir-link" href={job.workdirHref} target="_blank" rel="noreferrer">{job.workdir}</a>;
}

function ParentList({ job }) {
  const parents = job.parents || [];
  if (!parents.length) return <span className="muted">No parent blocker visible</span>;
  return (
    <div className="parent-list">
      {parents.slice(0, 3).map((parent) => (
        <div key={parent.jobId}>
          <strong>{parent.jobId}</strong> {parent.name}
        </div>
      ))}
      {parents.length > 3 ? <div className="muted">+{parents.length - 3} more</div> : null}
    </div>
  );
}

function ViewToggle({ value, onChange }) {
  return (
    <div className="toggle-group">
      {["graph", "list"].map((option) => (
        <button key={option} className={value === option ? "toggle-pill active" : "toggle-pill"} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
    </div>
  );
}

function BusyLabel({ label, tone = "default" }) {
  return (
    <div className={`detail-chip busy-label ${tone === "dark" ? "busy-label-dark" : ""}`}>
      <BusySpinner tone={tone === "dark" ? "light" : "default"} size="sm" />
      <span>{label}</span>
    </div>
  );
}

function BusySpinner({ tone = "default", size = "md" }) {
  return <span className={`busy-spinner ${tone} ${size}`} aria-hidden="true" />;
}

function InlineLoadingNotice({ label }) {
  return (
    <div className="inline-loading" aria-live="polite">
      <BusySpinner size="sm" />
      <span>{label}</span>
    </div>
  );
}

function LoadingState({ title, detail }) {
  return (
    <section className="empty-state loading-state" aria-live="polite">
      <BusySpinner size="lg" />
      <div>
        <h3>{title}</h3>
        <p>{detail}</p>
      </div>
    </section>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <article className={`stat-card ${tone}`}>
      <div>{label}</div>
      <strong>{value}</strong>
    </article>
  );
}

function MetricChip({ label, value }) {
  return (
    <div className="metric-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HeaderLabel({ label, help }) {
  return (
    <span className="header-label">
      <span>{label}</span>
      <InfoHint label={`${label} help`} text={help} />
    </span>
  );
}

function ReasonDisplay({ category }) {
  if (!category) return <span className="muted">n/a</span>;
  return (
    <span className="reason-display">
      <ReasonPill category={category} />
      <InfoHint label={`${category} reason help`} text={REASON_HELP[category] || REASON_HELP.other} compact />
    </span>
  );
}

function ReasonPill({ category }) {
  return <span className="reason-pill" style={{ background: REASON_COLORS[category] || REASON_COLORS.other }}>{category || "n/a"}</span>;
}

function InfoHint({ label, text, compact = false }) {
  return (
    <span className={compact ? "info-hint compact" : "info-hint"} tabIndex={0} aria-label={label}>
      <span className="info-hint-trigger" aria-hidden="true">i</span>
      <span className="info-hint-bubble" role="tooltip">{text}</span>
    </span>
  );
}

function EmptyState({ title, detail }) {
  return (
    <section className="empty-state">
      <h3>{title}</h3>
      <p>{detail}</p>
    </section>
  );
}
