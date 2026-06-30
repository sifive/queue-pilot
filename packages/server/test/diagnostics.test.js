import test from "node:test";
import assert from "node:assert/strict";

import { MockAdapter } from "../src/slurm/mock.js";
import { buildDiagnosticsDataset, buildDiagnosticsView, detectFanoutLogjam, diagnoseJob, parseDependencyIds } from "../src/services/diagnostics.js";

test("fan-out detector finds pending children behind a running parent", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });

  const logjams = detectFanoutLogjam(jobs);

  assert.equal(logjams.length, 1);
  assert.equal(logjams[0].parentJobId, "60000001");
  assert.equal(logjams[0].blockedChildren, 2);
  assert.deepEqual(logjams[0].reasonMix, { licenses: 2 });
  assert.deepEqual(logjams[0].originParentIds, ["60000001", "60000002"]);
});

test("diagnoseJob flags held and license-bound jobs", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  const held = jobs.find((job) => job.jobId === "60000500");
  const license = jobs.find((job) => job.jobId === "60000042");

  const heldDiagnosis = diagnoseJob(held);
  const licenseDiagnosis = diagnoseJob(license);

  assert.equal(heldDiagnosis.held, true);
  assert.ok(heldDiagnosis.findings.some((finding) => finding.type === "held"));
  assert.equal(licenseDiagnosis.category, "licenses");
  assert.ok(licenseDiagnosis.findings.some((finding) => finding.type === "license_bound"));
});

test("dependency strings are parsed into parent ids", () => {
  assert.deepEqual(parseDependencyIds("afterok:60000110,afterany:60000111:60000112"), ["60000110", "60000111", "60000112"]);
  assert.deepEqual(parseDependencyIds(""), []);
});

test("diagnostics dataset groups jobs by flow and exposes blockers", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });

  const triage = buildDiagnosticsDataset(jobs);
  const dependentJob = triage.jobs.find((job) => job.jobId === "60000111");
  const flowGroup = triage.pending.groups.find((group) => group.flowKey === ":federation-pull-requests-Base-Tests/7748/");

  assert.equal(triage.summary.pendingCount, 5);
  assert.equal(triage.summary.runningCount, 3);
  assert.deepEqual(dependentJob.blockerIds, ["60000110"]);
  assert.equal(dependentJob.blockerSource, "dependency");
  assert.equal(flowGroup.pendingCount, 2);
  assert.deepEqual(flowGroup.originParentIds, ["60000001", "60000002"]);
});

test("logjam view annotates external queue pressure from other flows", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  jobs.push(
    {
      jobId: "70000001",
      cluster: jobs[0].cluster,
      name: "other-flow-ahead-1",
      user: "jenkins-verif",
      account: "verif_bulk",
      partition: "standard_scl",
      state: "PD",
      reason: "Priority",
      priority: 8000,
      pendingSeconds: 1200,
      elapsedSeconds: 0,
      timelimitSeconds: 3600,
      reqCpus: 1,
      reqMem: "4G",
      wckey: ":other-flow-a/",
      workdir: "/scratch/jenkins/archived-builds/other-flow-a/builds/run-a",
      nodelist: "",
      dependency: "",
    },
    {
      jobId: "70000002",
      cluster: jobs[0].cluster,
      name: "other-flow-ahead-2",
      user: "jenkins-verif",
      account: "verif_bulk",
      partition: "standard_scl",
      state: "PD",
      reason: "Priority",
      priority: 7000,
      pendingSeconds: 900,
      elapsedSeconds: 0,
      timelimitSeconds: 3600,
      reqCpus: 1,
      reqMem: "4G",
      wckey: ":other-flow-b/",
      workdir: "/scratch/jenkins/archived-builds/other-flow-b/builds/run-b",
      nodelist: "",
      dependency: "",
    }
  );

  const logjamView = buildDiagnosticsView(jobs, { section: "logjams", sampleLimit: 6 });
  const [logjam] = logjamView.data.items;

  assert.equal(logjam.externalQueuePressure.aheadJobs, 3);
  assert.equal(logjam.externalQueuePressure.externalFlows, 3);
  assert.ok(logjam.externalQueuePressure.drainHours > 0);
  assert.equal(logjam.runningParents[0].externalQueuePressure.aheadJobs, 3);
  assert.match(logjam.message, /higher-priority job\(s\) from other flows ahead in queue/);
});
