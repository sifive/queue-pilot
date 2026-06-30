import React, { startTransition, useDeferredValue, useEffect, useState } from "react";
import { api } from "./api.js";
import { FlowGraph } from "./FlowGraph.jsx";

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

function relativeSnapshot(takenAt) {
  if (!takenAt) return "No cached snapshot";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - Number(takenAt));
  if (diff < 60) return `Snapshot ${diff}s ago`;
  if (diff < 3600) return `Snapshot ${Math.floor(diff / 60)}m ago`;
  return `Snapshot ${Math.floor(diff / 3600)}h ago`;
}

function pageDetail(page, data, view) {
  if (!data) return "Loading...";
  if (page === "pressure") return relativeSnapshot(data.snapshotTakenAt);
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
  return "Ready";
}

export default function App() {
  const [cluster, setCluster] = useState("compute1");
  const [clusters, setClusters] = useState(["compute1"]);
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
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingSection, setLoadingSection] = useState(false);
  const deferredSearch = useDeferredValue(search.trim());
  const currentView = page === "pending" ? pendingView : page === "running" ? runningView : "graph";
  const searchPending = page !== "pressure" && page !== "watchlist" && (search.trim() !== deferredSearch || loadingSection);
  const pageRefreshing = page === "watchlist" ? false : page === "pressure" ? loadingSummary : (loadingSummary || loadingSection);

  useEffect(() => {
    api.clusters().then((data) => {
      setClusters(data.clusters);
      setCluster(data.default);
    });
  }, []);

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
    if (!cluster) return;
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
  }, [cluster]);

  useEffect(() => {
    if (!cluster || page === "pressure" || page === "watchlist") {
      setSectionData(null);
      return;
    }
    const controller = new AbortController();
    const query = { section: page, search: deferredSearch };
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
  }, [cluster, page, currentView, deferredSearch, jobOffsets]);

  useEffect(() => {
    if (page !== "watchlist") return;
    let cancelled = false;
    api.watch().then(async (result) => {
      if (cancelled) return;
      setWatchItems(result.items);
      const statuses = {};
      for (const item of result.items) statuses[item.id] = await api.watchStatus(item.id);
      if (!cancelled) setWatchStatuses(statuses);
    });
    return () => {
      cancelled = true;
    };
  }, [page, cluster]);

  const currentPage = PAGE_META[page] || PAGE_META.pressure;
  const navigate = (nextPage) => {
    startTransition(() => setPage(nextPage));
    window.location.hash = nextPage;
  };
  const activeSummary = sectionData?.summary || summary?.summary;
  const snapshotTakenAt = sectionData?.snapshotTakenAt || summary?.snapshotTakenAt || pressure?.snapshotTakenAt;

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />
      <header className="hero">
        <div className="hero-main">
          <div className="hero-title-row">
            <div className="hero-kicker">QueuePilot / EDA Queue Triage</div>
            <div className="detail-chip hero-chip">{relativeSnapshot(snapshotTakenAt)}</div>
          </div>
          <div className="hero-heading">
            <h1>{currentPage.label}</h1>
            <p>{currentPage.title}</p>
          </div>
        </div>
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
      </header>

      <section className="summary-strip">
        <StatCard label="Pending" value={activeSummary?.pendingCount ?? pressure?.pendingCount ?? 0} tone="warm" />
        <StatCard label="Running" value={activeSummary?.runningCount ?? pressure?.runningCount ?? 0} tone="cool" />
        <StatCard label="Logjams" value={activeSummary?.logjamCount ?? 0} tone="danger" />
        <StatCard label="Control" value={activeSummary?.controlPlaneFlows ?? 0} tone="neutral" />
        <StatCard label="Flows" value={activeSummary?.uniqueFlows ?? 0} tone="neutral" />
      </section>

      <nav className="top-nav">
        {PAGE_ORDER.map((item) => (
          <button key={item} className={item === page ? "nav-pill active" : "nav-pill"} onClick={() => navigate(item)}>
            <span>{PAGE_META[item].label}</span>
            <small>{PAGE_META[item].kicker}</small>
          </button>
        ))}
      </nav>

      <main className="page-shell">
        <PageHeader
          kicker={currentPage.kicker}
          title={currentPage.title}
          detail={pageRefreshing ? <BusyLabel label="Refreshing..." tone="dark" /> : pageDetail(page, page === "pressure" ? pressure : sectionData, currentView)}
        />

        {page === "pressure" && <PressurePage pressure={pressure} loading={loadingSummary} />}
        {page === "logjams" && <LogjamsPage response={sectionData} loading={loadingSection} />}
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

function PageHeader({ kicker, title, detail }) {
  return (
    <div className="page-header">
      <div>
        <div className="section-kicker">{kicker}</div>
        <h2>{title}</h2>
      </div>
      {typeof detail === "string" ? <div className="detail-chip">{detail}</div> : detail}
    </div>
  );
}

function PressurePage({ pressure, loading }) {
  if (!pressure) {
    return <LoadingState title="Loading pressure snapshot" detail="Pulling the latest cached account and partition pressure view." />;
  }
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
              {["Account", "Pending", "Running", "Ratio", "Dominant reason", "License-bound", "Oldest pending"].map((label) => <th key={label}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {pressure.accounts.map((account) => (
              <tr key={account.account}>
                <td>{account.account}</td>
                <td>{account.pending}</td>
                <td>{account.running}</td>
                <td>{fmtRatio(account.queueRatio)}</td>
                <td><ReasonPill category={account.dominantReason} /></td>
                <td>{account.licenseBound}</td>
                <td>{fmtCompactDuration(account.oldestPending)}</td>
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
              {["Partition", "Pending", "Running", "Ratio", "Dominant reason", "License-bound", "Oldest pending"].map((label) => <th key={label}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {pressure.partitions.map((partition) => (
              <tr key={partition.partition}>
                <td>{partition.partition}</td>
                <td>{partition.pending}</td>
                <td>{partition.running}</td>
                <td>{fmtRatio(partition.queueRatio)}</td>
                <td><ReasonPill category={partition.dominantReason} /></td>
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

function LogjamsPage({ response, loading }) {
  const groups = response?.data?.items || [];
  if (loading && !response) {
    return <LoadingState title="Loading logjams" detail="Tracing blocker chains across the full cached flow set." />;
  }
  if (!loading && groups.length === 0) {
    return <EmptyState title="No logjams detected" detail="There are no flows with both running parents and pending children in the current filtered snapshot." />;
  }
  return (
    <div className="stack">
      {loading ? <InlineLoadingNotice label="Refreshing logjams" /> : null}
      {groups.map((group) => (
        <section key={group.flowKey} className="panel">
          <div className="panel-header">
            <div>
              <h3>{wckeyLabel(group.wckey || group.label)}</h3>
              <p className="panel-subtitle">Collapsed by flow tags and parent state to expose the real blockers between runs.</p>
            </div>
            <div className="metric-row">
              <MetricChip label="Blocked children" value={group.blockedChildren} />
              <MetricChip label="Running parents" value={group.runningCount} />
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

function ReasonPill({ category }) {
  return <span className="reason-pill" style={{ background: REASON_COLORS[category] || REASON_COLORS.other }}>{category || "n/a"}</span>;
}

function EmptyState({ title, detail }) {
  return (
    <section className="empty-state">
      <h3>{title}</h3>
      <p>{detail}</p>
    </section>
  );
}
