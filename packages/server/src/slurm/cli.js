// Read-only shell-out adapter. Runs Slurm binaries locally or over a persistent SSH connection.
// Guardrail: only squeue/sacct/sshare/sprio/scontrol-show are allowed here.
import { spawn } from "node:child_process";
import { config } from "../config.js";
import {
  squeuePending, squeueJobs, scontrolShowJob, sacctHistory, sshareAccounts,
  parsePipeLine, PENDING_FIELDS, JOB_FIELDS,
} from "@queuepilot/shared";
import { normalizeHistoryRow, normalizeJob } from "./normalize.js";

const ALLOWED = new Set(["squeue", "sacct", "sshare", "sprio", "scontrol"]);
const SACCT_FIELDS = [
  "JobID", "JobName", "User", "Account", "Partition", "State", "Submit",
  "Start", "End", "Elapsed", "Timelimit", "ReqCPUS", "ReqMem", "WCKey", "WorkDir",
];

function run(bin, args) {
  if (!ALLOWED.has(bin)) throw new Error(`blocked binary: ${bin}`);
  let cmd = bin, cmdArgs = args;
  if (config.ssh.host) {
    // Persistent connection recommended: configure ControlMaster in ~/.ssh/config for the host.
    const target = config.ssh.user ? `${config.ssh.user}@${config.ssh.host}` : config.ssh.host;
    cmd = "ssh";
    cmdArgs = ["-o", "BatchMode=yes", target, [bin, ...args].map(shq).join(" ")];
  }
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

export class CliAdapter {
  async listJobs({ cluster = config.defaultCluster, states = "PD,R", account, user, partition } = {}) {
    const out = await run("squeue", squeueJobs({ cluster, states, account, user, partition }));
    return out.split("\n").filter(Boolean).map((l) => normalizeJob(parsePipeLine(l, JOB_FIELDS), cluster));
  }
  async pending({ cluster = config.defaultCluster, account, user } = {}) {
    const out = await run("squeue", squeuePending({ cluster, account, user }));
    return out.split("\n").filter(Boolean).map((l) => parsePipeLine(l, PENDING_FIELDS));
  }
  async jobDetail({ cluster = config.defaultCluster, jobId }) {
    const out = await run("scontrol", scontrolShowJob({ cluster, jobId }));
    const j = JSON.parse(out)?.jobs?.[0] || {};
    return normalizeJob(j, cluster);
  }
  async history({ cluster = config.defaultCluster, startTime } = {}) {
    const out = await run("sacct", sacctHistory({ cluster, startTime }));
    return out.split("\n").filter(Boolean).map((l) => normalizeHistoryRow(parsePipeLine(l, SACCT_FIELDS), cluster));
  }
  async fairshareAccounts({ cluster = config.defaultCluster, user }) {
    const out = await run("sshare", sshareAccounts({ cluster, user }));
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  clusters() { return config.clusters; }
}
