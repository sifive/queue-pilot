import Database from "better-sqlite3";
import { config } from "./config.js";

export function openDb() {
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
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
    account TEXT, partition TEXT, reason TEXT, size_bucket TEXT,
    p50_wait INTEGER, p90_wait INTEGER, p50_elapsed INTEGER, p90_elapsed INTEGER,
    n INTEGER, updated_at INTEGER,
    PRIMARY KEY(account, partition, reason, size_bucket));
  CREATE INDEX IF NOT EXISTS idx_sample_snap ON job_sample(snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_hist_bucket ON job_history(account, partition);
  `);
  return db;
}
