/**
 * `excalicli skills` — bundled skill discovery and installation.
 *
 * Also a packaging tripwire: the skill must ship inside the CLI package and
 * stay resolvable from the built `dist/`, since that is how an installed CLI
 * finds it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "./dispatch.js";
import { ExitCode } from "./errors.js";
import { bundledSkillsDir, listBundledSkills, resolveSkillsDir } from "./skills.js";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "excalicli-skills-"));
}

/** Env with a sandboxed HOME so --scope user never touches the real one. */
function envWithHome(home: string): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
}

test("the excalidraw-collab skill is bundled with the CLI package", () => {
  const dir = bundledSkillsDir();
  assert.ok(
    fs.existsSync(dir),
    `bundled skills directory missing at ${dir} — it must ship in the CLI package`,
  );
  const skills = listBundledSkills();
  const names = skills.map((s) => s.name);
  assert.deepEqual(names, ["excalidraw-collab"]);
  assert.ok(
    skills[0]!.description.length > 0,
    "SKILL.md frontmatter must carry a description (skills trigger on it)",
  );
});

test("SKILL.md links its reference files and they exist", () => {
  const skill = listBundledSkills()[0]!;
  const md = fs.readFileSync(path.join(skill.source, "SKILL.md"), "utf8");
  for (const rel of ["reference/setup.md", "reference/troubleshooting.md"]) {
    assert.ok(
      md.includes(`(${rel})`),
      `SKILL.md must link ${rel} so the agent knows when to read it`,
    );
    assert.ok(fs.existsSync(path.join(skill.source, rel)), `missing bundled file ${rel}`);
  }
});

test("SKILL.md stays short enough to sit in context", () => {
  const skill = listBundledSkills()[0]!;
  const bytes = fs.statSync(path.join(skill.source, "SKILL.md")).size;
  assert.ok(
    bytes < 8000,
    `SKILL.md is ${bytes} bytes — move detail into reference/ to keep it lean`,
  );
});

test("skills ls lists bundled skills", async () => {
  const c = capture();
  const code = await run({ argv: ["skills", "ls", "--json"], io: c.io });
  assert.equal(code, ExitCode.OK);
  const rows = JSON.parse(c.stdout) as { name: string }[];
  assert.deepEqual(
    rows.map((r) => r.name),
    ["excalidraw-collab"],
  );
});

test("skills install defaults to ./.claude/skills in the cwd", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const c = capture();
  const code = await run({
    argv: ["skills", "install", "--json"],
    io: c.io,
    cwd,
    env: envWithHome(home),
  });
  assert.equal(code, ExitCode.OK);

  const data = JSON.parse(c.stdout) as {
    path: string;
    client: string;
    scope: string;
    files: string[];
  };
  assert.equal(data.client, "claude");
  assert.equal(data.scope, "project");
  assert.equal(data.path, path.join(cwd, ".claude", "skills", "excalidraw-collab"));
  assert.ok(fs.existsSync(path.join(data.path, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(data.path, "reference", "setup.md")));
  assert.ok(data.files.includes("reference/troubleshooting.md"));
  // User scope untouched.
  assert.ok(!fs.existsSync(path.join(home, ".claude")));
});

test("--scope user installs under HOME; --client agents uses .agents", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const c = capture();
  const code = await run({
    argv: [
      "skills",
      "install",
      "excalidraw-collab",
      "--scope",
      "user",
      "--client",
      "agents",
      "--json",
    ],
    io: c.io,
    cwd,
    env: envWithHome(home),
  });
  assert.equal(code, ExitCode.OK);
  const data = JSON.parse(c.stdout) as { path: string };
  assert.equal(data.path, path.join(home, ".agents", "skills", "excalidraw-collab"));
  assert.ok(fs.existsSync(path.join(data.path, "SKILL.md")));
});

test("--dir overrides client/scope resolution", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const c = capture();
  const code = await run({
    argv: ["skills", "install", "--dir", "custom/skills", "--json"],
    io: c.io,
    cwd,
    env: envWithHome(home),
  });
  assert.equal(code, ExitCode.OK);
  const data = JSON.parse(c.stdout) as { path: string; client: null };
  assert.equal(data.path, path.join(cwd, "custom", "skills", "excalidraw-collab"));
  assert.equal(data.client, null);
});

test("re-install without --force exits 1; --force overwrites", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const env = envWithHome(home);

  const first = capture();
  assert.equal(await run({ argv: ["skills", "install"], io: first.io, cwd, env }), ExitCode.OK);

  const target = path.join(cwd, ".claude", "skills", "excalidraw-collab");
  const stale = path.join(target, "stale.md");
  fs.writeFileSync(stale, "leftover");

  const second = capture();
  const code = await run({ argv: ["skills", "install"], io: second.io, cwd, env });
  assert.equal(code, ExitCode.ERROR);
  assert.match(second.stderr, /already exists/);
  assert.ok(fs.existsSync(stale), "failed install must not touch the target");

  const third = capture();
  const forced = await run({
    argv: ["skills", "install", "--force", "--json"],
    io: third.io,
    cwd,
    env,
  });
  assert.equal(forced, ExitCode.OK);
  const data = JSON.parse(third.stdout) as { overwrote: boolean };
  assert.equal(data.overwrote, true);
  assert.ok(!fs.existsSync(stale), "--force must replace the directory, not merge into it");
  assert.ok(fs.existsSync(path.join(target, "SKILL.md")));
});

test("--dry-run reports files without writing", async () => {
  const cwd = tempDir();
  const home = tempDir();
  const c = capture();
  const code = await run({
    argv: ["skills", "install", "--dry-run", "--json"],
    io: c.io,
    cwd,
    env: envWithHome(home),
  });
  assert.equal(code, ExitCode.OK);
  const data = JSON.parse(c.stdout) as { dryRun: boolean; files: string[] };
  assert.equal(data.dryRun, true);
  assert.ok(data.files.length > 0);
  assert.ok(!fs.existsSync(path.join(cwd, ".claude")));
});

test("bad subcommand, skill name, client and scope all exit 2", async () => {
  const cwd = tempDir();
  const env = envWithHome(tempDir());
  const cases: string[][] = [
    ["skills"],
    ["skills", "nope"],
    ["skills", "install", "no-such-skill"],
    ["skills", "install", "--client", "emacs"],
    ["skills", "install", "--scope", "everywhere"],
    ["skills", "ls", "excalidraw-collab"],
  ];
  for (const argv of cases) {
    const c = capture();
    const code = await run({ argv, io: c.io, cwd, env });
    assert.equal(code, ExitCode.USAGE, `expected usage error for: ${argv.join(" ")}`);
    assert.notEqual(c.stderr, "");
  }
});

test("resolveSkillsDir maps client/scope to known layouts", () => {
  assert.equal(
    resolveSkillsDir({ client: "claude", scope: "project", cwd: "/w", home: "/h" }),
    path.join("/w", ".claude", "skills"),
  );
  assert.equal(
    resolveSkillsDir({ client: "agents", scope: "user", cwd: "/w", home: "/h" }),
    path.join("/h", ".agents", "skills"),
  );
});
