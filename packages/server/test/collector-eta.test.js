import test from "node:test";
import assert from "node:assert/strict";

import { MockAdapter } from "../src/slurm/mock.js";
import { buildBucketStats } from "../src/services/collector.js";
import { estimateHeuristic } from "../src/services/eta.js";

test("history rollup feeds ETA lookup for mock jobs", async () => {
  const adapter = new MockAdapter();
  const history = await adapter.history({ cluster: "compute1", startTime: "2026-05-30" });
  const stats = buildBucketStats(history.map((row) => ({
    account: row.account,
    partition: row.partition,
    wait_seconds: row.waitSeconds,
    elapsed_seconds: row.elapsedSeconds,
    req_cpus: row.reqCpus,
  })), "compute1", 1719700000);
  const lookup = (account, partition, reason, sizeBucket) => {
    const row = stats.find((entry) =>
      entry.cluster === "compute1" &&
      entry.account === account &&
      entry.partition === partition &&
      entry.reason === "_any" &&
      entry.sizeBucket === sizeBucket
    );
    return row ? {
      p50Wait: row.p50Wait,
      p90Wait: row.p90Wait,
      p50Elapsed: row.p50Elapsed,
      p90Elapsed: row.p90Elapsed,
      n: row.n,
    } : { p50Wait: 0, p90Wait: 0, p50Elapsed: 0, p90Elapsed: 0, n: 0 };
  };
  const jobs = await adapter.listJobs({ states: "PD,R" });
  const pendingJob = jobs.find((job) => job.jobId === "60000042");
  const eta = estimateHeuristic(pendingJob, {
    stats: lookup,
    jobsAhead: 2,
    ratePerMin: 1,
  });

  assert.equal(stats.length, 1);
  assert.equal(history.length, 30);
  assert.equal(stats[0].p50Wait, 1620);
  assert.equal(eta.etaStartSeconds, 870);
  assert.equal(eta.etaFinishSeconds, 1770);
  assert.match(eta.basis, /histP50Wait=1620s/);
});
