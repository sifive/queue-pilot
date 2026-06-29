import test from "node:test";
import assert from "node:assert/strict";

import { MockAdapter } from "../src/slurm/mock.js";
import { detectFanoutLogjam, diagnoseJob } from "../src/services/diagnostics.js";

test("fan-out detector finds pending children behind a running parent", async () => {
  const adapter = new MockAdapter();
  const jobs = await adapter.listJobs({ states: "PD,R" });

  const logjams = detectFanoutLogjam(jobs);

  assert.equal(logjams.length, 1);
  assert.equal(logjams[0].parentJobId, "60000001");
  assert.equal(logjams[0].blockedChildren, 2);
  assert.deepEqual(logjams[0].reasonMix, { licenses: 2 });
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
