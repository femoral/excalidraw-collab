/**
 * Working-directory local state: last pulled version per scene, per server.
 *
 * Path: `<cwd>/.excalidraw-collab/state.json`
 *
 * This is what later makes `diff --since-last-pull` work with no arguments —
 * agents must never track version numbers by hand.
 */
import fs from "node:fs";
import path from "node:path";

export const STATE_DIR_NAME = ".excalidraw-collab";
export const STATE_FILE_NAME = "state.json";

/** One scene's recorded pull on a given server. */
export type SceneState = {
  /** Last successfully pulled (or successfully pushed) version number. */
  version: number;
};

export type ServerState = {
  scenes: Record<string, SceneState>;
};

/** On-disk shape of `.excalidraw-collab/state.json`. */
export type LocalState = {
  /** Schema version for future migrations. */
  version: 1;
  /**
   * Keyed by normalized server base URL (no trailing slash).
   * Nested `scenes` keyed by scene slug.
   */
  servers: Record<string, ServerState>;
};

export function emptyLocalState(): LocalState {
  return { version: 1, servers: {} };
}

/** Strip trailing slashes so `http://h/` and `http://h` share one entry. */
export function normalizeServerKey(server: string): string {
  let s = server.trim();
  while (s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}

export function stateDir(cwd: string): string {
  return path.join(cwd, STATE_DIR_NAME);
}

export function statePath(cwd: string): string {
  return path.join(stateDir(cwd), STATE_FILE_NAME);
}

/**
 * Read local state. Missing file → empty state. Corrupt / wrong shape → throws
 * a plain Error (caller maps to CliError).
 */
export function readLocalState(cwd: string): LocalState {
  const file = statePath(cwd);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return emptyLocalState();
    }
    throw err;
  }

  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid local state at ${file}: expected a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const serversRaw = obj.servers;
  if (serversRaw === undefined) {
    return emptyLocalState();
  }
  if (
    serversRaw === null ||
    typeof serversRaw !== "object" ||
    Array.isArray(serversRaw)
  ) {
    throw new Error(
      `Invalid local state at ${file}: "servers" must be an object`,
    );
  }

  const servers: Record<string, ServerState> = {};
  for (const [serverKey, serverVal] of Object.entries(
    serversRaw as Record<string, unknown>,
  )) {
    if (
      serverVal === null ||
      typeof serverVal !== "object" ||
      Array.isArray(serverVal)
    ) {
      continue;
    }
    const scenesRaw = (serverVal as { scenes?: unknown }).scenes;
    if (
      scenesRaw === null ||
      typeof scenesRaw !== "object" ||
      Array.isArray(scenesRaw)
    ) {
      servers[serverKey] = { scenes: {} };
      continue;
    }
    const scenes: Record<string, SceneState> = {};
    for (const [slug, sceneVal] of Object.entries(
      scenesRaw as Record<string, unknown>,
    )) {
      if (
        sceneVal === null ||
        typeof sceneVal !== "object" ||
        Array.isArray(sceneVal)
      ) {
        continue;
      }
      const ver = (sceneVal as { version?: unknown }).version;
      if (typeof ver === "number" && Number.isInteger(ver) && ver >= 0) {
        scenes[slug] = { version: ver };
      }
    }
    servers[serverKey] = { scenes };
  }

  return { version: 1, servers };
}

/** Write local state (creates `.excalidraw-collab/` if needed). */
export function writeLocalState(cwd: string, state: LocalState): string {
  const dir = stateDir(cwd);
  const file = path.join(dir, STATE_FILE_NAME);
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(state, null, 2)}\n`;
  fs.writeFileSync(file, body, { encoding: "utf8" });
  return file;
}

/** Last pulled version for (server, slug), or `undefined` if never recorded. */
export function getPulledVersion(
  cwd: string,
  server: string,
  slug: string,
): number | undefined {
  const state = readLocalState(cwd);
  const key = normalizeServerKey(server);
  return state.servers[key]?.scenes[slug]?.version;
}

/**
 * Record last pulled/pushed version for (server, slug). Other servers' entries
 * for the same slug are left intact.
 */
export function setPulledVersion(
  cwd: string,
  server: string,
  slug: string,
  version: number,
): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid version: ${version}`);
  }
  const state = readLocalState(cwd);
  const key = normalizeServerKey(server);
  const serverState = state.servers[key] ?? { scenes: {} };
  serverState.scenes = { ...serverState.scenes, [slug]: { version } };
  state.servers[key] = serverState;
  writeLocalState(cwd, state);
}
