import { config } from "./config.js";
import { pressureSummary, bucketize } from "./services/queue.js";
import { buildDiagnosticsDataset, diagnoseJob, detectFanoutLogjam } from "./services/diagnostics.js";
import { estimateHeuristic, makeBucketStatsLookup } from "./services/eta.js";
import { makeWatchlist } from "./services/watchlist.js";

export function registerRoutes(app, ctx) {
  const { adapter, db } = ctx;
  const watch = makeWatchlist(db);
  const cl = (q) => q.cluster || config.defaultCluster;
  const stats = makeBucketStatsLookup(db);
  const etaForJob = (job, jobs) => {
    const ahead = jobs.filter((candidate) =>
      /^(PD|PENDING)/i.test(candidate.state) &&
      candidate.partition === job.partition &&
      candidate.jobId !== job.jobId &&
      candidate.priority > job.priority
    ).length;
    return estimateHeuristic(job, {
      stats: (account, partition, reason, bucket) => stats(job.cluster, account, partition, reason, bucket),
      jobsAhead: ahead,
      ratePerMin: 0,
    });
  };

  app.get("/api/clusters", async () => ({ clusters: adapter.clusters(), default: config.defaultCluster }));

  app.get("/api/pressure", async (req) => pressureSummary(adapter, cl(req.query)));

  app.get("/api/pending", async (req) => {
    const jobs = await adapter.pending({ cluster: cl(req.query), account: req.query.account, user: req.query.user });
    const groupBy = (req.query.groupBy || "account,reason").split(",");
    // pending() may return raw bucket rows (cli) or Job objects (mock/restd); normalize keys.
    const norm = jobs.map((j) => ({
      account: j.Account ?? j.account, user: j.UserName ?? j.user, reason: j.Reason ?? j.reason,
      pendingSeconds: j.pendingSeconds ?? 0,
    }));
    return { count: norm.length, buckets: bucketize(norm, groupBy) };
  });

  app.get("/api/jobs/:id", async (req) => {
    const cluster = cl(req.query);
    const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
    const job = jobs.find((j) => j.jobId === req.params.id) || (await adapter.jobDetail({ cluster, jobId: req.params.id }));
    if (!job || !job.jobId) return { error: "not found" };
    return { job, diagnosis: diagnoseJob(job), eta: etaForJob(job, jobs) };
  });

  app.get("/api/diagnose", async (req) => {
    const cluster = cl(req.query);
    let jobs = await adapter.listJobs({ cluster, states: "PD,R" });
    if (req.query.user) jobs = jobs.filter((j) => j.user === req.query.user);
    if (req.query.wckey) jobs = jobs.filter((j) => (j.wckey || "").includes(req.query.wckey));
    if (req.query.workdir) jobs = jobs.filter((j) => (j.workdir || "").includes(req.query.workdir));
    return buildDiagnosticsDataset(jobs);
  });

  app.get("/api/eta/:id", async (req) => {
    const cluster = cl(req.query);
    const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
    const job = jobs.find((j) => j.jobId === req.params.id);
    if (!job) return { error: "not found" };
    return etaForJob(job, jobs);
  });

  app.get("/api/watch", async (req) => ({ items: watch.list(req.query.owner || "me") }));
  app.post("/api/watch", async (req) => watch.add(req.body.owner || "me", req.body.label, req.body.matcher));
  app.delete("/api/watch/:id", async (req) => { watch.remove(Number(req.params.id)); return { ok: true }; });
  app.get("/api/watch/:id/status", async (req) => {
    const item = watch.list("me").find((w) => String(w.id) === req.params.id)
      || watch.list(req.query.owner || "me").find((w) => String(w.id) === req.params.id);
    if (!item) return { error: "not found" };
    const cluster = item.matcher.cluster || config.defaultCluster;
    const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
    const mine = watch.resolve(jobs, item.matcher);
    return {
      item, jobs: mine.map((j) => ({ job: j, diagnosis: diagnoseJob(j), eta: etaForJob(j, jobs) })),
      logjams: detectFanoutLogjam(jobs).filter((l) => mine.some((m) => l.childJobIds.includes(m.jobId) || l.parentJobId === m.jobId)),
    };
  });
}
