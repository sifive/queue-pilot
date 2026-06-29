// Fixture adapter for offline dev/tests. Includes a license-bound bucket, a held priority=0 job,
// and a fan-out srun child (JobAA) sitting behind the pending queue for a running parent (JobA).
import { config } from "../config.js";

const NOW = () => Math.floor(Date.now() / 1000);
const flow = "federation-pull-requests-Base-Tests/7748";
const wd = `/scratch/jenkins/archived-builds/${flow}/builds`;

const JOBS = [
  { jobId: "60000001", name: "JobA-parent-runner", user: "jenkins-verif", account: "verif_performance",
    partition: "standard_scl", state: "R", reason: "None", priority: 4294967293, pendingSeconds: 0,
    elapsedSeconds: 6200, timelimitSeconds: 86400, reqCpus: 8, reqMem: "16G",
    wckey: `:${flow}/`, workdir: `${wd}/g5soc_sim/parent`, nodelist: "omega101" },
  { jobId: "60000042", name: "alu", user: "jenkins-verif", account: "verif_performance",
    partition: "standard_scl", state: "PD", reason: "Licenses", priority: 0.0000029, pendingSeconds: 4394,
    elapsedSeconds: 0, timelimitSeconds: 1800, reqCpus: 1, reqMem: "8G",
    wckey: `:${flow}/`, workdir: `${wd}/g5soc_sim/torture/alu`, nodelist: "" },
  { jobId: "60000043", name: "branch", user: "jenkins-verif", account: "verif_performance",
    partition: "standard_scl", state: "PD", reason: "Licenses", priority: 0.0000029, pendingSeconds: 4393,
    elapsedSeconds: 0, timelimitSeconds: 1800, reqCpus: 1, reqMem: "8G",
    wckey: `:${flow}/`, workdir: `${wd}/g5soc_sim/torture/branch`, nodelist: "" },
  { jobId: "60000099", name: "wake-slurm-runner", user: "jenkins", account: "fed_ci",
    partition: "random_sp", state: "PD", reason: "Priority", priority: 0.99999, pendingSeconds: 16,
    elapsedSeconds: 0, timelimitSeconds: 3300, reqCpus: 1, reqMem: "8G",
    wckey: ":pre-merge-v2/", workdir: "/scratch/jenkins/archived-builds/nightly/x", nodelist: "" },
  { jobId: "60000500", name: "held-job", user: "dbone", account: "rtl_bulk",
    partition: "redhat", state: "PD", reason: "launch failed requeued held", priority: 0,
    pendingSeconds: 174251, elapsedSeconds: 0, timelimitSeconds: 3600, reqCpus: 1, reqMem: "8G",
    wckey: "", workdir: "/scratch/jenkins/x", nodelist: "" },
];

export class MockAdapter {
  async listJobs({ states = "PD,R" } = {}) {
    const want = new Set(states.split(",").map((s) => s.trim()));
    return JOBS.filter((j) => want.has(j.state)).map((j) => ({ ...j, cluster: config.defaultCluster }));
  }
  async pending() { return (await this.listJobs({ states: "PD" })); }
  async jobDetail({ jobId }) { return JOBS.find((j) => j.jobId === String(jobId)) || {}; }
  async history() {
    // synthetic finished samples so bucket_stats/ETA has something to chew on.
    const base = NOW() - 3600;
    return Array.from({ length: 30 }, (_, i) => ({
      jobId: `5${i}`, cluster: config.defaultCluster, name: "alu", user: "jenkins-verif",
      account: "verif_performance", partition: "standard_scl", finalState: "COMPLETED",
      submit: base, start: base + 1200 + i * 30, end: base + 1200 + i * 30 + 900,
      waitSeconds: 1200 + i * 30, elapsedSeconds: 900, timelimitSeconds: 1800, reqCpus: 1,
      wckey: `:${flow}/`, workdir: `${wd}/g5soc_sim/torture/alu`,
    }));
  }
  async fairshareAccounts() { return ["verif_performance", "verif", "verif_bulk"]; }
  clusters() { return config.clusters; }
}
