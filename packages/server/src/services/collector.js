import { config } from "../config.js";

// Periodic snapshot of running+pending jobs into SQLite for each cluster.
export function startCollector({ adapter, db, onSnapshot }) {
  let timer = null;
  async function tick() {
    for (const cluster of adapter.clusters()) {
      try {
        const jobs = await adapter.listJobs({ cluster, states: "PD,R" });
        const pend = jobs.filter((j) => /^(PD|PENDING)/i.test(j.state)).length;
        const run = jobs.length - pend;
        const info = db.prepare("INSERT INTO snapshot(cluster,taken_at,pending_count,running_count,raw_json) VALUES(?,?,?,?,?)")
          .run(cluster, Math.floor(Date.now() / 1000), pend, run, JSON.stringify({ n: jobs.length }));
        const stmt = db.prepare(`INSERT INTO job_sample(snapshot_id,job_id,cluster,name,user,account,partition,state,reason,priority,pending_seconds,elapsed_seconds,timelimit_seconds,req_cpus,req_mem,wckey,workdir,nodelist) VALUES (@sid,@jobId,@cluster,@name,@user,@account,@partition,@state,@reason,@priority,@pendingSeconds,@elapsedSeconds,@timelimitSeconds,@reqCpus,@reqMem,@wckey,@workdir,@nodelist)`);
        const tx = db.transaction((rows) => rows.forEach((r) => stmt.run({ sid: info.lastInsertRowid, ...r })));
        tx(jobs);
        onSnapshot?.({ cluster, jobs });
      } catch (e) { console.error(`[collector] ${cluster}:`, e.message); }
    }
  }
  tick();
  timer = setInterval(tick, config.pollSeconds * 1000);
  return () => clearInterval(timer);
}

// TODO: nightly job_history backfill via adapter.history() + bucket_stats rollup (see db schema).
