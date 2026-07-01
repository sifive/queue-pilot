import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { MockAdapter } from "../src/slurm/mock.js";
import {
  DIAGNOSTICS_ARTIFACT_VERSION,
  buildDiagnosticsDataset,
  buildDiagnosticsView,
  detectFanoutLogjam,
  diagnoseJob,
  getOrBuildDiagnosticsArtifact,
  parseDependencyIds,
} from "../src/services/diagnostics.js";

function openDiagnosticsCacheDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE diagnostics_cache(
      cluster TEXT PRIMARY KEY,
      snapshot_id INTEGER NOT NULL,
      version TEXT NOT NULL,
      built_at INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      graph_json TEXT NOT NULL,
      jobs_json TEXT NOT NULL
    );
  `);
  return db;
}

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

test("graph payloads are sampled with explicit count fields", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  jobs.push(
    ...Array.from({ length: 12 }).map((_, index) => ({
      jobId: `7100${index}`,
      cluster: jobs[0].cluster,
      name: `sample-${index}`,
      user: "jenkins-verif",
      account: "verif_bulk",
      partition: "standard_scl",
      state: "R",
      reason: "",
      priority: 100,
      pendingSeconds: 0,
      elapsedSeconds: 100 + index,
      timelimitSeconds: 3600,
      reqCpus: 1,
      reqMem: "4G",
      wckey: ":federation-pull-requests-Base-Tests/7748/",
      workdir: `/scratch/jenkins/archived-builds/federation/builds/sample-${index}`,
      nodelist: "",
      dependency: "",
    }))
  );

  const logjamView = buildDiagnosticsView(jobs, { section: "logjams", sampleLimit: 99 });
  const [group] = logjamView.data.items;

  assert.ok(group.runningParentCount >= group.runningParents.length);
  assert.ok(group.originParentCount >= group.originParents.length);
  assert.ok(group.runningParents.length <= 8);
  assert.ok(group.originParents.length <= 8);
  assert.ok(group.children.length <= 8);
});

test("logjam view scopes external queue pressure to the same account", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  jobs.push(
    {
      jobId: "70000001",
      cluster: jobs[0].cluster,
      name: "other-flow-ahead-1",
      user: "jenkins-verif",
      account: "verif_performance",
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
      account: "verif_performance",
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
    },
    {
      jobId: "70000003",
      cluster: jobs[0].cluster,
      name: "other-account-ahead",
      user: "jenkins-verif",
      account: "verif_bulk",
      partition: "standard_scl",
      state: "PD",
      reason: "Priority",
      priority: 9500,
      pendingSeconds: 1500,
      elapsedSeconds: 0,
      timelimitSeconds: 3600,
      reqCpus: 1,
      reqMem: "4G",
      wckey: ":other-account-flow/",
      workdir: "/scratch/jenkins/archived-builds/other-account-flow/builds/run-c",
      nodelist: "",
      dependency: "",
    }
  );

  const logjamView = buildDiagnosticsView(jobs, { section: "logjams", sampleLimit: 6 });
  const [logjam] = logjamView.data.items;
  const [accountScope] = logjam.accountScopes;

  assert.equal(logjam.externalQueuePressure.account, "verif_performance");
  assert.equal(logjam.externalQueuePressure.aheadJobs, 2);
  assert.equal(logjam.externalQueuePressure.externalFlows, 2);
  assert.ok(logjam.externalQueuePressure.drainHours > 0);
  assert.ok(logjam.maxElapsedHours > 0);
  assert.equal(logjam.runningParents[0].externalQueuePressure.account, "verif_performance");
  assert.equal(logjam.runningParents[0].externalQueuePressure.aheadJobs, 2);
  assert.equal(accountScope.account, "verif_performance");
  assert.equal(accountScope.externalQueuePressure.aheadJobs, 2);
  assert.ok(accountScope.externalQueuePressure.topFlows.every((flow) => flow.account === "verif_performance"));
  assert.match(logjam.message, /same-account/);
});

test("snapshot-keyed diagnostics artifact cache persists and invalidates by snapshot id", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });
  const db = openDiagnosticsCacheDb();

  const artifact1 = await getOrBuildDiagnosticsArtifact({
    db,
    cluster: "compute1",
    snapshot: { id: 101 },
    jobs,
  });
  assert.equal(artifact1.version, DIAGNOSTICS_ARTIFACT_VERSION);
  assert.equal(artifact1.summary.totalJobs, jobs.length);

  const cachedRow = db.prepare("SELECT snapshot_id, version FROM diagnostics_cache WHERE cluster='compute1'").get();
  assert.equal(cachedRow.snapshot_id, 101);
  assert.equal(cachedRow.version, DIAGNOSTICS_ARTIFACT_VERSION);

  const artifactSameSnapshot = await getOrBuildDiagnosticsArtifact({
    db,
    cluster: "compute1",
    snapshot: { id: 101 },
    jobs: [],
  });
  assert.equal(artifactSameSnapshot.summary.totalJobs, jobs.length);

  const artifactNewSnapshot = await getOrBuildDiagnosticsArtifact({
    db,
    cluster: "compute1",
    snapshot: { id: 102 },
    jobs: [],
  });
  assert.equal(artifactNewSnapshot.summary.totalJobs, 0);
  const updatedRow = db.prepare("SELECT snapshot_id FROM diagnostics_cache WHERE cluster='compute1'").get();
  assert.equal(updatedRow.snapshot_id, 102);
});
