# Queue Pilot

Queue Pilot is a Node.js workspace for inspecting queue pressure on the SiFive Slurm/Jenkins EDA
farm. Today it is primarily a read-heavy triage tool: it helps engineers understand why jobs are
pending, where regression flows are logjammed, and which parents or external flows are blocking
progress. Queue-management functions are planned later, but mutating Slurm actions are currently
gated off behind `ENABLE_ACTIONS=false`.

It ships with:

- a React web dashboard
- a Fastify REST API backed by cached Slurm snapshots in SQLite
- an MCP server so agents can query the same diagnostics surfaces

## What It Does Today

- Summarizes queue pressure by account and partition.
- Splits diagnostics into focused views for `logjams`, `pending`, `running`, and `control plane`
  traffic.
- Groups jobs by flow, WCKey, and workdir root so related runs can be traced together.
- Surfaces fan-out `srun` logjams where running parent flows are waiting on re-queued children.
- Annotates logjams with external queue pressure: higher-priority jobs from other flows ahead in
  the same scheduling lane and an estimated drain latency.
- Provides watchlist matching for jobs of interest by user, account, WCKey, workdir, name, or job
  id.
- Estimates ETA-to-start / ETA-to-finish from historical bucket statistics and live queue shape.

## Current UI

The web app currently exposes these pages:

- `Pressure`: account and partition hotspot summary from the latest collector snapshot.
- `Logjams`: grouped D3 graph view of blocked flows, origin parents, active runners, external
  queue pressure, and blocked reason buckets.
- `Control Plane`: isolates `/root` and nullish orchestration flows from normal verification
  traffic.
- `Pending`: aggregated graph or list view of waiting jobs, with WCKey grouping, parent blockers,
  and clickable workdir links.
- `Running`: aggregated graph or list view of active jobs by flow and WCKey.
- `Watchlist`: saved matchers with diagnosis and ETA context.

## Repo Layout

- `packages/shared` - REASON taxonomy, ETA math, shared types and helpers
- `packages/server` - Fastify API, Slurm adapters, collector, diagnostics, watchlist, SQLite
- `packages/mcp` - MCP server exposing queue diagnostics tools over stdio
- `packages/web` - Vite + React dashboard
- `docs` - architecture notes, Slurm query recipes, ETA notes, triage workflow references
- `AGENTS.md` - authoritative implementation spec and operating manual for this repo

## Runtime Model

- Slurm access is transport-agnostic: `cli`, `restd`, or `mock`.
- The diagnostics endpoints read from the latest cached snapshot when available instead of hitting
  live Slurm on every page refresh.
- SQLite stores snapshots and historical rollups used by the ETA heuristic.
- Queue actions are not implemented in the shipped code paths today; `ENABLE_ACTIONS` remains a
  safety gate for future work.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Common settings:

- `SLURM_ADAPTER=mock` for offline development
- `SLURM_ADAPTER=cli` for live reads via local Slurm commands or SSH
- `SLURM_SSH_HOST`, `SLURM_SSH_USER`, `SLURM_SSH_KEY` when reading through a login node
- `DB_PATH` to control where the SQLite snapshot cache is stored
- `ENABLE_ACTIONS=false` to keep all Slurm access read-only

### 3. Run with mock data

In one shell:

```bash
npm run dev:mock
```

In another shell:

```bash
npm run dev:web
```

Optional MCP server:

```bash
npm run dev:mcp
```

### 4. Run against a real Slurm environment

Set the adapter and connection details in `.env`, then start the server and web app:

```bash
npm run dev
```

```bash
npm run dev:web
```

The server defaults to port `8080`.

## Main API Surfaces

- `GET /api/clusters`
- `GET /api/pressure`
- `GET /api/diagnose`
- `GET /api/jobs/:id`
- `GET /api/eta/:id`
- `GET|POST|DELETE /api/watch`
- `GET /api/watch/:id/status`

The `diagnose` endpoint powers the page-specific views and supports:

- `section=summary|logjams|control|pending|running`
- `view=graph|list` for pending/running
- `search=...` for job ids, WCKeys, blockers, users, accounts, and workdirs

## Verification

Run the shipped tests:

```bash
npm test
```

Build the web app:

```bash
npm run build
```

## Reference Docs

- [docs/SLURM-QUERIES.md](docs/SLURM-QUERIES.md) - exact read-only Slurm commands used by the app
- [docs/REGRESSION-SLURM-JOB-TRIAGE-WORKFLOW.md](docs/REGRESSION-SLURM-JOB-TRIAGE-WORKFLOW.md) -
  reference workflow for stalled regression jobs
- [docs/ETA-MODEL.md](docs/ETA-MODEL.md) - ETA heuristic notes and caveats
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - service and transport overview

## For Implementers

Read [AGENTS.md](AGENTS.md) first. It is the authoritative spec for the Slurm queries,
diagnostics rules, ETA methodology, watchlist behavior, and safety constraints in this repo.
