const env = process.env;
export const config = {
  port: Number(env.PORT || 8080),
  adapter: env.SLURM_ADAPTER || "cli",
  clusters: (env.SLURM_CLUSTERS || "compute1,testbed,primo").split(",").map((s) => s.trim()),
  defaultCluster: env.SLURM_DEFAULT_CLUSTER || "compute1",
  ssh: { host: env.SLURM_SSH_HOST || "", user: env.SLURM_SSH_USER || "" },
  restd: { url: env.SLURMRESTD_URL || "", apiVersion: env.SLURMRESTD_API_VERSION || "v0.0.42" },
  pollSeconds: Math.max(10, Number(env.SLURM_POLL_SECONDS || 30)),
  historyDays: Number(env.HISTORY_RETENTION_DAYS || 30),
  etaModel: env.ETA_MODEL || "heuristic",
  dbPath: env.DB_PATH || "./queuepilot.sqlite",
  ai: { mode: env.AI_NARRATIVE || "off", baseUrl: env.AI_BASE_URL || "", model: env.AI_MODEL || "" },
  enableActions: String(env.ENABLE_ACTIONS || "false") === "true",
};
// Seed labeling metadata (from SiFive docs). Extend as needed.
export const KNOWN_ACCOUNTS = [
  "verif", "verif_bulk", "verif_express", "verif_ci", "verif_agent", "verif_performance",
  "perf", "perf_bulk", "perf_ci", "sw", "sw_ci", "fed_ci", "fed_agent", "rtl", "tools", "release",
  "agent_ci", "default",
];
export const KNOWN_LICENSES = ["snps_vcs_runtime"];
