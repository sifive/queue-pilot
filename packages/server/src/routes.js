import { createHash } from "node:crypto";
import { config } from "./config.js";
import { latestSnapshotInfo, latestSnapshotJobs, snapshotJobsById } from "./db.js";
import { bucketize, summarizeBlockedRunners, summarizePressureJobs } from "./services/queue.js";
import {
  buildDiagnosticsArtifact,
  diagnoseJob,
  detectFanoutLogjam,
  getOrBuildDiagnosticsArtifact,
  renderDiagnosticsResponse,
} from "./services/diagnostics.js";
import { estimateHeuristic, makeBucketStatsLookup } from "./services/eta.js";
import { makeWatchlist } from "./services/watchlist.js";

export function registerRoutes(app, ctx) {
  const { adapter, db } = ctx;
  const watch = makeWatchlist(db);
  const cl = (q) => q.cluster || config.defaultCluster;
  const stats = makeBucketStatsLookup(db);
  const etagForDiagnose = ({ cluster, snapshotId, artifactVersion, query }) => {
    const digest = createHash("sha1").update(JSON.stringify({
      cluster,
      snapshotId: snapshotId || "live",
      artifactVersion,
      section: query.section || "summary",
      view: query.view || "graph",
      search: query.search || "",
      user: query.user || "",
      wckey: query.wckey || "",
      workdir: query.workdir || "",
      jobLimit: query.jobLimit || "",
      jobOffset: query.jobOffset || "",
      sampleLimit: query.sampleLimit || "",
    })).digest("hex");
    return `"${digest}"`;
  };
  const currentJobs = async (cluster) => {
    const snapshotData = latestSnapshotJobs(db, cluster);
    if (snapshotData.jobs.length > 0) return snapshotData;
    const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
    return { snapshot: null, jobs };
  };
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

  app.get("/api/pressure", async (req) => {
    const cluster = cl(req.query);
    const { snapshot, jobs } = await currentJobs(cluster);
    const base = summarizePressureJobs(jobs, cluster);
    const artifact = snapshot?.id
      ? await getOrBuildDiagnosticsArtifact({ db, cluster, snapshot, jobs })
      : buildDiagnosticsArtifact(jobs);
    const blockedRunnerByAccount = summarizeBlockedRunners(artifact);
    return {
      snapshotTakenAt: snapshot?.taken_at || Math.floor(Date.now() / 1000),
      ...base,
      accounts: base.accounts.map((account) => ({
        ...account,
        blockedRunners: blockedRunnerByAccount[account.account]?.blockedRunners || 0,
        totalParentRunners: blockedRunnerByAccount[account.account]?.totalParentRunners || 0,
      })),
    };
  });

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
    const { jobs } = await currentJobs(cluster);
    const job = jobs.find((j) => j.jobId === req.params.id) || (await adapter.jobDetail({ cluster, jobId: req.params.id }));
    if (!job || !job.jobId) return { error: "not found" };
    return { job, diagnosis: diagnoseJob(job), eta: etaForJob(job, jobs) };
  });

  app.get("/api/diagnose", async (req, reply) => {
    const cluster = cl(req.query);
    const snapshot = latestSnapshotInfo(db, cluster);
    const query = {
      section: req.query.section || "summary",
      view: req.query.view,
      search: req.query.search,
      jobLimit: req.query.jobLimit,
      jobOffset: req.query.jobOffset,
      sampleLimit: req.query.sampleLimit,
    };

    const baseArtifact = snapshot?.id
      ? await getOrBuildDiagnosticsArtifact({
        db,
        cluster,
        snapshot,
        loadJobs: () => snapshotJobsById(db, snapshot.id),
      })
      : buildDiagnosticsArtifact(await adapter.listJobs({ cluster, states: "PD,R" }));
    let artifact = baseArtifact;
    const hasPrefilters = Boolean(req.query.user || req.query.wckey || req.query.workdir);
    if (hasPrefilters) {
      const filteredJobs = (baseArtifact.jobs?.items || []).filter((job) => {
        if (req.query.user && job.user !== req.query.user) return false;
        if (req.query.wckey && !(job.wckey || "").includes(req.query.wckey)) return false;
        if (req.query.workdir && !(job.workdir || "").includes(req.query.workdir)) return false;
        return true;
      });
      artifact = buildDiagnosticsArtifact(filteredJobs);
    }

    const etag = etagForDiagnose({
      cluster,
      snapshotId: snapshot?.id || null,
      artifactVersion: artifact.version,
      query: req.query,
    });
    reply.header("Cache-Control", "private, max-age=0, must-revalidate");
    reply.header("ETag", etag);
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();

    return {
      cluster,
      snapshotTakenAt: snapshot?.taken_at || Math.floor(Date.now() / 1000),
      snapshotId: snapshot?.id || null,
      artifactVersion: artifact.version,
      ...renderDiagnosticsResponse(artifact, query),
    };
  });

  app.get("/api/eta/:id", async (req) => {
    const cluster = cl(req.query);
    const { jobs } = await currentJobs(cluster);
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
    const { jobs } = await currentJobs(cluster);
    const mine = watch.resolve(jobs, item.matcher);
    return {
      item, jobs: mine.map((j) => ({ job: j, diagnosis: diagnoseJob(j), eta: etaForJob(j, jobs) })),
      logjams: detectFanoutLogjam(jobs).filter((l) => mine.some((m) => l.childJobIds.includes(m.jobId) || l.parentJobId === m.jobId)),
    };
  });
}
