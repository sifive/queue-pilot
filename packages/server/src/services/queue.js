import { classifyReason } from "@queuepilot/shared";

export function bucketize(jobs, keys = ["account", "user", "reason"]) {
  const map = new Map();
  for (const j of jobs) {
    const k = keys.map((key) => j[key] ?? "").join("|");
    if (!map.has(k)) map.set(k, { key: Object.fromEntries(keys.map((x) => [x, j[x]])), count: 0, oldestPending: 0 });
    const b = map.get(k);
    b.count += 1;
    b.oldestPending = Math.max(b.oldestPending, j.pendingSeconds || 0);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export async function pressureSummary(adapter, cluster) {
  const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
  const pending = jobs.filter((j) => /^(PD|PENDING)/i.test(j.state));
  const running = jobs.filter((j) => /^(R|RUNNING)/i.test(j.state));
  const byAccount = {};
  for (const j of jobs) {
    const a = (byAccount[j.account] ||= { account: j.account, pending: 0, running: 0, licenseBound: 0, oldestPending: 0, reasons: {} });
    if (/^(PD|PENDING)/i.test(j.state)) {
      a.pending++;
      const c = classifyReason(j.reason, j.priority).category;
      a.reasons[c] = (a.reasons[c] || 0) + 1;
      if (c === "licenses") a.licenseBound++;
      a.oldestPending = Math.max(a.oldestPending, j.pendingSeconds || 0);
    } else a.running++;
  }
  const accounts = Object.values(byAccount).map((a) => ({
    ...a, queueRatio: a.running ? +(a.pending / a.running).toFixed(2) : a.pending,
    dominantReason: Object.entries(a.reasons).sort((x, y) => y[1] - x[1])[0]?.[0] || null,
  })).sort((x, y) => y.pending - x.pending);
  return { cluster, pendingCount: pending.length, runningCount: running.length, accounts };
}
