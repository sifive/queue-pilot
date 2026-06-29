# AGENTS.md - QueuePilot (EDA Job-Farm Queue Triage)

Build spec & operating manual for the coding agent implementing **QueuePilot**: a
self-contained Node.js app (Web UI + REST/WebSocket API + MCP server) that lets SiFive
engineers triage and understand **queue pressure** on the Slurm/Jenkins EDA job farm,
monitor their **jobs of interest**, **diagnose** why pending jobs are stuck, and get an
**estimated time-to-start / time-to-completion** modeled against live queue traffic.

This file is the source of truth. Do not invent Slurm behavior - every command and rule
below is grounded in SiFive's own docs and repos (see "Grounding & references").

---

## 0. Mission & the problem

The farm is almost always oversubscribed - there is "almost always a waiting line". Jobs sit
PENDING until resources free up and no higher-fairshare account is competing. A common failure
mode for **regressions** (Jenkins-driven Wake/Federation flows): a running parent job `srun`s
child jobs, and those **fan-out srun jobs land at the END of the pending queue**. In a busy
system this delays the parent's completion and creates a **logjam**.

    Running Queue:  JobA (active, consuming walltime, waiting for JobAA...)
                      |- JobAA (spawns independent srun)
    Pending Queue:  JobB, JobC, JobD, JobE, [ JobAA ]   <- JobAA stuck behind everything

QueuePilot must make this legible: show jobs of interest, classify WHY each is pending
(Priority / Resources / Licenses / Dependency / QOS / Partition / Association / held), surface
fan-out logjams, quantify queue pressure per account/partition, and predict when work will
actually start and finish.

---

## 1. Non-negotiable constraints

- **Self-contained Node.js stack.** Single repo, `npm install && npm run dev`. Embedded SQLite
  (better-sqlite3). No external DB server, no cloud dependency.
- **Read-only against Slurm by default.** Only read: squeue, sacct, sshare, sprio, scontrol show.
  MUST NOT submit/cancel/hold/`scontrol update` unless the off-by-default `ENABLE_ACTIONS` flag is
  set. Mutating the controller is out of scope for v1.
- **Be gentle on slurmctld.** squeue hits the controller; sacct hits slurmdbd; overloading the
  controller is worse. ALWAYS server-side filter (-u, -A, -t, --me, -p, -M) before post-processing,
  poll on a sane interval (default 30s, never < 10s), coalesce concurrent requests, cache snapshots.
  Prefer sacct for historical reads.
- **Three clusters:** compute1 (default, bulk), testbed (VCU118 + HAPS hosts), primo (Siemens FPGA).
  Always carry an explicit --clusters/-M selector; default compute1.
- **Tool-agnostic & pluggable.** Slurm access (sec 4) and the ETA model (sec 7) are behind
  interfaces with swappable implementations. Do not hard-wire one transport or estimator.

---

## 2. High-level architecture

    [web (Vite)] <--REST+WS--> [server (Fastify): routes-services-slurmAdapter-sqlite]
    [AI agents / OpenCode] <--MCP stdio/HTTP--> [same server services]
    packages/shared = queries, reason taxonomy, types, ETA core math

