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
  CREATE INDEX IF NOT EXISTS idx_sample_snap ON job_sample(snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_hist_bucket ON job_history(account, partition);
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
