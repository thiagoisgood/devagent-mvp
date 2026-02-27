import { test } from "node:test";
import assert from "node:assert";
import { add } from "../sandbox/mathUtils.js";

test("add should return a + b", () => {
  const result = add(2, 3);
  assert.strictEqual(result, 5);
});
