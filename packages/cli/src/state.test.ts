/**
 * Local state unit tests — never touch the real repo root or home config.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  emptyLocalState,
  getPulledVersion,
  normalizeServerKey,
  readLocalState,
  setPulledVersion,
  statePath,
  writeLocalState,
} from "./state.js";

const tempDirs: string[] = [];

function tempCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excali-state-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

test("normalizeServerKey strips trailing slashes", () => {
  assert.equal(normalizeServerKey("http://h/"), "http://h");
  assert.equal(normalizeServerKey("http://h///"), "http://h");
  assert.equal(normalizeServerKey("http://h"), "http://h");
});

test("missing state file yields empty state", () => {
  const cwd = tempCwd();
  assert.deepEqual(readLocalState(cwd), emptyLocalState());
  assert.equal(getPulledVersion(cwd, "http://a", "arch"), undefined);
});

test("setPulledVersion persists and getPulledVersion reads it", () => {
  const cwd = tempCwd();
  setPulledVersion(cwd, "http://example.test/", "arch", 3);
  assert.equal(getPulledVersion(cwd, "http://example.test", "arch"), 3);
  assert.equal(getPulledVersion(cwd, "http://example.test/", "arch"), 3);

  const onDisk = JSON.parse(fs.readFileSync(statePath(cwd), "utf8")) as {
    servers: Record<string, { scenes: Record<string, { version: number }> }>;
  };
  assert.equal(onDisk.servers["http://example.test"]!.scenes["arch"]!.version, 3);
});

test("same slug on two servers does not clobber", () => {
  const cwd = tempCwd();
  setPulledVersion(cwd, "http://server-a", "arch", 5);
  setPulledVersion(cwd, "http://server-b", "arch", 1);

  assert.equal(getPulledVersion(cwd, "http://server-a", "arch"), 5);
  assert.equal(getPulledVersion(cwd, "http://server-b", "arch"), 1);

  // Update B only
  setPulledVersion(cwd, "http://server-b", "arch", 2);
  assert.equal(getPulledVersion(cwd, "http://server-a", "arch"), 5);
  assert.equal(getPulledVersion(cwd, "http://server-b", "arch"), 2);
});

test("writeLocalState creates .excalidraw-collab/state.json under cwd", () => {
  const cwd = tempCwd();
  const file = writeLocalState(cwd, {
    version: 1,
    servers: {
      "http://s": { scenes: { x: { version: 0 } } },
    },
  });
  assert.equal(file, statePath(cwd));
  assert.ok(file.startsWith(cwd));
  assert.match(file, /\.excalidraw-collab[/\\]state\.json$/);
  assert.ok(fs.existsSync(file));
});
