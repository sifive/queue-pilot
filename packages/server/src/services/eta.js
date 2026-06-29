import {
  parseSlurmTime, percentile, sizeBucket, drainRate, queuePositionWaitSeconds,
  estimateStartSeconds, estimateFinishSeconds, confidenceFor,
} from "@queuepilot/shared";
import { classifyReason } from "@queuepilot/shared";

// Heuristic ETA. statsFn(account,partition,reason,sizeBucket) -> {p50Wait,p90Wait,p50Elapsed,n}
// jobsAhead = count of eligible higher-priority jobs in the same partition; rate = jobs/min draining.
export function estimateHeuristic(job, { stats, jobsAhead = 0, ratePerMin = 0 } = {}) {
  const cat = classifyReason(job.reason, job.priority).category;
  const sb = sizeBucket(job.reqCpus);
  const s = (stats && stats(job.account, job.partition, cat, sb)) || { p50Wait: 0, p90Wait: 0, p50Elapsed: 0, n: 0 };
  const queueWait = queuePositionWaitSeconds(jobsAhead, ratePerMin);
  const etaStartSeconds = estimateStartSeconds({ histP50Wait: s.p50Wait, queueWait });
  const expectedRuntime = s.p50Elapsed || job.timelimitSeconds || 0;
  const etaFinishSeconds = estimateFinishSeconds({ etaStartSeconds, expectedRuntime, timelimit: job.timelimitSeconds });
  return {
    etaStartSeconds, etaFinishSeconds, confidence: confidenceFor({ n: s.n, category: cat }),
    basis: `heuristic: histP50Wait=${s.p50Wait}s, jobsAhead=${jobsAhead}, rate=${ratePerMin.toFixed(2)}/min, n=${s.n}`,
  };
}

export function makeBucketStatsLookup(db) {
  const exact = db.prepare(`
    SELECT p50_wait, p90_wait, p50_elapsed, p90_elapsed, n
    FROM bucket_stats
    WHERE cluster = ? AND account = ? AND partition = ? AND reason = ? AND size_bucket = ?
  `);
  const fallback = db.prepare(`
    SELECT p50_wait, p90_wait, p50_elapsed, p90_elapsed, n
    FROM bucket_stats
    WHERE cluster = ? AND account = ? AND partition = ? AND reason = '_any' AND size_bucket = ?
  `);
  return (cluster, account, partition, reason, bucket) => {
    const row = exact.get(cluster || "", account || "", partition || "", reason || "_any", bucket)
      || fallback.get(cluster || "", account || "", partition || "", bucket)
      || { p50_wait: 0, p90_wait: 0, p50_elapsed: 0, p90_elapsed: 0, n: 0 };
    return {
      p50Wait: Number(row.p50_wait) || 0,
      p90Wait: Number(row.p90_wait) || 0,
      p50Elapsed: Number(row.p50_elapsed) || 0,
      p90Elapsed: Number(row.p90_elapsed) || 0,
      n: Number(row.n) || 0,
    };
  };
}

// v2 placeholder. Implement event-driven backfill-aware sim later (see docs/ETA-MODEL.md).
export function estimateSimulation() { throw new Error("simulation estimator not implemented (v2)"); }

export { percentile, drainRate, parseSlurmTime };
