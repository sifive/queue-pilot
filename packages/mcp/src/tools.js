// MCP tool definitions. Each calls QueuePilot's REST API (set QUEUEPILOT_URL) so the MCP server
// can run standalone; swap to in-process service imports when co-located with the server package.
const BASE = process.env.QUEUEPILOT_URL || "http://localhost:8080";
const get = async (p) => (await fetch(`${BASE}${p}`)).json();
const post = async (p, body) => (await fetch(`${BASE}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

export const TOOLS = [
  { name: "queue_pressure_summary", description: "Per-account/partition queue pressure for a cluster (pending/running, queue ratio, dominant reason, license-bound count).",
    schema: { cluster: "string?" }, run: (a) => get(`/api/pressure?${q(a)}`) },
  { name: "list_pending_jobs", description: "Bucketized pending jobs (by account/user/reason).",
    schema: { cluster: "string?", account: "string?", user: "string?", groupBy: "string?" }, run: (a) => get(`/api/pending?${q(a)}`) },
  { name: "diagnose_job", description: "Diagnose why one job is pending + ETA.",
    schema: { cluster: "string?", jobId: "string" }, run: (a) => get(`/api/jobs/${a.jobId}?${q({ cluster: a.cluster })}`) },
  { name: "diagnose_flow", description: "Diagnose a flow (by user/wckey/workdir) incl. fan-out srun logjams.",
    schema: { cluster: "string?", user: "string?", wckey: "string?", workdir: "string?" }, run: (a) => get(`/api/diagnose?${q(a)}`) },
  { name: "estimate_completion", description: "Estimate time-to-start and time-to-finish for a job.",
    schema: { cluster: "string?", jobId: "string" }, run: (a) => get(`/api/eta/${a.jobId}?${q({ cluster: a.cluster })}`) },
  { name: "watch_add", description: "Add a job-of-interest matcher.",
    schema: { owner: "string?", label: "string", matcher: "object" }, run: (a) => post(`/api/watch`, a) },
  { name: "watch_list", description: "List watch items.", schema: { owner: "string?" }, run: (a) => get(`/api/watch?${q(a)}`) },
  { name: "watch_status", description: "Resolve a watch item to live jobs + diagnostics + ETA.",
    schema: { id: "string", owner: "string?" }, run: (a) => get(`/api/watch/${a.id}/status?${q({ owner: a.owner })}`) },
];
