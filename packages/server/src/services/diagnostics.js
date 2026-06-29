import { classifyReason } from "@queuepilot/shared";

// Per-job diagnosis.
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

// Fan-out logjam: running parents with pending children sharing wckey-prefix / workdir-build path.
export function detectFanoutLogjam(jobs) {
  const running = jobs.filter((j) => /^(R|RUNNING)/i.test(j.state));
  const pending = jobs.filter((j) => /^(PD|PENDING)/i.test(j.state));
  const flowKey = (j) => (j.wckey && j.wckey !== "" ? j.wckey : null) || buildPath(j.workdir);
  const out = [];
  for (const parent of running) {
    const fk = flowKey(parent);
    if (!fk) continue;
    const children = pending.filter((c) => flowKey(c) === fk);
    if (children.length === 0) continue;
    const reasonMix = {};
    for (const c of children) {
      const cat = classifyReason(c.reason, c.priority).category;
      reasonMix[cat] = (reasonMix[cat] || 0) + 1;
    }
    out.push({
      type: "fanout_logjam", parentJobId: parent.jobId, flowKey: fk,
      blockedChildren: children.length, reasonMix,
      message: `Running parent ${parent.jobId} has ${children.length} pending child srun job(s) behind the queue (${JSON.stringify(reasonMix)}). Parent cannot complete until they run.`,
      childJobIds: children.map((c) => c.jobId),
    });
  }
  return out.sort((a, b) => b.blockedChildren - a.blockedChildren);
}

// Reduce a workdir to its build root so siblings of a flow group together.
export function buildPath(workdir = "") {
  const m = workdir.match(/^(.*?\/builds)\//);
  if (m) return m[1];
  return workdir.split("/").slice(0, 7).join("/") || null;
}
