/**
 * Fail the suite when docs/cli.md drifts from generateCliReference().
 * Agents and humans must not hand-edit the committed reference.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  CLI_REF_RELATIVE_PATH,
  generateCliReference,
  resolveMonorepoRoot,
  cliRefPath,
} from "./cli-ref.js";

test("docs/cli.md matches generateCliReference() output", () => {
  const root = resolveMonorepoRoot();
  const path = cliRefPath(root);
  assert.ok(
    fs.existsSync(path),
    `missing ${CLI_REF_RELATIVE_PATH} at ${path}. Run: pnpm --filter @excalidraw-collab/cli generate-cli-ref`,
  );

  const committed = fs.readFileSync(path, "utf8");
  const generated = generateCliReference();

  assert.equal(
    committed,
    generated,
    `${CLI_REF_RELATIVE_PATH} is stale.\n` +
      `Regenerate and commit:\n` +
      `  pnpm --filter @excalidraw-collab/cli generate-cli-ref\n` +
      `  git add ${CLI_REF_RELATIVE_PATH}`,
  );
});

test("generateCliReference lists every registered command", async () => {
  const { listCommands } = await import("./commands.js");
  const md = generateCliReference();
  for (const c of listCommands()) {
    assert.match(
      md,
      new RegExp(`### \\\`${c.name}\\\``),
      `generated reference missing section for command ${c.name}`,
    );
    assert.ok(md.includes(c.description), `generated reference missing description for ${c.name}`);
  }
});
