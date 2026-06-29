# @queuepilot/mcp
Read-only MCP server exposing QueuePilot's queue-triage tools to AI agents (OpenCode).

Run: `QUEUEPILOT_URL=http://localhost:8080 npx queuepilot-mcp` (stdio).

OpenCode registration (example):
```
{ "mcpServers": { "queuepilot": { "command": "npx", "args": ["queuepilot-mcp"],
  "env": { "QUEUEPILOT_URL": "http://localhost:8080" } } } }
```
Tools: queue_pressure_summary, list_pending_jobs, diagnose_job, diagnose_flow,
estimate_completion, watch_add, watch_list, watch_status.
