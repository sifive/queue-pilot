# ETA-MODEL.md

Estimator is pluggable (ETA_MODEL = heuristic | simulation). Output always:
{ etaStartSeconds, etaFinishSeconds, confidence (0..1), basis (text) }.

Caveats to surface in the UI: fairshare only ORDERS pending jobs; backfill can let short jobs cut;
the priority float magnitude is meaningless (only order). So ETAs are estimates with confidence.

## v1 heuristic
1. Bucketize history into bucket_stats keyed by (account, partition, reason, size_bucket) with
   p50/p90 wait and p50/p90 elapsed.
2. time-to-start = weighted blend of:
   a. historical p50 wait for the job's bucket, and
   b. queue-position term = (#eligible higher-priority jobs ahead in same partition) / drain_rate,
      where drain_rate = jobs started per minute for that partition from consecutive snapshots
      (or sacct Start timestamps).
3. time-to-finish = etaStart + expected runtime (p50 elapsed for same WCKey/name pattern, capped
   by the job's Timelimit; fall back to Timelimit if no history).
4. confidence rises with sample size n and reason determinism (Priority > Resources/Licenses).

## v2 simulation (stretch)
Replay the waitlist in priority order against modeled node + license capacity and per-job
timelimits, honoring backfill. Produces per-job start times directly.

Prior art to reuse: sysval_reports/scripts/slurm_predictor.py (wait-time stats by partition,
per-pattern estimated completion, HTML report). Do not reinvent its modeling.
