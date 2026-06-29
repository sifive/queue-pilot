// Read-only slurmrestd HTTP adapter. Normalize REST job objects into the Job shape used elsewhere.
import { config } from "../config.js";
import { normalizeHistoryRow, normalizeJob } from "./normalize.js";

export class RestdAdapter {
  base() { return `${config.restd.url}/slurm/${config.restd.apiVersion}`; }
  dbBase() { return `${config.restd.url}/slurmdb/${config.restd.apiVersion}`; }
  headers() {
    const t = process.env.SLURM_USER_TOKEN || "";
    return t ? { "X-SLURM-USER-TOKEN": t } : {};
  }
  async listJobs({ cluster = config.defaultCluster, states, account, user, partition } = {}) {
    const res = await fetch(`${this.base()}/jobs`, { headers: this.headers() });
    const data = await res.json();
    return (data.jobs || [])
      .map((j) => this.norm(j, cluster))
      .filter((j) => {
        if (states && !states.split(",").map((s) => s.trim()).includes(j.state)) return false;
        if (account && j.account !== account) return false;
        if (user && j.user !== user) return false;
        if (partition && j.partition !== partition) return false;
        return true;
      });
  }
  norm(j, cluster) { return normalizeJob(j, cluster); }
  async pending(args) { return (await this.listJobs(args)).filter((j) => /PENDING|PD/i.test(j.state)); }
  async jobDetail({ cluster = config.defaultCluster, jobId }) {
    const res = await fetch(`${this.base()}/job/${jobId}`, { headers: this.headers() });
    const job = (await res.json())?.jobs?.[0] || {};
    return normalizeJob(job, cluster);
  }
  async history({ cluster = config.defaultCluster, startTime } = {}) {
    const url = new URL(`${this.dbBase()}/jobs`);
    if (cluster) url.searchParams.set("clusters", cluster);
    if (startTime) url.searchParams.set("start_time", startTime);
    const res = await fetch(url, { headers: this.headers() });
    const data = await res.json();
    return (data.jobs || []).map((j) => normalizeHistoryRow(j, cluster));
  }
  async fairshareAccounts() { return []; }
  clusters() { return config.clusters; }
}
