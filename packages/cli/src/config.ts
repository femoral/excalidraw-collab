import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** On-disk config shape for ~/.config/excalicli/config.json */
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

const CONFIG_DIR_NAME = "excalicli";
const CONFIG_FILE_NAME = "config.json";
const FILE_MODE = 0o600;

/**
 * Config directory: `$XDG_CONFIG_HOME/excalicli` when set, else
 * `~/.config/excalicli`.
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

/** Read the config file; missing file → empty object. Throws on other I/O errors. */
export function readConfigFile(env: NodeJS.ProcessEnv = process.env): FileConfig {
  const file = configPath(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw err;
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
export function writeConfigFile(
  config: FileConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
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
 * - `EXCALICLI_SERVER` / `EXCALICLI_TOKEN`
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const file = readConfigFile(env);
  return {
    server: env.EXCALICLI_SERVER || file.server,
    token: env.EXCALICLI_TOKEN || file.token,
    path: configPath(env),
  };
}
