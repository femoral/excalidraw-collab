/**
 * `excali skills ls|install` — install the bundled agent skill into a
 * client's skills directory.
 *
 * The skill ships inside this package (`packages/cli/skills/<name>/`) so an
 * installed CLI carries its own agent instructions; nothing is fetched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Command, CommandContext } from "./commands.js";
import { CliError, UsageError } from "./errors.js";
import type { CommandResult } from "./format.js";
import { formatTable } from "./format.js";

/** Clients whose skill directory layout we know. */
export const SKILL_CLIENTS = ["claude", "agents"] as const;
export type SkillClient = (typeof SKILL_CLIENTS)[number];

/** Where the skill lands: this project, or the whole user account. */
export const SKILL_SCOPES = ["project", "user"] as const;
export type SkillScope = (typeof SKILL_SCOPES)[number];

const CLIENT_DIRNAME: Record<SkillClient, string> = {
  claude: ".claude",
  agents: ".agents",
};

const USAGE =
  "excali skills ls | install [NAME] [options] [--json]\n\n" +
  "  ls                 List skills bundled with this CLI\n" +
  "  install [NAME]     Copy a bundled skill into a skills directory\n\n" +
  "  --client NAME      claude (default) | agents — picks .claude/ or .agents/\n" +
  "  --scope NAME       project (default) | user — cwd, or your home directory\n" +
  "  --dir PATH         Explicit skills directory; overrides --client/--scope\n" +
  "  --force            Overwrite an existing installation\n" +
  "  --dry-run          Report what would be written, touch nothing\n\n" +
  "Default target: ./.claude/skills/NAME/  (--scope user → ~/.claude/skills/NAME/)\n" +
  "NAME defaults to the only bundled skill when there is exactly one.";

/**
 * Directory holding the bundled skills, resolved from this module.
 * Works from both `src/` (tests via tsx) and `dist/` (published package).
 */
export function bundledSkillsDir(fromUrl: string | URL = import.meta.url): string {
  const dir = path.dirname(fileURLToPath(fromUrl));
  return path.resolve(dir, "..", "skills");
}

export type BundledSkill = {
  name: string;
  /** Absolute path of the skill's source directory. */
  source: string;
  /** `description` from SKILL.md frontmatter, when present. */
  description: string;
};

