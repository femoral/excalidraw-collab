import assert from "node:assert/strict";
import { test } from "node:test";
import { packageName } from "./index.js";

test("packageName returns server", () => {
  assert.equal(packageName(), "server");
});
