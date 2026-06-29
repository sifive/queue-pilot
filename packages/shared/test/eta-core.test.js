import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSlurmTime,
  percentile,
  queuePositionWaitSeconds,
  estimateStartSeconds,
  estimateFinishSeconds,
  confidenceFor,
} from "../src/eta-core.js";

test("parseSlurmTime handles day and hour formats", () => {
  assert.equal(parseSlurmTime("1-02:03:04"), 93784);
  assert.equal(parseSlurmTime("02:03:04"), 7384);
  assert.equal(parseSlurmTime("03:04"), 184);
  assert.equal(parseSlurmTime("INVALID"), 0);
});

test("percentile and queue-based helpers produce stable ETA math", () => {
  assert.equal(percentile([10, 30, 20, 40], 0.5), 20);
  assert.equal(queuePositionWaitSeconds(12, 6), 120);
  assert.equal(estimateStartSeconds({ histP50Wait: 300, queueWait: 120, wHist: 0.25 }), 165);
  assert.equal(estimateFinishSeconds({ etaStartSeconds: 165, expectedRuntime: 600, timelimit: 500 }), 665);
});

test("confidence increases with sample size and deterministic reasons", () => {
  assert.equal(confidenceFor({ n: 0, category: "other" }), 0.05);
  assert.equal(confidenceFor({ n: 50, category: "priority" }), 0.8);
});
