import test from "node:test";
import assert from "node:assert/strict";

import { MockAdapter } from "../src/slurm/mock.js";
import { buildDiagnosticsArtifact } from "../src/services/diagnostics.js";
import { summarizeBlockedRunners } from "../src/services/queue.js";

test("blocked runner summary counts blocked parent runs per account", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  jobs.push({
    jobId: "60000044",
    cluster: jobs[0].cluster,
    name: "active-dispatched-runner",
    user: "jenkins-verif",
    account: "verif_performance",
    partition: "standard_scl",
    state: "R",
    reason: "",
    priority: 4294967001,
    pendingSeconds: 0,
    elapsedSeconds: 600,
    timelimitSeconds: 3600,
    reqCpus: 1,
    reqMem: "4G",
    wckey: ":federation-pull-requests-Base-Tests/7748/",
    workdir: "/scratch/jenkins/archived-builds/federation-pull-requests-Base-Tests/7748/builds/runner-child",
    nodelist: "omega155",
    dependency: "afterok:60000001",
  });

  const artifact = buildDiagnosticsArtifact(jobs);
  const byAccount = summarizeBlockedRunners(artifact);

  assert.deepEqual(byAccount.verif_performance, { blockedRunners: 0, totalParentRunners: 2 });
  assert.deepEqual(byAccount.verif_tools, { blockedRunners: 0, totalParentRunners: 1 });
});
