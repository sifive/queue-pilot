import test from "node:test";
import assert from "node:assert/strict";

import { classifyReason } from "../src/reasons.js";

test("classifyReason maps common Slurm reasons to categories", () => {
  assert.equal(classifyReason("Priority").category, "priority");
  assert.equal(classifyReason("Licenses").category, "licenses");
  assert.equal(classifyReason("AssociationJobLimit").category, "association");
  assert.equal(classifyReason("ReqNodeNotAvail").category, "node_unavail");
});

test("classifyReason falls back to held when priority is zero", () => {
  const result = classifyReason("SomeUnknownReason", 0);
  assert.equal(result.category, "held");
  assert.match(result.explain, /priority=0/i);
});
