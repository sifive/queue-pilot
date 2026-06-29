import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { makeAdapter } from "./slurm/index.js";
import { registerRoutes } from "./routes.js";
import { startCollector } from "./services/collector.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(websocket);

const db = openDb();
const adapter = makeAdapter();
const ctx = { adapter, db };

registerRoutes(app, ctx);

const sockets = new Set();
app.register(async (f) => {
  f.get("/ws", { websocket: true }, (conn) => {
    sockets.add(conn.socket);
    conn.socket.on("close", () => sockets.delete(conn.socket));
  });
});

startCollector({
  adapter, db,
  onSnapshot: (snap) => {
    const msg = JSON.stringify({ type: "snapshot", cluster: snap.cluster, count: snap.jobs.length });
    for (const s of sockets) { try { s.send(msg); } catch {} }
  },
});

if (config.enableActions) app.log.warn("ENABLE_ACTIONS=true: mutating Slurm calls are gated ON. v1 ships no such code paths.");
app.listen({ port: config.port, host: "0.0.0.0" }).then(() => app.log.info(`QueuePilot on :${config.port} adapter=${config.adapter}`));
