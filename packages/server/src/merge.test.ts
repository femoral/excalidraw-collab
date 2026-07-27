import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectReferencedFileIds,
  formatMergeCommitMessage,
  MERGE_WORKER_DISABLED_MESSAGE,
  parseMergeQuery,
} from "./merge.js";

test("parseMergeQuery accepts common truthy forms", () => {
  assert.equal(parseMergeQuery(undefined), false);
  assert.equal(parseMergeQuery(""), false);
  assert.equal(parseMergeQuery("false"), false);
  assert.equal(parseMergeQuery("0"), false);
  assert.equal(parseMergeQuery("true"), true);
  assert.equal(parseMergeQuery("TRUE"), true);
  assert.equal(parseMergeQuery("1"), true);
  assert.equal(parseMergeQuery("yes"), true);
  assert.equal(parseMergeQuery("on"), true);
  assert.equal(parseMergeQuery(true), true);
  assert.equal(parseMergeQuery(1), true);
});

test("formatMergeCommitMessage records both parents", () => {
  assert.equal(
    formatMergeCommitMessage("added queue", 2, 4),
    "added queue [merge: parents v2+v4]",
  );
  assert.equal(
    formatMergeCommitMessage("  spaced  ", 0, 1),
    "spaced [merge: parents v0+v1]",
  );
});

test("collectReferencedFileIds reads public fileId only", () => {
  assert.deepEqual(
    collectReferencedFileIds([
      { id: "a", type: "rectangle" },
      { id: "b", type: "image", fileId: "abc123" },
      { id: "c", type: "image", fileId: "def456" },
      { id: "d", type: "image", fileId: "abc123" },
      null,
      "skip",
    ]),
    ["abc123", "def456"],
  );
});

test("MERGE_WORKER_DISABLED_MESSAGE is actionable", () => {
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /RENDER_WORKER=on/);
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /--force|pull/i);
  assert.match(MERGE_WORKER_DISABLED_MESSAGE, /Hand-rolled merge/i);
});
