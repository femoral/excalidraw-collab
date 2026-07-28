import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** On-disk config shape for ~/.config/excali/config.json */
export type FileConfig = {
  server?: string;
  token?: string;
};

/** Resolved config after env overrides. */
export type ResolvedConfig = {
  server: string | undefined;
  token: string | undefined;
  /** Absolute path to the config file (whether or not it exists). */
  path: string;
};

const CONFIG_DIR_NAME = "excali";
/** Pre-rename directory name; still read (never written) so old logins keep working. */
const LEGACY_CONFIG_DIR_NAME = "excalicli";
const CONFIG_FILE_NAME = "config.json";
const FILE_MODE = 0o600;

/**
 * Config directory: `$XDG_CONFIG_HOME/excali` when set, else
 * `~/.config/excali`.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, CONFIG_DIR_NAME);
  }
  return path.join(os.homedir(), ".config", CONFIG_DIR_NAME);
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), CONFIG_FILE_NAME);
}

/** Pre-rename config file (`.../excalicli/config.json`), read-only fallback. */
function legacyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, LEGACY_CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** Read the config file; missing file → empty object. Throws on other I/O errors. */
export function readConfigFile(env: NodeJS.ProcessEnv = process.env): FileConfig {
  let file = configPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
    // Fall back to the pre-rename location so existing logins survive.
    file = legacyConfigPath(env);
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (legacyErr) {
      if ((legacyErr as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw legacyErr;
    }
  }
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${file}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const out: FileConfig = {};
  if (typeof obj.server === "string") {
    out.server = obj.server;
  }
  if (typeof obj.token === "string") {
    out.token = obj.token;
  }
  return out;
}

/**
 * Write config with mode `0600`. Creates the directory if missing.
 * Existing files are chmod'd to 0600 even if they already existed.
 */
export function writeConfigFile(config: FileConfig, env: NodeJS.ProcessEnv = process.env): string {
  const dir = configDir(env);
  const file = path.join(dir, CONFIG_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  // mode applies only on create; chmod ensures 0600 when overwriting too.
  fs.writeFileSync(file, body, { encoding: "utf8", mode: FILE_MODE });
  fs.chmodSync(file, FILE_MODE);
  return file;
}

/**
 * Resolve server/token: env vars win over the file.
 * - `EXCALI_SERVER` / `EXCALI_TOKEN` (legacy `EXCALICLI_*` still honoured)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const file = readConfigFile(env);
  return {
    server: env.EXCALI_SERVER || env.EXCALICLI_SERVER || file.server,
    token: env.EXCALI_TOKEN || env.EXCALICLI_TOKEN || file.token,
    path: configPath(env),
  };
}
