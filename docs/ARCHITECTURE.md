# ARCHITECTURE.md
Transport-agnostic services are the core. REST (Fastify), WebSocket, and MCP all call the same
service functions. The Slurm adapter (cli|restd|mock) is the only thing that touches the farm and
is read-only. SQLite stores snapshots + sacct history; a rollup builds bucket_stats for the ETA
model. See AGENTS.md sec 2-7 for the full design.
