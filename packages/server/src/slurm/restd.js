// Read-only slurmrestd HTTP adapter. Normalize REST job objects into the Job shape used elsewhere.
import { config } from "../config.js";
import { parseSlurmTime } from "@queuepilot/shared";

export class RestdAdapter {
  base() { return `${config.restd.url}/slurm/${config.restd.apiVersion}`; }
  dbBase() { return `${config.restd.url}/slurmdb/${config.restd.apiVersion}`; }
  headers() {
    const t = process.env.SLURM_USER_TOKEN || "";
    return t ? { "X-SLURM-USER-TOKEN": t } : {};
  }
  async listJobs({ cluster = config.defaultCluster } = {}) {
    const res = await fetch(`${this.base()}/jobs`, { headers: this.headers() });
    const data = await res.json();
    return (data.jobs || []).map((j) => this.norm(j, cluster));
  }
  norm(j, cluster) {
    return {
      jobId: String(j.job_id), cluster, name: j.name, user: j.user_name, account: j.account,
      partition: j.partition, state: Array.isArray(j.job_state) ? j.job_state[0] : j.job_state,
      reason: j.state_reason, priority: Number(j.priority?.number ?? j.priority ?? 0),
      pendingSeconds: 0, elapsedSeconds: 0,
      timelimitSeconds: parseSlurmTime(j.time_limit?.number ? String(j.time_limit.number) : ""),
      reqCpus: j.cpus?.number ?? 1, reqMem: String(j.memory_per_node?.number ?? ""),
      wckey: j.wckey, workdir: j.current_working_directory, nodelist: j.nodes,
    };
  }
  async pending(args) { return (await this.listJobs(args)).filter((j) => /PENDING|PD/i.test(j.state)); }
  async jobDetail({ jobId }) {
    const res = await fetch(`${this.base()}/job/${jobId}`, { headers: this.headers() });
    return (await res.json())?.jobs?.[0] || {};
  }
  async history() { return []; } // TODO: GET /slurmdb/<v>/jobs with filters.
  async fairshareAccounts() { return []; }
  clusters() { return config.clusters; }
}
