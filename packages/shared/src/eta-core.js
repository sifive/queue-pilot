// Pure math for the ETA heuristic + time parsing. No I/O.

export function parseSlurmTime(s) {
  if (!s || s === "N/A" || s === "UNLIMITED" || s === "INVALID") return 0;
  let days = 0, rest = s;
  if (rest.includes("-")) { const [d, r] = rest.split("-"); days = parseInt(d, 10) || 0; rest = r; }
  const p = rest.split(":").map((n) => parseInt(n, 10) || 0);
  let h = 0, m = 0, sec = 0;
  if (p.length === 3) [h, m, sec] = p;
  else if (p.length === 2) [m, sec] = p;
  else if (p.length === 1) [sec] = p;
  return days * 86400 + h * 3600 + m * 60 + sec;
}

export function percentile(values, q) {
  if (!values || values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1));
  return v[idx];
}

export function sizeBucket(reqCpus = 1) {
  const c = Number(reqCpus) || 1;
  if (c <= 1) return "1";
  if (c <= 4) return "2-4";
  if (c <= 16) return "5-16";
  if (c <= 64) return "17-64";
  return "65+";
}

// jobs started per minute for a partition, from two snapshots dt seconds apart.
export function drainRate(startedCount, dtSeconds) {
  if (dtSeconds <= 0) return 0;
  return (startedCount / dtSeconds) * 60;
}

// queue-position wait estimate: jobs ahead / drain rate (per minute) -> seconds.
export function queuePositionWaitSeconds(jobsAhead, ratePerMin) {
  if (ratePerMin <= 0) return Infinity;
  return (jobsAhead / ratePerMin) * 60;
}

// Blend historical p50 wait with live queue-position estimate.
export function estimateStartSeconds({ histP50Wait = 0, queueWait = 0, wHist = 0.5 }) {
  const finiteQ = Number.isFinite(queueWait) ? queueWait : histP50Wait;
  return Math.round(wHist * histP50Wait + (1 - wHist) * finiteQ);
}

export function estimateFinishSeconds({ etaStartSeconds, expectedRuntime, timelimit }) {
  const run = expectedRuntime > 0 ? Math.min(expectedRuntime, timelimit || expectedRuntime)
                                  : (timelimit || 0);
  return etaStartSeconds + run;
}

// confidence: more samples + more deterministic reason => higher.
export function confidenceFor({ n = 0, category = "other" }) {
  const base = Math.min(0.6, n / 100);
  const bonus = category === "priority" ? 0.3 : category === "resources" ? 0.15 : 0.05;
  return Math.max(0.05, Math.min(0.95, base + bonus));
}
