import { config } from "../config.js";
import { sizeBucket, percentile } from "@queuepilot/shared";

function historyStartDate(historyDays, nowMs = Date.now()) {
  return new Date(nowMs - historyDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function snapshotCluster({ adapter, db, cluster, onSnapshot }) {
  return adapter.listJobs({ cluster, states: "PD,R" }).then((jobs) => {
    const pend = jobs.filter((j) => /^(PD|PENDING)/i.test(j.state)).length;
    const run = jobs.length - pend;
    const info = db.prepare("INSERT INTO snapshot(cluster,taken_at,pending_count,running_count,raw_json) VALUES(?,?,?,?,?)")
      .run(cluster, Math.floor(Date.now() / 1000), pend, run, JSON.stringify({ jobs }));
    const stmt = db.prepare(`INSERT INTO job_sample(snapshot_id,job_id,cluster,name,user,account,partition,state,reason,priority,pending_seconds,elapsed_seconds,timelimit_seconds,req_cpus,req_mem,wckey,workdir,nodelist) VALUES (@sid,@jobId,@cluster,@name,@user,@account,@partition,@state,@reason,@priority,@pendingSeconds,@elapsedSeconds,@timelimitSeconds,@reqCpus,@reqMem,@wckey,@workdir,@nodelist)`);
    const tx = db.transaction((rows) => rows.forEach((r) => stmt.run({ sid: info.lastInsertRowid, ...r })));
    tx(jobs);
    onSnapshot?.({ cluster, jobs });
    return { cluster, jobs };
  });
}

export function refreshHistoryForCluster({ adapter, db, cluster, historyDays = config.historyDays, nowMs = Date.now() }) {
  const rows = adapter.history({ cluster, startTime: historyStartDate(historyDays, nowMs) });
  return Promise.resolve(rows).then((history) => {
    const upsert = db.prepare(`
      INSERT INTO job_history(job_id,cluster,name,user,account,partition,final_state,submit,start,end,wait_seconds,elapsed_seconds,timelimit_seconds,req_cpus,wckey,workdir)
      VALUES (@jobId,@cluster,@name,@user,@account,@partition,@finalState,@submit,@start,@end,@waitSeconds,@elapsedSeconds,@timelimitSeconds,@reqCpus,@wckey,@workdir)
      ON CONFLICT(job_id, cluster) DO UPDATE SET
        name=excluded.name, user=excluded.user, account=excluded.account, partition=excluded.partition,
        final_state=excluded.final_state, submit=excluded.submit, start=excluded.start, end=excluded.end,
        wait_seconds=excluded.wait_seconds, elapsed_seconds=excluded.elapsed_seconds,
        timelimit_seconds=excluded.timelimit_seconds, req_cpus=excluded.req_cpus,
        wckey=excluded.wckey, workdir=excluded.workdir
    `);
    const tx = db.transaction((items) => items.forEach((item) => upsert.run(item)));
    tx(history);
    return history.length;
  });
}

export function recomputeBucketStats(db, cluster) {
  const rows = db.prepare(`
    SELECT account, partition, wait_seconds, elapsed_seconds, req_cpus
    FROM job_history
    WHERE cluster = ? AND wait_seconds IS NOT NULL AND elapsed_seconds IS NOT NULL
  `).all(cluster);

  const stats = buildBucketStats(rows, cluster);
  const replace = db.prepare(`
    INSERT INTO bucket_stats(cluster,account,partition,reason,size_bucket,p50_wait,p90_wait,p50_elapsed,p90_elapsed,n,updated_at)
    VALUES (@cluster,@account,@partition,@reason,@sizeBucket,@p50Wait,@p90Wait,@p50Elapsed,@p90Elapsed,@n,@updatedAt)
    ON CONFLICT(cluster, account, partition, reason, size_bucket) DO UPDATE SET
      p50_wait=excluded.p50_wait, p90_wait=excluded.p90_wait, p50_elapsed=excluded.p50_elapsed,
      p90_elapsed=excluded.p90_elapsed, n=excluded.n, updated_at=excluded.updated_at
  `);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM bucket_stats WHERE cluster = ?").run(cluster);
    for (const stat of stats) replace.run(stat);
  });
  tx();
  return stats.length;
}

export function buildBucketStats(rows, cluster, updatedAt = Math.floor(Date.now() / 1000)) {
  const buckets = new Map();
  for (const row of rows) {
    const key = [row.account || "", row.partition || "", "_any", sizeBucket(row.req_cpus || 1)].join("|");
    if (!buckets.has(key)) {
      buckets.set(key, {
        account: row.account || "",
        partition: row.partition || "",
        reason: "_any",
        sizeBucket: sizeBucket(row.req_cpus || 1),
        waits: [],
        elapsed: [],
      });
    }
    const bucket = buckets.get(key);
    bucket.waits.push(Number(row.wait_seconds) || 0);
    bucket.elapsed.push(Number(row.elapsed_seconds) || 0);
  }

  return [...buckets.values()].map((bucket) => ({
    cluster,
    account: bucket.account,
    partition: bucket.partition,
    reason: bucket.reason,
    sizeBucket: bucket.sizeBucket,
    p50Wait: Math.round(percentile(bucket.waits, 0.5)),
    p90Wait: Math.round(percentile(bucket.waits, 0.9)),
    p50Elapsed: Math.round(percentile(bucket.elapsed, 0.5)),
    p90Elapsed: Math.round(percentile(bucket.elapsed, 0.9)),
    n: bucket.waits.length,
    updatedAt,
  }));
}

// Periodic snapshot of running+pending jobs into SQLite for each cluster.
export function startCollector({ adapter, db, onSnapshot }) {
  let timer = null;
  const refreshedAt = new Map();
  const historyRefreshSeconds = Math.max(config.pollSeconds * 10, 1800);
  async function tick() {
    for (const cluster of adapter.clusters()) {
      try {
        await snapshotCluster({ adapter, db, cluster, onSnapshot });
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (!refreshedAt.has(cluster) || (nowSeconds - refreshedAt.get(cluster)) >= historyRefreshSeconds) {
          await refreshHistoryForCluster({ adapter, db, cluster });
          recomputeBucketStats(db, cluster);
          refreshedAt.set(cluster, nowSeconds);
        }
      } catch (e) { console.error(`[collector] ${cluster}:`, e.message); }
    }
  }
  tick();
  timer = setInterval(tick, config.pollSeconds * 1000);
  return () => clearInterval(timer);
}
