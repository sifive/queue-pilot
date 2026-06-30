import React, { startTransition, useDeferredValue, useEffect, useState } from "react";
import { api } from "./api.js";

const PAGE_META = {
  pressure: { label: "Pressure", kicker: "Queue posture", title: "Cluster pressure by account and partition" },
  logjams: { label: "Logjams", kicker: "True blockers", title: "Trace running parents to the pending jobs they are holding up" },
  pending: { label: "Pending", kicker: "Waiting traffic", title: "See who has been waiting the longest and which parents are in the way" },
  running: { label: "Running", kicker: "Active traffic", title: "Aggregate currently running jobs by WCKey and execution flow" },
  watchlist: { label: "Watchlist", kicker: "Jobs of interest", title: "Track saved job matchers with live ETA and diagnosis context" },
};

const PAGE_ORDER = ["pressure", "logjams", "pending", "running", "watchlist"];
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
const jobFlowLabel = (job) => wckeyLabel(job.wckey || job.flowKey || job.workdirRoot);

function groupJobsByFlow(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.flowKey || `job:${job.jobId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: jobFlowLabel(items[0]),
    items: [...items].sort((a, b) => (b.pendingSeconds || b.elapsedSeconds || 0) - (a.pendingSeconds || a.elapsedSeconds || 0)),
  })).sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

function searchBlobForJob(job) {
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

function matchesJob(job, searchTerm) {
  if (!job) return false;
  if (!searchTerm) return true;
  return searchBlobForJob(job).includes(searchTerm);
}

function matchesGroup(group, searchTerm, jobsById) {
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
  return (group.jobIds || []).some((jobId) => matchesJob(jobsById[jobId], searchTerm));
}

function reasonMixEntries(reasonMix = {}) {
  return Object.entries(reasonMix).sort((a, b) => b[1] - a[1]);
}

export default function App() {
  const [cluster, setCluster] = useState("compute1");
  const [clusters, setClusters] = useState(["compute1"]);
  const [page, setPage] = useState(readPage());
  const [pressure, setPressure] = useState(null);
  const [triage, setTriage] = useState(null);
  const [watchItems, setWatchItems] = useState([]);
  const [watchStatuses, setWatchStatuses] = useState({});
  const [search, setSearch] = useState("");
  const [pendingView, setPendingView] = useState("graph");
  const [runningView, setRunningView] = useState("graph");
  const [loading, setLoading] = useState(false);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

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
    if (!cluster) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.pressure(cluster), api.diagnose(cluster)])
      .then(([pressureData, triageData]) => {
        if (cancelled) return;
        setPressure(pressureData);
        setTriage(triageData);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cluster]);

  useEffect(() => {
    if (page !== "watchlist") return;
    let cancelled = false;
    api.watch().then(async (result) => {
      if (cancelled) return;
      setWatchItems(result.items);
      const statuses = {};
      for (const item of result.items) {
        statuses[item.id] = await api.watchStatus(item.id);
      }
      if (!cancelled) setWatchStatuses(statuses);
    });
    return () => {
      cancelled = true;
    };
  }, [page, cluster]);

  const jobsById = Object.fromEntries((triage?.jobs || []).map((job) => [job.jobId, job]));
  const filteredJobs = (triage?.jobs || []).filter((job) => matchesJob(job, deferredSearch));
  const filteredLogjams = (triage?.logjams?.items || []).filter((group) => matchesGroup(group, deferredSearch, jobsById));
  const filteredPendingGroups = (triage?.pending?.groups || []).filter((group) => matchesGroup(group, deferredSearch, jobsById));
  const filteredRunningGroups = (triage?.running?.groups || []).filter((group) => matchesGroup(group, deferredSearch, jobsById));
  const filteredPendingJobs = filteredJobs.filter((job) => job.isPending);
  const filteredRunningJobs = filteredJobs.filter((job) => job.isRunning);

  const currentPage = PAGE_META[page] || PAGE_META.pressure;
  const navigate = (nextPage) => {
    startTransition(() => setPage(nextPage));
    window.location.hash = nextPage;
  };

  return (
    <div className="app-shell">
      <div className="background-orb background-orb-a" />
      <div className="background-orb background-orb-b" />
      <header className="hero">
        <div>
          <div className="hero-kicker">QueuePilot / EDA Queue Triage</div>
          <h1>Readable flow traces for crowded Slurm farms.</h1>
          <p>{currentPage.title}</p>
        </div>
        <div className="hero-controls">
          <label className="cluster-picker">
            <span>Cluster</span>
            <select value={cluster} onChange={(event) => setCluster(event.target.value)}>
              {clusters.map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label className="search-box">
            <span>Search jobs, WCKey, blocker, workdir</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="e.g. 60000110, :post-compile/, /scratch/jenkins"
            />
          </label>
        </div>
      </header>

      <section className="summary-strip">
        <StatCard label="Pending" value={triage?.summary?.pendingCount ?? pressure?.pendingCount ?? 0} tone="warm" />
        <StatCard label="Running" value={triage?.summary?.runningCount ?? pressure?.runningCount ?? 0} tone="cool" />
        <StatCard label="Logjams" value={triage?.summary?.logjamCount ?? 0} tone="danger" />
        <StatCard label="Filtered Jobs" value={filteredJobs.length} tone="neutral" />
        <StatCard label="Queue Ratio" value={fmtRatio(pressure?.runningCount ? pressure.pendingCount / pressure.runningCount : pressure?.pendingCount || 0)} tone="cool" />
      </section>

      <nav className="top-nav">
        {PAGE_ORDER.map((item) => (
          <button
            key={item}
            className={item === page ? "nav-pill active" : "nav-pill"}
            onClick={() => navigate(item)}
          >
            <span>{PAGE_META[item].label}</span>
            <small>{PAGE_META[item].kicker}</small>
          </button>
        ))}
      </nav>

      <main className="page-shell">
        <PageHeader kicker={currentPage.kicker} title={currentPage.title} detail={loading ? "Refreshing..." : `${filteredJobs.length} matching jobs in view`} />

        {page === "pressure" && pressure && <PressurePage pressure={pressure} />}
        {page === "logjams" && triage && <LogjamsPage groups={filteredLogjams} jobsById={jobsById} />}
        {page === "pending" && triage && (
          <PendingPage
            groups={filteredPendingGroups}
            jobs={filteredPendingJobs}
            jobsById={jobsById}
            view={pendingView}
            onViewChange={setPendingView}
          />
        )}
        {page === "running" && triage && (
          <RunningPage
            groups={filteredRunningGroups}
            jobs={filteredRunningJobs}
            jobsById={jobsById}
            view={runningView}
            onViewChange={setRunningView}
          />
        )}
        {page === "watchlist" && <WatchlistPage items={watchItems} statuses={watchStatuses} />}
      </main>
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
      <div className="detail-chip">{detail}</div>
    </div>
  );
}

function PressurePage({ pressure }) {
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-header">
          <h3>Account hotspots</h3>
          <div className="detail-chip">Sorted by pending volume</div>
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
          <div className="detail-chip">Same view, split by partition</div>
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

function LogjamsPage({ groups, jobsById }) {
  if (groups.length === 0) {
    return <EmptyState title="No logjams detected" detail="There are no flows with both running parents and pending children in the current snapshot." />;
  }

  return (
    <div className="stack">
      {groups.map((group) => {
        const childJobs = group.childJobIds.map((jobId) => jobsById[jobId]).filter(Boolean);
        return (
          <section key={group.flowKey} className="panel">
            <div className="panel-header">
              <div>
                <h3>{wckeyLabel(group.wckey || group.label)}</h3>
                <p className="panel-subtitle">{group.workdirRoot || "Flow traced from WCKey only"}</p>
              </div>
              <div className="metric-row">
                <MetricChip label="Blocked children" value={group.blockedChildren} />
                <MetricChip label="Running parents" value={group.runningCount} />
                <MetricChip label="Oldest wait" value={fmtHours(group.maxWaitHours)} />
              </div>
            </div>

            <FlowBoard
              lanes={[
                { title: "Origin parents", items: group.originParents, empty: "No origin parents in sample" },
                { title: "Active parents", items: group.runningParents, empty: "No active parent jobs" },
                { title: "Queue friction", items: reasonMixEntries(group.reasonMix).map(([category, count]) => ({ jobId: category, name: `${count} job(s)`, state: category })), type: "reason", empty: "No queue pressure" },
                { title: "Impacted pending jobs", items: childJobs, empty: "No impacted jobs" },
              ]}
            />

            <div className="inline-note">{group.message}</div>
          </section>
        );
      })}
    </div>
  );
}

function PendingPage({ groups, jobs, jobsById, view, onViewChange }) {
  return (
    <div className="stack">
      <div className="page-toolbar">
        <div className="metric-row">
          <MetricChip label="Flows with pending" value={groups.length} />
          <MetricChip label="Pending jobs" value={jobs.length} />
          <MetricChip label="Oldest wait" value={jobs.length ? fmtHours(Math.max(...jobs.map((job) => job.waitHours))) : "0.0h"} />
        </div>
        <ViewToggle value={view} onChange={onViewChange} />
      </div>

      {view === "graph" ? (
        groups.length === 0 ? <EmptyState title="No pending jobs match the current filter" detail="Try clearing the search or switching clusters." /> : groups.map((group) => (
          <section key={group.flowKey} className="panel">
            <div className="panel-header">
              <div>
                <h3>{wckeyLabel(group.wckey || group.label)}</h3>
                <p className="panel-subtitle">{group.workdirRoot || "No shared workdir root available"}</p>
              </div>
              <div className="metric-row">
                <MetricChip label="Pending jobs" value={group.pendingCount} />
                <MetricChip label="Avg wait" value={fmtHours(group.avgWaitHours)} />
                <MetricChip label="Oldest wait" value={fmtHours(group.maxWaitHours)} />
              </div>
            </div>

            <FlowBoard
              lanes={[
                { title: "Flow / WCKey", items: [{ jobId: group.flowKey, name: group.label, state: group.accounts.join(", "), workdir: group.workdirRoot }], type: "flow" },
                { title: "Parent blockers", items: group.blockers.length ? group.blockers : group.originParents, empty: "No visible parent blocker in snapshot" },
                { title: "Pending pressure", items: reasonMixEntries(group.reasonMix).map(([category, count]) => ({ jobId: category, name: `${count} job(s)`, state: category })), type: "reason" },
                { title: "Impacted jobs", items: group.pendingJobIds.map((jobId) => jobsById[jobId]).filter(Boolean), empty: "No matching jobs in view" },
              ]}
            />
          </section>
        ))
      ) : (
        <JobsList title="Pending jobs grouped by WCKey" jobs={jobs} jobsById={jobsById} mode="pending" />
      )}
    </div>
  );
}

function RunningPage({ groups, jobs, jobsById, view, onViewChange }) {
  return (
    <div className="stack">
      <div className="page-toolbar">
        <div className="metric-row">
          <MetricChip label="Running flows" value={groups.length} />
          <MetricChip label="Running jobs" value={jobs.length} />
          <MetricChip label="Longest runtime" value={jobs.length ? fmtHours(Math.max(...jobs.map((job) => job.elapsedHours))) : "0.0h"} />
        </div>
        <ViewToggle value={view} onChange={onViewChange} />
      </div>

      {view === "graph" ? (
        groups.length === 0 ? <EmptyState title="No running jobs match the current filter" detail="Try clearing the search or switching clusters." /> : groups.map((group) => (
          <section key={group.flowKey} className="panel">
            <div className="panel-header">
              <div>
                <h3>{wckeyLabel(group.wckey || group.label)}</h3>
                <p className="panel-subtitle">{group.workdirRoot || "No shared workdir root available"}</p>
              </div>
              <div className="metric-row">
                <MetricChip label="Running jobs" value={group.runningCount} />
                <MetricChip label="Avg runtime" value={fmtHours(group.avgElapsedHours)} />
                <MetricChip label="Longest runtime" value={fmtHours(group.maxElapsedHours)} />
              </div>
            </div>

            <FlowBoard
              lanes={[
                { title: "Flow / WCKey", items: [{ jobId: group.flowKey, name: group.label, state: group.users.join(", "), workdir: group.workdirRoot }], type: "flow" },
                { title: "Origin trace", items: group.originParents, empty: "No origin parent in snapshot" },
                { title: "Running jobs", items: group.runningJobIds.map((jobId) => jobsById[jobId]).filter(Boolean), empty: "No running jobs in view" },
              ]}
            />
          </section>
        ))
      ) : (
        <JobsList title="Running jobs grouped by WCKey" jobs={jobs} jobsById={jobsById} mode="running" />
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

function JobsList({ title, jobs, jobsById, mode }) {
  const groups = groupJobsByFlow(jobs);
  if (groups.length === 0) return <EmptyState title="No jobs match the current filter" detail="Try clearing the search or switching clusters." />;
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <div className="detail-chip">{jobs.length} jobs</div>
      </div>
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
                  <td><ParentList job={job} jobsById={jobsById} /></td>
                  <td><WorkdirLink job={job} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function FlowBoard({ lanes }) {
  return (
    <div className="flow-board">
      {lanes.map((lane, index) => (
        <div key={`${lane.title}-${index}`} className="flow-lane">
          <div className="flow-lane-head">
            <span>{lane.title}</span>
            {index < lanes.length - 1 ? <span className="flow-arrow">→</span> : null}
          </div>
          <div className="flow-lane-body">
            {lane.items?.length ? lane.items.map((item) => <FlowCard key={`${lane.title}-${item.jobId}-${item.name}`} item={item} type={lane.type} />) : (
              <div className="flow-card empty">{lane.empty || "No data"}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FlowCard({ item, type }) {
  if (type === "reason") {
    return (
      <div className="flow-card">
        <div className="flow-card-head">
          <strong>{item.jobId}</strong>
          <ReasonPill category={item.state} />
        </div>
        <div className="muted">{item.name}</div>
      </div>
    );
  }

  if (type === "flow") {
    return (
      <div className="flow-card">
        <div className="flow-card-head">
          <strong>{wckeyLabel(item.name)}</strong>
        </div>
        <div className="muted">{item.state || "No owner/account summary"}</div>
        {item.workdir ? <div className="muted">{item.workdir}</div> : null}
      </div>
    );
  }

  const job = item;
  return (
    <div className="flow-card">
      <div className="flow-card-head">
        <strong>{job.jobId}</strong>
        {/^(PD|PENDING)/i.test(job.state) ? <ReasonPill category={job.category} /> : <StateBadge state={job.state} />}
      </div>
      <div>{job.name}</div>
      <div className="muted">{job.user} / {job.account}</div>
      {job.waitHours ? <div className="muted">Waiting {fmtHours(job.waitHours)}</div> : null}
      {job.elapsedHours ? <div className="muted">Running {fmtHours(job.elapsedHours)}</div> : null}
      {job.workdir ? <div className="muted">{job.workdir}</div> : null}
    </div>
  );
}

function WorkdirLink({ job }) {
  if (!job.workdirHref) return <span className="muted">n/a</span>;
  return (
    <a className="workdir-link" href={job.workdirHref} target="_blank" rel="noreferrer">
      {job.workdir}
    </a>
  );
}

function ParentList({ job, jobsById }) {
  const parentIds = job.blockerIds?.length ? job.blockerIds : (job.originParentIds || []).filter((jobId) => jobId !== job.jobId);
  const parents = parentIds.map((jobId) => jobsById[jobId]).filter(Boolean);
  if (!parents?.length) return <span className="muted">No parent blocker visible</span>;
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
        <button
          key={option}
          className={value === option ? "toggle-pill active" : "toggle-pill"}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
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

function StateBadge({ state }) {
  return <span className="state-badge">{state || "n/a"}</span>;
}

function EmptyState({ title, detail }) {
  return (
    <section className="empty-state">
      <h3>{title}</h3>
      <p>{detail}</p>
    </section>
  );
}
