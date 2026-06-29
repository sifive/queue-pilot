import React, { useEffect, useState } from "react";
import { api } from "./api.js";

const REASON_COLORS = { priority: "#3b82f6", resources: "#f59e0b", licenses: "#ef4444",
  dependency: "#8b5cf6", qos: "#10b981", partition: "#6b7280", held: "#111827", other: "#9ca3af" };
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h ? `${h}h${m}m` : `${m}m`; };

export default function App() {
  const [cluster, setCluster] = useState("compute1");
  const [clusters, setClusters] = useState(["compute1"]);
  const [tab, setTab] = useState("pressure");
  const [pressure, setPressure] = useState(null);
  const [diag, setDiag] = useState(null);

  useEffect(() => { api.clusters().then((c) => { setClusters(c.clusters); setCluster(c.default); }); }, []);
  useEffect(() => { if (!cluster) return; api.pressure(cluster).then(setPressure); api.diagnose(cluster).then(setDiag); }, [cluster, tab]);

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", margin: 0, color: "#111827" }}>
      <header style={{ background: "#0f172a", color: "#fff", padding: "12px 20px", display: "flex", gap: 16, alignItems: "center" }}>
        <strong>QueuePilot</strong><span style={{ opacity: .7 }}>EDA Queue Triage</span>
        <select value={cluster} onChange={(e) => setCluster(e.target.value)} style={{ marginLeft: "auto" }}>
          {clusters.map((c) => <option key={c}>{c}</option>)}
        </select>
      </header>
      <nav style={{ display: "flex", gap: 8, padding: "10px 20px", borderBottom: "1px solid #e5e7eb" }}>
        {["pressure", "watchlist", "diagnostics"].map((t) =>
          <button key={t} onClick={() => setTab(t)} style={{ padding: "6px 12px", border: "1px solid #e5e7eb",
            background: tab === t ? "#0f172a" : "#fff", color: tab === t ? "#fff" : "#111827", borderRadius: 6, cursor: "pointer" }}>{t}</button>)}
      </nav>
      <main style={{ padding: 20 }}>
        {tab === "pressure" && pressure && <Pressure p={pressure} />}
        {tab === "diagnostics" && diag && <Diagnostics d={diag} />}
        {tab === "watchlist" && <Watchlist cluster={cluster} />}
      </main>
    </div>
  );
}

function Pressure({ p }) {
  return (<>
    <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
      <Card label="Pending" value={p.pendingCount} />
      <Card label="Running" value={p.runningCount} />
      <Card label="Queue ratio" value={(p.runningCount ? p.pendingCount / p.runningCount : p.pendingCount).toFixed(2)} />
    </div>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{["Account", "Pending", "Running", "Ratio", "Dominant reason", "License-bound", "Oldest pending"].map((h) =>
        <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>{p.accounts.map((a) => <tr key={a.account}>
        <td style={td}>{a.account}</td><td style={td}>{a.pending}</td><td style={td}>{a.running}</td>
        <td style={td}>{a.queueRatio}</td>
        <td style={td}><Chip cat={a.dominantReason} /></td>
        <td style={td}>{a.licenseBound}</td><td style={td}>{fmt(a.oldestPending)}</td>
      </tr>)}</tbody>
    </table>
  </>);
}

function Diagnostics({ d }) {
  return (<>
    <h3>Fan-out logjams</h3>
    {d.logjams.length === 0 ? <p>None detected.</p> : d.logjams.map((l) =>
      <div key={l.parentJobId} style={{ border: "1px solid #fca5a5", background: "#fef2f2", padding: 12, borderRadius: 8, marginBottom: 8 }}>
        <strong>Parent {l.parentJobId}</strong> - {l.blockedChildren} blocked child job(s)
        <div style={{ fontSize: 13, color: "#374151" }}>{l.message}</div>
      </div>)}
    <h3>Pending job diagnoses</h3>
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{["Job", "State", "Category", "Explanation", "Flags"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>{d.jobs.filter((j) => j.category).map((j) => <tr key={j.jobId}>
        <td style={td}>{j.jobId}</td><td style={td}>{j.state}</td><td style={td}><Chip cat={j.category} /></td>
        <td style={td}>{j.explain}</td><td style={td}>{j.findings?.map((f) => f.type).join(", ")}</td>
      </tr>)}</tbody>
    </table>
  </>);
}

function Watchlist({ cluster }) {
  const [items, setItems] = useState([]);
  const [statuses, setStatuses] = useState({});
  useEffect(() => { api.watch().then((r) => { setItems(r.items); r.items.forEach((w) => api.watchStatus(w.id).then((s) => setStatuses((p) => ({ ...p, [w.id]: s })))); }); }, [cluster]);
  if (items.length === 0) return <p>No jobs of interest yet. POST /api/watch with a matcher (user/account/wckeyGlob/workdirSubstring/nameRegex/jobIds).</p>;
  return items.map((w) => <div key={w.id} style={{ marginBottom: 16 }}>
    <h3>{w.label}</h3>
    {(statuses[w.id]?.jobs || []).map(({ job, diagnosis, eta }) => <div key={job.jobId} style={{ border: "1px solid #e5e7eb", padding: 10, borderRadius: 8, marginBottom: 6 }}>
      <strong>{job.jobId}</strong> {job.name} <Chip cat={diagnosis.category} /> pending {fmt(job.pendingSeconds)} -
      ETA start ~{fmt(eta.etaStartSeconds)}, finish ~{fmt(eta.etaFinishSeconds)} (conf {(eta.confidence*100|0)}%)
    </div>)}
  </div>);
}

const Card = ({ label, value }) => <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, minWidth: 120 }}>
  <div style={{ color: "#6b7280", fontSize: 12 }}>{label}</div><div style={{ fontSize: 28, fontWeight: 700 }}>{value}</div></div>;
const Chip = ({ cat }) => <span style={{ background: REASON_COLORS[cat] || "#9ca3af", color: "#fff", padding: "2px 8px", borderRadius: 999, fontSize: 12 }}>{cat || "n/a"}</span>;
const th = { textAlign: "left", borderBottom: "2px solid #e5e7eb", padding: "8px 6px", fontSize: 13 };
const td = { borderBottom: "1px solid #f1f5f9", padding: "8px 6px", fontSize: 13 };
