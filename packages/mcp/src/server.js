#!/usr/bin/env node
// QueuePilot MCP server (read-only). stdio transport; add StreamableHTTP for remote agents.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools.js";

const server = new Server({ name: "queuepilot", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name, description: t.description,
    inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(t.schema).map(([k, v]) => [k, { type: v.startsWith("object") ? "object" : "string" }])) },
    annotations: { readOnlyHint: true },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  try {
    const data = await tool.run(req.params.arguments || {});
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e.message || e) }] };
  }
});

await server.connect(new StdioServerTransport());
console.error("queuepilot-mcp ready (stdio)");
