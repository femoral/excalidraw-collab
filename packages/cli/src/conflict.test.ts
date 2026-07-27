import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatAppStateValue,
  formatConflictDiff,
  formatConflictMessage,
  resolutionCommands,
} from "./conflict.js";

test("resolutionCommands include pull, push, merge, and force", () => {
  const cmds = resolutionCommands("arch", "added queue");
  assert.deepEqual(cmds, [
    "excalicli pull arch",
    'excalicli push arch -m "added queue"',
    'excalicli push arch -m "added queue" --merge',
    'excalicli push arch -m "added queue" --force',
  ]);
});

test("formatConflictDiff renders summary and describe lines", () => {
  const text = formatConflictDiff({
    from: 1,
    to: 3,
    summary: { added: 1, deleted: 0, updated: 1, reordered: 0 },
    elements: [
      {
        op: "add",
        describe: '+ rectangle "Retry Queue"',
      },
      {
        op: "update",
        describe: '~ rectangle "Auth"  moved',
      },
    ],
    appState: [
      { key: "viewBackgroundColor", from: "#fff", to: "#000" },
    ],
  });
  assert.match(text, /v1 → v3/);
  assert.match(text, /\+1/);
  assert.match(text, /~1/);
  assert.match(text, /Retry Queue/);
  assert.match(text, /viewBackgroundColor/);
});

test("formatAppStateValue renders absent keys as (unset), not undefined", () => {
  assert.equal(formatAppStateValue(undefined), "(unset)");
  assert.equal(formatAppStateValue(null), "null");
  assert.equal(formatAppStateValue(false), "false");
  assert.equal(formatAppStateValue("#fff"), '"#fff"');
});

test("formatConflictDiff renders absent appState keys as (unset)", () => {
  const text = formatConflictDiff({
    from: 1,
    to: 2,
    summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
    elements: [],
    appState: [
      { key: "gridModeEnabled", from: false, to: undefined },
      { key: "gridSize", from: null, to: undefined },
      { key: "viewBackgroundColor", from: undefined, to: "#000" },
    ],
  });
  assert.match(text, /gridModeEnabled: false → \(unset\)/);
  assert.match(text, /gridSize: null → \(unset\)/);
  assert.match(text, /viewBackgroundColor: \(unset\) → "#000"/);
  assert.ok(!text.includes("undefined"));
});

test("formatConflictMessage names exact next commands", () => {
  const msg = formatConflictMessage(
    "arch",
    {
      head: 4,
      parentVersion: 2,
      diff: {
        from: 2,
        to: 4,
        summary: { added: 0, deleted: 0, updated: 0, reordered: 0 },
        elements: [],
        appState: [],
      },
    },
    { message: "my edit", serverMessage: "parentVersion 2 does not match head 4" },
  );
  assert.match(msg, /parentVersion 2 does not match head 4/);
  assert.match(msg, /excalicli pull arch/);
  assert.match(msg, /excalicli push arch -m "my edit"/);
  assert.match(msg, /--merge/);
  assert.match(msg, /--force/);
  assert.match(msg, /Nothing was changed on the server/);
});