/** Read the `description:` line out of a SKILL.md YAML frontmatter block. */
function readDescription(skillMd: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!match) return "";
  const body = match[1] ?? "";
  const line = /^description:\s*(.+)$/m.exec(body);
  if (!line) return "";
  return (line[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

/** Every skill directory bundled with this CLI, sorted by name. */
export function listBundledSkills(skillsDir = bundledSkillsDir()): BundledSkill[] {
  if (!fs.existsSync(skillsDir)) return [];
  const skills: BundledSkill[] = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(skillsDir, entry.name);
    const skillMd = path.join(source, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;
    skills.push({
      name: entry.name,
      source,
      description: readDescription(fs.readFileSync(skillMd, "utf8")),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve the skills directory a `--client`/`--scope` pair points at. */
export function resolveSkillsDir(options: {
  client: SkillClient;
  scope: SkillScope;
  cwd: string;
  home: string;
}): string {
  const base = options.scope === "user" ? options.home : options.cwd;
  return path.join(base, CLIENT_DIRNAME[options.client], "skills");
}

/** Files copied, as paths relative to the destination root. */
function copyTree(from: string, to: string, dryRun: boolean): string[] {
  const written: string[] = [];
  const walk = (srcDir: string, destDir: string, prefix: string): void => {
    if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
    const entries = fs
      .readdirSync(srcDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const src = path.join(srcDir, entry.name);
      const dest = path.join(destDir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(src, dest, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!dryRun) fs.copyFileSync(src, dest);
      written.push(rel);
    }
  };
  walk(from, to, "");
  return written;
}

type InstallOptions = {
  name?: string;
  client: SkillClient;
  scope: SkillScope;
  dir?: string;
  force: boolean;
  dryRun: boolean;
};

function parseSkillsArgs(args: string[]): {
  sub: "ls" | "install";
  options: InstallOptions;
} {
  let values: {
    client?: string;
    scope?: string;
    dir?: string;
    force?: boolean;
    "dry-run"?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        client: { type: "string" },
        scope: { type: "string" },
        dir: { type: "string" },
        force: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const [sub, name, ...extra] = positionals;
  if (!sub) {
    throw new UsageError(`skills requires a subcommand: ls | install\n\nUsage: ${USAGE}`);
  }
  if (sub !== "ls" && sub !== "install") {
    throw new UsageError(`unknown skills subcommand: ${sub}\n\nUsage: ${USAGE}`);
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected arguments: ${extra.join(" ")}`);
  }
  if (sub === "ls" && name !== undefined) {
    throw new UsageError("skills ls does not take a skill name");
  }

  const client = values.client ?? "claude";
  if (!SKILL_CLIENTS.includes(client as SkillClient)) {
    throw new UsageError(`--client must be one of: ${SKILL_CLIENTS.join(", ")}`);
  }
  const scope = values.scope ?? "project";
  if (!SKILL_SCOPES.includes(scope as SkillScope)) {
    throw new UsageError(`--scope must be one of: ${SKILL_SCOPES.join(", ")}`);
  }
  if (sub === "ls" && (values.dir || values.client || values.scope)) {
    throw new UsageError("skills ls does not take --dir/--client/--scope");
  }

  return {
    sub,
    options: {
      name,
      client: client as SkillClient,
      scope: scope as SkillScope,
      dir: values.dir,
      force: values.force === true,
      dryRun: values["dry-run"] === true,
    },
  };
}

/** Descriptions are long (they drive skill triggering) — clip for the table. */
function clip(text: string, max = 72): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function runLs(): CommandResult {
  const skills = listBundledSkills();
  const rows = skills.map((s) => ({
    name: s.name,
    description: s.description,
  }));
  const human = rows.map((r) => ({ ...r, description: clip(r.description) }));
  return {
    data: rows,
    human:
      formatTable(human, ["name", "description"]) +
      `\nInstall with: excali skills install ${skills[0]?.name ?? "NAME"}\n`,
  };
}

function pickSkill(name: string | undefined): BundledSkill {
  const skills = listBundledSkills();
  if (skills.length === 0) {
    throw new CliError(`No skills bundled with this CLI (looked in ${bundledSkillsDir()}).`, {
      code: "ERROR",
    });
  }
  if (!name) {
    if (skills.length === 1) return skills[0]!;
    throw new UsageError(
      `skills install requires a NAME when several are bundled: ` +
        skills.map((s) => s.name).join(", "),
    );
  }
  const found = skills.find((s) => s.name === name);
  if (!found) {
    throw new UsageError(
      `unknown skill: ${name}\nBundled skills: ${skills.map((s) => s.name).join(", ")}`,
    );
  }
  return found;
}

function runInstall(ctx: CommandContext, options: InstallOptions): CommandResult {
  const skill = pickSkill(options.name);

  const home = ctx.env.HOME ?? os.homedir();
  const skillsDir = options.dir
    ? path.resolve(ctx.cwd, options.dir)
    : resolveSkillsDir({
        client: options.client,
        scope: options.scope,
        cwd: ctx.cwd,
        home,
      });
  const target = path.join(skillsDir, skill.name);

  const existed = fs.existsSync(target);
  if (existed && !options.force) {
    throw new CliError(`${target} already exists.\nRe-run with --force to overwrite it.`, {
      code: "ERROR",
      details: { path: target },
    });
  }

  if (existed && options.force && !options.dryRun) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  const files = copyTree(skill.source, target, options.dryRun);

  const data = {
    skill: skill.name,
    path: target,
    client: options.dir ? null : options.client,
    scope: options.dir ? null : options.scope,
    overwrote: existed,
    dryRun: options.dryRun,
    files,
  };

  const verb = options.dryRun ? "Would install" : existed ? "Reinstalled" : "Installed";
  const human =
    `${verb} skill ${skill.name} → ${target}\n` +
    files.map((f) => `  ${f}\n`).join("") +
    (options.dryRun ? "\n(dry run — nothing written)\n" : "");

  return { data, human };
}

function runSkills(ctx: CommandContext): CommandResult {
  const { sub, options } = parseSkillsArgs(ctx.args);
  if (sub === "ls") {
    return runLs();
  }
  return runInstall(ctx, options);
}

export const skillsCommand: Command = {
  name: "skills",
  description:
    "List or install the agent skill bundled with this CLI (Claude/agents skills directory, project or user scope)",
  usage: USAGE,
  run: runSkills,
};