**npm workspaces monorepo** (packages/*):

| Package  | Responsibility |
|----------|----------------|
| shared   | Canonical Slurm query/format strings, REASON taxonomy, JSDoc types, ETA core math. |
| server   | Fastify HTTP + WebSocket API. Owns Slurm adapter, snapshot collector, SQLite history, diagnostics/ETA/watchlist services. |
| mcp      | MCP server exposing the same services as tools (stdio + streamable-HTTP), in-process. |
| web      | Vite + React dashboard: pressure overview, watchlist, per-job diagnostics, ETA. |

Keep the services layer transport-agnostic so REST, WS, and MCP call the SAME functions.

---

## 3. Repo layout (scaffolded)

    AGENTS.md  README.md  package.json  .env.example  .gitignore
    docs/ ARCHITECTURE.md  SLURM-QUERIES.md  ETA-MODEL.md
    packages/shared/src/   queries.js reasons.js types.js eta-core.js
    packages/server/src/   index.js config.js routes.js db.js
                  slurm/   index.js cli.js restd.js mock.js
               services/   collector.js queue.js diagnostics.js eta.js watchlist.js
    packages/mcp/src/      server.js tools.js
    packages/web/          index.html vite.config.js  src/(main.jsx App.jsx api.js)

---

## 4. Slurm adapter (packages/server/src/slurm)

ONE interface, three impls selected by `SLURM_ADAPTER` (cli | restd | mock, default cli):
- listJobs({cluster,states,accounts,users,partitions,fields}) -> Job[]
- jobDetail({cluster,jobId}) -> Job
- fairshare({user,accounts,cluster}) -> Share[]   (sshare)
- prio({jobIds,cluster}) -> Prio[]                 (sprio)
- history({cluster,accounts,users,startTime,states}) -> JobRecord[]  (sacct)
- clusters() -> string[]

### 4a. cli.js (DEFAULT) - shell out to Slurm binaries
- Run on a host with the Slurm client, OR ssh to one when SLURM_SSH_HOST is set. Use a persistent
  SSH ControlMaster; never spawn one ssh per lookup.
- Use pipe-separated, header-suppressed, parsable output. Prefer `squeue -O 'field:0|,...'`
  (uppercase -O, width :0 = no clipping, | separator) because wide fields like WCKey/WorkDir get
  truncated by lowercase -o. See shared/queries.js and docs/SLURM-QUERIES.md.
- Exact patterns QueuePilot issues:
  - Pending bucket summary (farm or per account -A):
    squeue -h -t PD -O 'Priority:0|,PendingTime:0|,Account:0|,UserName:0|,Reason:0' | uniq -c | sort
  - User pending: squeue --me -t PD  /  squeue -u USER -t PD --long
  - WCKey view: squeue -u USER -O 'JobID:0|,State:0|,Name:0|,WCKey:0'
  - WorkDir view: squeue -u USER -O 'JobID:0|,State:0|,Name:0|,WorkDir:0' --sort=j
  - History: sacct -M CLUSTER --starttime=D --state=COMPLETED,FAILED,TIMEOUT,CANCELLED
    --format=JobID,JobName%80,User,Account,Partition,State,Submit,Start,End,Elapsed,Timelimit,ReqCPUS,ReqMem,WCKey%120,WorkDir%200 --noheader --parsable2
  - Fairshare: sshare -U USER -o Account --noheader --parsable2 to derive accounts; sshare -a;
    sprio for priority components.
- scontrol show job ID --json is fine for single-job detail. Avoid bulk squeue --json on huge
  queues; the parsable -O path is cheaper on the controller.
- Robust parsing: split on |, trim, map by the format order in shared/queries.js. Handle
  D-HH:MM:SS and HH:MM:SS (eta-core.parseSlurmTime).

### 4b. restd.js - slurmrestd HTTP
- Pinned API version (e.g. v0.0.42). SiFive on Slurm 24.05->25.05; HAM/ProFPGACS on 25.11.
  GET /slurm/<v>/jobs, /slurm/<v>/job/{id}, /slurmdb/<v>/jobs. Auth X-SLURM-USER-TOKEN. Normalize
  into the same Job shape as cli.

### 4c. mock.js - fixtures
- Serve canned snapshots from packages/server/test/fixtures/*.json (License-bound bucket,
  Priority-bound bucket, a held priority=0 job, and a fan-out srun child behind the pending queue).
  Used for offline `npm run dev` and tests.

---

## 5. Data model & history (SQLite, better-sqlite3)

- snapshot(id, cluster, taken_at, pending_count, running_count, raw_json)
- job_sample(snapshot_id, job_id, cluster, name, user, account, partition, state, reason,
  priority REAL, pending_seconds, elapsed_seconds, timelimit_seconds, req_cpus, req_mem, wckey,
  workdir, nodelist)
- job_history(job_id, cluster, name, user, account, partition, final_state, submit, start, end,
  wait_seconds, elapsed_seconds, timelimit_seconds, req_cpus, wckey, workdir)   <- from sacct
- watch(id, owner, label, matcher_json, created_at)                              <- jobs of interest
- bucket_stats(account, partition, reason, size_bucket, p50_wait, p90_wait, p50_elapsed,
  p90_elapsed, n, updated_at)                                                    <- powers ETA

Collector writes snapshots; a nightly + on-demand rollup recomputes bucket_stats from job_history.
Bound history (default 30 days, configurable) - mirror slurm_predictor's 30-day retention.

---

## 6. Services

### 6a. queue.js - pressure & bucketization
- getPending({cluster,account?,user?}) -> normalized jobs.
- bucketize(jobs, keys=['account','user','reason']) -> counts per bucket in priority order
  (the "buckets of waiting jobs" view; primary signal when thousands are pending).
- pressureSummary({cluster}) -> per account & partition: pending, running, queue ratio,
  oldest pending age, dominant REASON, license-bound count.
- Scheduler-stall heuristic: if top-of-waitlist REASON is Resources, scheduler may hold slots
  (head-of-line blocking); if everything is Priority, slots are essentially full, just wait turn.

### 6b. diagnostics.js - why is THIS job stuck
Per job produce a Diagnosis:
- Classify reason via shared/reasons.js into category + plain-English explanation: Priority,
  Resources (may head-of-line stall), Licenses (e.g. snps_vcs_runtime fully consumed), Dependency,
  QOSJobLimit/QOSResourceLimit, PartitionNodeLimit/PartitionTimeLimit (can sit forever),
  AssociationJobLimit/AssociationResourceLimit, Reservation, ReqNodeNotAvail/DOWN/DRAINED,
  "launch failed requeued held".
- priority === 0 -> flag held or partition-deeply-constrained (admin/user hold).
- **Fan-out logjam detector** (key feature): for a watched flow (matched by WCKey prefix or
  WorkDir build path), correlate RUNNING parents with PENDING children sharing the same
  WCKey/WorkDir/build-id. If a running parent has pending srun children deep in the queue, emit a
  fanout_logjam finding with blocked-child count + their REASON mix.
- Starvation: pending_seconds beyond threshold (e.g. > bucket p90) -> flag.
- Output read-only actionable guidance (e.g. "13 children Licenses-bound on snps_vcs_runtime;
  parent JobA cannot complete until they run"). Do NOT auto-act.

### 6c. eta.js - estimate start & finish (pluggable, sec 7)
### 6d. watchlist.js - jobs of interest
Matcher = any of user, account, wckeyGlob, workdirSubstring, nameRegex, jobIds, cluster. Persist
in watch. On each snapshot resolve matches, attach diagnostics + ETA, push change events over WS.

---

## 7. ETA model (shared/eta-core.js + services/eta.js)

Pluggable behind ETA_MODEL (heuristic | simulation, default heuristic). Always return
{etaStartSeconds, etaFinishSeconds, confidence, basis}. Never claim precision Slurm can't give:
fairshare only ORDERS the pending queue, backfill can reorder, the priority float magnitude is
meaningless (only order counts). Surface confidence + basis.

### v1 heuristic (build first)
Inputs per pending job: reason, account, partition, size bucket (req_cpus/mem band), priority-rank
within partition waitlist, historical bucket_stats.
- time-to-start = blend of (1) historical p50/p90 wait for (account,partition,reason,size_bucket)
  and (2) live queue-position term: count jobs ahead (same partition, higher priority, eligible) /
  recent drain rate (jobs started per minute for that partition, from consecutive snapshots/sacct).
- time-to-finish = etaStart + expected runtime (historical p50 elapsed for same WCKey/name pattern,
  capped by Timelimit; fall back to Timelimit when no history).
- confidence scales with sample size n and reason determinism (Priority more predictable than
  Resources/Licenses).
- Mirrors sysval_reports/slurm_predictor.py (wait-time stats by partition + per-pattern ETA) -
  reuse its logic, do not reinvent.

### v2 simulation (stretch)
Event-driven backfill-aware sim: replay the waitlist in priority order vs modeled node/license
capacity and timelimits, honoring backfill (a short job can cut if it finishes before the reserved
big job starts). Higher fidelity for Resources/license-bound queues.

### Optional AI narrative
Thin off-by-default hook to summarize a snapshot via the internal AI platform (OpenAI-compatible /
Ollama, as slurm_predictor does). It only EXPLAINS numbers the deterministic model produced - never
the source of the ETA.

---

## 8. API surface (server, all read-only)
- GET /api/clusters
- GET /api/pressure?cluster=
- GET /api/pending?cluster=&account=&user=&groupBy=
- GET /api/jobs/:id?cluster=          (detail + diagnosis + eta)
- GET /api/diagnose?cluster=&user=&wckey=&workdir=   (flow diagnoses incl. fan-out)
- GET /api/eta/:id?cluster=
- GET/POST/DELETE /api/watch ; GET /api/watch/:id/status
- WS /ws  (snapshot deltas, watchlist status, new diagnostics)
Shapes = shared/types.js typedefs. Version under /api.

---

## 9. MCP server (packages/mcp)
Use @modelcontextprotocol/sdk; expose stdio (OpenCode/desktop) and streamable-HTTP. Tools map 1:1
to services (call in-process; fall back to REST if standalone):
- queue_pressure_summary({cluster})
- list_pending_jobs({cluster,account?,user?,groupBy?})
- diagnose_job({cluster,jobId})
- diagnose_flow({cluster,user?,wckey?,workdir?})   (includes fan-out logjam findings)
- estimate_completion({cluster,jobId})
- watch_add / watch_list / watch_status
Return structured JSON + short human summary. Mark all tools read-only. Register in OpenCode.

---

## 10. Web UI (packages/web) - Vite + React, polling REST + subscribing /ws
1. Queue Pressure: per-cluster cards (pending/running, queue ratio, dominant reason, license-bound
   count, oldest pending), bucket table (account x reason), pending-by-account bar chart, color-coded
   reasons.
2. My Jobs of Interest: watchlist; per job state, reason chip, pending time, priority rank,
   ETA-to-start / ETA-to-finish with confidence, fanout_logjam/starvation flags.
3. Job / Flow Diagnostics: search by jobId or WCKey/WorkDir; diagnosis, running-parent ->
   pending-children fan-out tree, read-only remediation notes.
Light styling (one CSS file). Provide an "export HTML report" button (reuse slurm_predictor report).

---

## 11. Config & env (.env.example)
See .env.example. Cluster/account catalog (verif, verif_bulk, verif_express, perf, sw_ci, fed_ci,
the *_agent/*_ci/*_express/*_bulk tiers, verif_performance) and known licenses (snps_vcs_runtime)
live in config.js as seed labeling metadata.

---

## 12. Build order
1. shared/{queries,reasons,types,eta-core}.js (pure, unit-tested).
2. server/slurm/mock.js + adapter factory -> pipeline working offline first.
3. server/db.js + services/queue.js + routes.js + Fastify bootstrap. Verify vs mock.
4. services/diagnostics.js (reason classifier + fan-out detector) with a logjam fixture.
5. services/collector.js + bucket_stats rollup + services/eta.js heuristic.
6. server/slurm/cli.js (SSH ControlMaster) - validate vs a real login node, read-only.
7. web dashboard (pressure -> watchlist -> diagnostics).
8. mcp server + tools; register in OpenCode.
9. server/slurm/restd.js and v2 simulation estimator (stretch).

## 13. Testing & safety
- Unit-test all shared pure functions (time parsing, percentile, queue-ahead, reason classify).
- Integration-test services vs mock fixtures (logjam, license-bound, held priority=0).
- CI guard: assert no path calls scancel/scontrol update/sbatch/salloc/srun while
  ENABLE_ACTIONS=false.
- Rate-limit/coalesce all controller-facing calls; circuit-breaker if squeue latency spikes.

---

## 14. Grounding & references
- SysDocs "Why my slurm Jobs are not moving forward?" - fan-out srun logjam, the bucket recipe
  (Priority|PendingTime|Account|UserName|Reason), REASON definitions, priority=0=held.
  https://sifive.atlassian.net/wiki/spaces/SysDocs/pages/4414537834
- SysDocs "SLURM - view the queue" - keephdr/colpipe, --me -t PD, -A ACCT_LIST, -O FMT for
  WCKey/WorkDir, --sort=j, controller-load filtering.
  https://sifive.atlassian.net/wiki/spaces/SysDocs/pages/3216769038
- SysDocs "SLURM" - clusters/partitions, priority formula, PriorityWeightFairshare=50000,
  PriorityWeightQOS=2000, PriorityWeightTRES license/snps_vcs_runtime, waitlist aliases, backfill.
  https://sifive.atlassian.net/wiki/spaces/SysDocs/pages/42023784
- SysDocs "SLURM - Understanding FairShare" - sshare, sprio, fairshare only orders pending.
  https://sifive.atlassian.net/wiki/spaces/SysDocs/pages/3254190186
- devops-utils slurmreq (SLURMREQ_LABEL), keephdr, colpipe. https://github.com/sifive/devops-utils
- sysval_reports scripts/slurm_predictor.py, run_slurm_prediction.sh, html_report_generator.py -
  prior art: squeue/sacct collection, Jenkins correlation, wait-time stats, per-pattern ETA, HTML
  report, 30-day history. Reuse its modeling logic. https://github.com/sifive/sysval_reports
- federation tools/slurm-tools (slurm.py, salloc_copy.py) + tools/firesim/fire-watcher -
  squeue --json, scontrol show job --json, WCKey/WorkDir/Comment parsing patterns.
- Jenkins job-name <-> Slurm job mapping (JENKINS.SLURM.VERIF.FPGA.HAPS100.*) to correlate queue
  entries back to Jenkins builds.
