import Database from "better-sqlite3";
import { config } from "./config.js";

export function openDb() {
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  const bucketStatsColumns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bucket_stats'").get()
    ? db.prepare("PRAGMA table_info(bucket_stats)").all()
    : [];
  if (bucketStatsColumns.length > 0 && !bucketStatsColumns.some((column) => column.name === "cluster")) {
    db.exec("DROP TABLE bucket_stats");
  }
  db.exec(`
  CREATE TABLE IF NOT EXISTS snapshot(
    id INTEGER PRIMARY KEY, cluster TEXT, taken_at INTEGER,
    pending_count INTEGER, running_count INTEGER, raw_json TEXT);
  CREATE TABLE IF NOT EXISTS job_sample(
    snapshot_id INTEGER, job_id TEXT, cluster TEXT, name TEXT, user TEXT, account TEXT,
    partition TEXT, state TEXT, reason TEXT, priority REAL, pending_seconds INTEGER,
    elapsed_seconds INTEGER, timelimit_seconds INTEGER, req_cpus INTEGER, req_mem TEXT,
    wckey TEXT, workdir TEXT, nodelist TEXT);
  CREATE TABLE IF NOT EXISTS job_history(
    job_id TEXT, cluster TEXT, name TEXT, user TEXT, account TEXT, partition TEXT,
    final_state TEXT, submit INTEGER, start INTEGER, end INTEGER, wait_seconds INTEGER,
    elapsed_seconds INTEGER, timelimit_seconds INTEGER, req_cpus INTEGER, wckey TEXT, workdir TEXT,
    PRIMARY KEY(job_id, cluster));
  CREATE TABLE IF NOT EXISTS watch(
    id INTEGER PRIMARY KEY, owner TEXT, label TEXT, matcher_json TEXT, created_at INTEGER);
  CREATE TABLE IF NOT EXISTS bucket_stats(
    cluster TEXT, account TEXT, partition TEXT, reason TEXT, size_bucket TEXT,
    p50_wait INTEGER, p90_wait INTEGER, p50_elapsed INTEGER, p90_elapsed INTEGER,
    n INTEGER, updated_at INTEGER,
    PRIMARY KEY(cluster, account, partition, reason, size_bucket));
  CREATE TABLE IF NOT EXISTS diagnostics_cache(
    cluster TEXT PRIMARY KEY,
    snapshot_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    built_at INTEGER NOT NULL,
    summary_json TEXT NOT NULL,
    graph_json TEXT NOT NULL,
    jobs_json TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_sample_snap ON job_sample(snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_hist_bucket ON job_history(account, partition);
  CREATE INDEX IF NOT EXISTS idx_diag_cache_snap ON diagnostics_cache(snapshot_id);
  `);
  return db;
}

export function latestSnapshot(db, cluster) {
  return db.prepare(`
    SELECT id, cluster, taken_at, pending_count, running_count, raw_json
    FROM snapshot
    WHERE cluster = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(cluster) || null;
}

export function latestSnapshotInfo(db, cluster) {
  return db.prepare(`
    SELECT id, cluster, taken_at, pending_count, running_count
    FROM snapshot
    WHERE cluster = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(cluster) || null;
}

export function snapshotJobsById(db, snapshotId) {
  const row = db.prepare(`
    SELECT raw_json
    FROM snapshot
    WHERE id = ?
    LIMIT 1
  `).get(snapshotId);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.raw_json || "{}");
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch {
    return [];
  }
}

export function latestSnapshotJobs(db, cluster) {
  const snapshot = latestSnapshot(db, cluster);
  if (!snapshot) return { snapshot: null, jobs: [] };
  try {
    const parsed = JSON.parse(snapshot.raw_json || "{}");
    return { snapshot, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return { snapshot, jobs: [] };
  }
}

export function readDiagnosticsCache(db, cluster) {
  return db.prepare(`
    SELECT cluster, snapshot_id, version, built_at, summary_json, graph_json, jobs_json
    FROM diagnostics_cache
    WHERE cluster = ?
  `).get(cluster) || null;
}

export function writeDiagnosticsCache(db, entry) {
  db.prepare(`
    INSERT INTO diagnostics_cache(cluster, snapshot_id, version, built_at, summary_json, graph_json, jobs_json)
    VALUES (@cluster, @snapshotId, @version, @builtAt, @summaryJson, @graphJson, @jobsJson)
    ON CONFLICT(cluster) DO UPDATE SET
      snapshot_id=excluded.snapshot_id,
      version=excluded.version,
      built_at=excluded.built_at,
      summary_json=excluded.summary_json,
      graph_json=excluded.graph_json,
      jobs_json=excluded.jobs_json
  `).run(entry);
}
