# QueuePilot

Triage and understand **queue pressure** on the SiFive Slurm/Jenkins EDA job farm.

QueuePilot is a self-contained Node.js stack that lets engineers:
- monitor their **pending jobs of interest** (by user, account, WCKey, WorkDir, name, or job id),
- **diagnose** why pending jobs are stuck (Priority / Resources / Licenses / Dependency / QOS /
  Partition / Association / held), including the regression **fan-out `srun` logjam** pattern,
- see overall **queue pressure** per account and partition, and
- get an **estimated time-to-start / time-to-completion** modeled against live queue traffic.

It ships with a **Web UI**, a **REST + WebSocket API**, and an **MCP server** so AI agents
(OpenCode) can query the queue too.

## Layout
- `packages/shared` - Slurm query strings, REASON taxonomy, types, ETA core math
- `packages/server` - Fastify API, Slurm adapter (cli/restd/mock), SQLite history, services
- `packages/mcp`    - MCP server exposing the services as tools
- `packages/web`    - Vite + React dashboard
- `docs`            - architecture, Slurm query recipes, ETA notes, workflow references

## Reference docs
- `docs/SLURM-QUERIES.md` - exact read-only Slurm commands the app uses
- `docs/REGRESSION-SLURM-JOB-TRIAGE-WORKFLOW.md` - monitoring workflow for stalled regression jobs

## Quick start (offline, mock data)
```
cp .env.example .env
npm install
npm run dev          # starts the API with SLURM_ADAPTER=mock
npm run dev:web      # in another shell - the dashboard
```
Point at a real farm by setting `SLURM_ADAPTER=cli` and `SLURM_SSH_HOST=<login node>` (read-only).

## For the implementing agent
Read **AGENTS.md** first - it is the authoritative build spec, with the exact Slurm commands,
data model, diagnostics rules, and ETA methodology, all grounded in SiFive docs.
