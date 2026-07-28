/**
 * Portable backup / restore of scenes, version history, and files.
 *
 * Layout (documented inside every archive as README.md + MANIFEST.json):
 *
 *   README.md
 *   MANIFEST.json
 *   scenes/<slug>/meta.json
 *   scenes/<slug>/versions/<N>.json   # elements + appState as plain JSON
 *   files/<fileId>                    # raw image bytes
 *   files/<fileId>.json               # { mimeType, created }
 *
 * Consistency: the SQLite layer is snapshotted with `sqlite.backup` (not a
 * live WAL copy). Version blobs are then exported from that snapshot so the
 * human-readable archive matches a single point-in-time.
 *
 * Tokens / secrets are **not** included — only author *names* on versions.
 * Restoring never invents credentials; the target server keeps its own tokens.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createAuthPreHandler, requireAdminPreHandler } from "./auth.js";
import { Database, gunzipJson, gzipJson, nowIso, type SceneRow, type VersionRow } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";
import { FILE_ID_HEX_RE, FileStore, SIDECAR_SUFFIX, type FileSidecar } from "./files.js";
import { packTarGz, unpackTarGz, type TarEntry } from "./tar.js";

/** Format id written into MANIFEST.json. */
export const BACKUP_FORMAT = "excalidraw-collab-backup";

/** Current portable archive schema version. */
export const BACKUP_FORMAT_VERSION = 1;

/** Max upload size for restore bodies (256 MiB). */
export const RESTORE_BODY_LIMIT = 256 * 1024 * 1024;

/**
 * Collision policy when a scene slug already exists on the target server.
 *
 * - `skip` (default): leave the existing scene untouched; report it.
 * - `overwrite`: hard-delete the existing scene (and its versions) then import.
 * - `abort`: fail the whole restore on the first collision (nothing committed
 *   for that scene; prior successful imports in the same request are kept).
 *
 * Never silent: the restore response always lists restored / skipped /
 * overwritten / failed slugs.
 */
export type CollisionPolicy = "skip" | "overwrite" | "abort";

export const COLLISION_POLICIES: readonly CollisionPolicy[] = [
  "skip",
  "overwrite",
  "abort",
] as const;

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  sceneCount: number;
  fileCount: number;
  notes: string;
};

export type SceneMetaJson = {
  id: string;
  slug: string;
  name: string;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type VersionJson = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  elements: unknown;
  appState: unknown;
  fileIds: string[];
};

export type RestoreReport = {
  collisionPolicy: CollisionPolicy;
  restored: string[];
  skipped: string[];
  overwritten: string[];
  filesRestored: number;
  /** Human-readable lines describing each decision. */
  messages: string[];
};

export const BACKUP_README = `# excalidraw-collab backup archive

This archive is a portable, human-readable dump of an excalidraw-collab
server. You do **not** need this project's tools to inspect it.

## Layout

\`\`\`
README.md                 this file
MANIFEST.json             format id, version, counts, creation time
scenes/<slug>/meta.json   scene id, name, head version, timestamps
scenes/<slug>/versions/<N>.json
                          one file per version (1, 2, 3, …)
                          fields: version, parentVersion, author, message,
                          createdAt, elementCount, sceneHash,
                          elements (Excalidraw element array),
                          appState (whitelisted keys), fileIds
files/<fileId>            raw binary (usually a pasted image)
files/<fileId>.json       { "mimeType": "...", "created": <epoch-ms> }
\`\`\`

\`fileId\` is the lowercase SHA-1 hex digest of the raw bytes (Excalidraw's
content-addressed id). Version JSON references those ids in \`fileIds\`.

## What is included

- Every scene (including soft-deleted ones)
- Full linear version history (authors, messages, parent links)
- Binary files referenced by any version

## What is not included

- Auth tokens / secrets (irrecoverable hashes only exist server-side)
- Draft working copies (ephemeral editor state)
- Render cache / thumbnails (rebuilt on demand)

## Restoring

Use \`excali restore ARCHIVE.tar.gz\` against a running server, or
\`POST /api/restore\` as an admin. Collision policy (when a slug already
exists): skip (default), overwrite, or abort — never silent.

To open a single head scene without this tool, copy
\`scenes/<slug>/versions/<head>.json\`'s \`elements\` / \`appState\` /
embedded files into a standard \`.excalidraw\` document, or use
\`excali pull --all -o dir/\` for plain \`.excalidraw\` files.
`;

function parseFileIds(fileIdsJson: string): string[] {
  try {
    const parsed = JSON.parse(fileIdsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function versionToJson(row: VersionRow): VersionJson {
  return {
    version: row.version,
    parentVersion: row.parent_version,
    author: row.author,
    message: row.message,
    createdAt: row.created_at,
    elementCount: row.element_count,
    sceneHash: row.scene_hash,
    elements: gunzipJson(row.elements),
    appState: gunzipJson(row.app_state),
    fileIds: parseFileIds(row.file_ids),
  };
}

function sceneToMeta(row: SceneRow): SceneMetaJson {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    headVersion: row.head_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function prettyJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Build a portable `.tar.gz` archive of the current server state.
 *
 * Uses the SQLite backup API for a consistent DB snapshot, then exports
 * scenes/versions from that snapshot and copies content-addressed files
 * referenced by the snapshot.
 */
export async function buildBackupArchive(
  db: Database,
  store: FileStore,
): Promise<{ bytes: Buffer; manifest: BackupManifest }> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "excalidraw-collab-backup-"));
  const snapPath = path.join(tmpDir, "snapshot.sqlite");

  try {
    await db.backupTo(snapPath);

    const entries: TarEntry[] = [];
    const fileIds = new Set<string>();
    let sceneCount = 0;

    Database.withReadonlyFile(snapPath, db.dataDir, (snap) => {
      const scenes = snap.listAllScenes();
      sceneCount = scenes.length;

      for (const scene of scenes) {
        const meta = sceneToMeta(scene);
        entries.push({
          name: `scenes/${scene.slug}/meta.json`,
          data: prettyJson(meta),
        });

        const versions = snap.listVersions(scene.id);
        for (const ver of versions) {
          const vj = versionToJson(ver);
          for (const id of vj.fileIds) {
            fileIds.add(id);
          }
          entries.push({
            name: `scenes/${scene.slug}/versions/${ver.version}.json`,
            data: prettyJson(vj),
          });
        }
      }
    });

    // Files from the live store (content-addressed, immutable). Prefer ids
    // referenced by the snapshot; also include any leftover on-disk blobs so
    // operators do not lose orphaned but still-present images.
    for (const id of store.listStoredFileIds()) {
      fileIds.add(id);
    }

    let fileCount = 0;
    for (const fileId of [...fileIds].sort()) {
      if (!FILE_ID_HEX_RE.test(fileId)) continue;
      const stored = store.get(fileId);
      if (!stored) continue;
      fileCount += 1;
      entries.push({
        name: `files/${fileId}`,
        data: stored.bytes,
      });
      const sidecar: FileSidecar = {
        mimeType: stored.mimeType,
        created: stored.created,
      };
      entries.push({
        name: `files/${fileId}${SIDECAR_SUFFIX}`,
        data: prettyJson(sidecar),
      });
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: nowIso(),
      sceneCount,
      fileCount,
      notes:
        "Portable scene/history/file dump. Tokens are not included. " +
        "Authors on versions are preserved as plain strings.",
    };

    entries.unshift(
      { name: "README.md", data: Buffer.from(BACKUP_README, "utf8") },
      { name: "MANIFEST.json", data: prettyJson(manifest) },
    );

    const bytes = packTarGz(entries);
    return { bytes, manifest };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseSceneMeta(raw: unknown, slugFromPath: string): SceneMetaJson {
  if (!isPlainObject(raw)) {
    throw new AppError(ErrorCode.VALIDATION, `invalid scene meta for ${slugFromPath}`, 400);
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const slug = typeof raw.slug === "string" && raw.slug.length > 0 ? raw.slug : slugFromPath;
  const name = typeof raw.name === "string" ? raw.name : slug;
  const headVersion = Number(raw.headVersion ?? 0);
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  const deletedAt =
    raw.deletedAt === null || raw.deletedAt === undefined
      ? null
      : typeof raw.deletedAt === "string"
        ? raw.deletedAt
        : null;
  if (!id) {
    throw new AppError(ErrorCode.VALIDATION, `scene meta for ${slug} is missing id`, 400);
  }
  return {
    id,
    slug,
    name,
    headVersion: Number.isFinite(headVersion) ? headVersion : 0,
    createdAt,
    updatedAt,
    deletedAt,
  };
}

function parseVersionJson(raw: unknown, label: string): VersionJson {
  if (!isPlainObject(raw)) {
    throw new AppError(ErrorCode.VALIDATION, `invalid version JSON: ${label}`, 400);
  }
  const version = Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError(ErrorCode.VALIDATION, `invalid version number in ${label}`, 400);
  }
  const parentVersion =
    raw.parentVersion === null || raw.parentVersion === undefined
      ? null
      : Number(raw.parentVersion);
  const author = typeof raw.author === "string" ? raw.author : "unknown";
  const message = typeof raw.message === "string" ? raw.message : "";
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : nowIso();
  const elementCount = Number(raw.elementCount ?? 0);
  const sceneHash = typeof raw.sceneHash === "string" ? raw.sceneHash : "";
  const elements = raw.elements ?? [];
  const appState = raw.appState ?? {};
  let fileIds: string[] = [];
  if (Array.isArray(raw.fileIds)) {
    fileIds = raw.fileIds.filter((x): x is string => typeof x === "string" && x.length > 0);
  }
  return {
    version,
    parentVersion: parentVersion !== null && Number.isFinite(parentVersion) ? parentVersion : null,
    author,
    message,
    createdAt,
    elementCount: Number.isFinite(elementCount) ? elementCount : 0,
    sceneHash,
    elements,
    appState,
    fileIds,
  };
}

function parseManifest(raw: unknown): BackupManifest | null {
  if (!isPlainObject(raw)) return null;
  if (raw.format !== BACKUP_FORMAT) return null;
  const formatVersion = Number(raw.formatVersion ?? 0);
  if (!Number.isInteger(formatVersion) || formatVersion < 1) return null;
  return {
    format: BACKUP_FORMAT,
    formatVersion,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    sceneCount: Number(raw.sceneCount ?? 0),
    fileCount: Number(raw.fileCount ?? 0),
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

type ParsedArchive = {
  manifest: BackupManifest | null;
  scenes: Map<string, { meta: SceneMetaJson; versions: VersionJson[] }>;
  files: Map<string, { bytes: Buffer; sidecar?: FileSidecar }>;
};

function parseArchive(entries: TarEntry[]): ParsedArchive {
  const scenes = new Map<string, { meta: SceneMetaJson | null; versions: VersionJson[] }>();
  const files = new Map<string, { bytes?: Buffer; sidecar?: FileSidecar }>();
  let manifest: BackupManifest | null = null;

  for (const entry of entries) {
    const name = entry.name.replace(/^\.\//, "");
    if (name === "MANIFEST.json") {
      try {
        manifest = parseManifest(JSON.parse(entry.data.toString("utf8")));
      } catch {
        manifest = null;
      }
      continue;
    }
    if (name === "README.md") continue;

    const sceneMeta = /^scenes\/([^/]+)\/meta\.json$/.exec(name);
    if (sceneMeta) {
      const slug = sceneMeta[1]!;
      const meta = parseSceneMeta(JSON.parse(entry.data.toString("utf8")), slug);
      const cur = scenes.get(slug) ?? { meta: null, versions: [] };
      cur.meta = meta;
      scenes.set(slug, cur);
      continue;
    }

    const sceneVer = /^scenes\/([^/]+)\/versions\/(\d+)\.json$/.exec(name);
    if (sceneVer) {
      const slug = sceneVer[1]!;
      const ver = parseVersionJson(JSON.parse(entry.data.toString("utf8")), name);
      const cur = scenes.get(slug) ?? { meta: null, versions: [] };
      cur.versions.push(ver);
      scenes.set(slug, cur);
      continue;
    }

    const fileSidecar = /^files\/([0-9a-f]{40})\.json$/.exec(name);
    if (fileSidecar) {
      const id = fileSidecar[1]!;
      let sidecar: FileSidecar | undefined;
      try {
        const raw = JSON.parse(entry.data.toString("utf8")) as Partial<FileSidecar>;
        if (typeof raw.mimeType === "string") {
          sidecar = {
            mimeType: raw.mimeType,
            created:
              typeof raw.created === "number" && Number.isFinite(raw.created)
                ? raw.created
                : Date.now(),
          };
        }
      } catch {
        // ignore corrupt sidecar
      }
      const cur = files.get(id) ?? {};
      if (sidecar) cur.sidecar = sidecar;
      files.set(id, cur);
      continue;
    }

    const fileBlob = /^files\/([0-9a-f]{40})$/.exec(name);
    if (fileBlob) {
      const id = fileBlob[1]!;
      const cur = files.get(id) ?? {};
      cur.bytes = entry.data;
      files.set(id, cur);
    }
  }

  const outScenes = new Map<string, { meta: SceneMetaJson; versions: VersionJson[] }>();
  for (const [slug, cur] of scenes) {
    if (!cur.meta) {
      throw new AppError(ErrorCode.VALIDATION, `archive missing meta.json for scene ${slug}`, 400);
    }
    cur.versions.sort((a, b) => a.version - b.version);
    outScenes.set(slug, { meta: cur.meta, versions: cur.versions });
  }

  const outFiles = new Map<string, { bytes: Buffer; sidecar?: FileSidecar }>();
  for (const [id, cur] of files) {
    if (!cur.bytes) continue;
    outFiles.set(id, { bytes: cur.bytes, sidecar: cur.sidecar });
  }

  return { manifest, scenes: outScenes, files: outFiles };
}

/**
 * Restore a portable archive into `db` + `store` under the given collision policy.
 * Returns a report that is always visible to the caller (never silent).
 */
export function restoreBackupArchive(
  db: Database,
  store: FileStore,
  archiveBytes: Buffer,
  collisionPolicy: CollisionPolicy = "skip",
): RestoreReport {
  if (!COLLISION_POLICIES.includes(collisionPolicy)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `invalid collision policy: ${JSON.stringify(collisionPolicy)} ` +
        `(expected ${COLLISION_POLICIES.join("|")})`,
      400,
    );
  }

  let entries: TarEntry[];
  try {
    entries = unpackTarGz(archiveBytes);
  } catch (err) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `invalid backup archive: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }

  const parsed = parseArchive(entries);
  if (parsed.scenes.size === 0 && parsed.files.size === 0) {
    throw new AppError(ErrorCode.VALIDATION, "backup archive contains no scenes or files", 400);
  }

  const report: RestoreReport = {
    collisionPolicy,
    restored: [],
    skipped: [],
    overwritten: [],
    filesRestored: 0,
    messages: [],
  };

  // Files first (content-addressed; always idempotent put).
  for (const [fileId, { bytes, sidecar }] of parsed.files) {
    store.put({
      bytes,
      mimeType: sidecar?.mimeType ?? "application/octet-stream",
      created: sidecar?.created,
      claimedFileId: fileId,
    });
    report.filesRestored += 1;
  }
  if (report.filesRestored > 0) {
    report.messages.push(`Restored ${report.filesRestored} content-addressed file(s).`);
  }

  // Sort slugs for deterministic reports.
  const slugs = [...parsed.scenes.keys()].sort();

  for (const slug of slugs) {
    const { meta, versions } = parsed.scenes.get(slug)!;
    const existing = db.getSceneBySlugIncludingDeleted(meta.slug);

    if (existing) {
      if (collisionPolicy === "abort") {
        report.messages.push(
          `Aborted: scene slug ${JSON.stringify(meta.slug)} already exists ` +
            `(policy=abort). Restored so far: ${report.restored.join(", ") || "(none)"}.`,
        );
        throw new AppError(
          ErrorCode.CONFLICT,
          `scene slug already exists: ${meta.slug} (collision policy: abort)`,
          409,
          { report },
        );
      }
      if (collisionPolicy === "skip") {
        report.skipped.push(meta.slug);
        report.messages.push(`Skipped ${meta.slug}: already exists (policy=skip).`);
        continue;
      }
      // overwrite: hard-delete then re-import under original id when free,
      // otherwise keep a new id if the archived id collides with a different slug.
      db.deleteScene(existing.id);
      report.overwritten.push(meta.slug);
      report.messages.push(`Overwrote ${meta.slug}: replaced existing scene (policy=overwrite).`);
    }

    // Prefer archived id; if another row still holds that id (different slug),
    // allocate a fresh id so restore never fails on PK.
    let sceneId = meta.id;
    if (db.getSceneById(sceneId)) {
      sceneId = cryptoRandomId();
      report.messages.push(
        `Scene ${meta.slug}: archived id was in use; assigned new id ${sceneId}.`,
      );
    }

    // Insert scene with head_version 0, then insert versions and set head.
    db.insertScene({
      id: sceneId,
      slug: meta.slug,
      name: meta.name,
      head_version: 0,
      created_at: meta.createdAt,
      updated_at: meta.updatedAt,
      deleted_at: meta.deletedAt,
    });

    let maxVersion = 0;
    for (const ver of versions) {
      db.insertVersion({
        scene_id: sceneId,
        version: ver.version,
        parent_version: ver.parentVersion,
        author: ver.author,
        message: ver.message,
        created_at: ver.createdAt,
        elements: gzipJson(ver.elements),
        app_state: gzipJson(ver.appState),
        file_ids: ver.fileIds,
        element_count: ver.elementCount,
        scene_hash: ver.sceneHash,
      });
      if (ver.version > maxVersion) maxVersion = ver.version;
    }

    const head = meta.headVersion > 0 ? meta.headVersion : maxVersion;
    if (head > 0) {
      db.updateSceneHead(sceneId, head, meta.updatedAt);
    }

    // Re-apply soft-delete if needed (insertScene accepts deleted_at, so already set).
    report.restored.push(meta.slug);
    if (!existing) {
      report.messages.push(`Restored ${meta.slug}: ${versions.length} version(s), head=${head}.`);
    } else {
      report.messages.push(`Imported ${meta.slug}: ${versions.length} version(s), head=${head}.`);
    }
  }

  if (parsed.manifest) {
    report.messages.unshift(
      `Archive format ${parsed.manifest.format} v${parsed.manifest.formatVersion} ` +
        `created ${parsed.manifest.createdAt}.`,
    );
  }

  return report;
}

function cryptoRandomId(): string {
  return randomUUID();
}

function parseCollisionPolicy(raw: unknown): CollisionPolicy {
  if (raw === undefined || raw === null || raw === "") return "skip";
  const s = String(raw).trim().toLowerCase();
  if ((COLLISION_POLICIES as readonly string[]).includes(s)) {
    return s as CollisionPolicy;
  }
  throw new AppError(
    ErrorCode.VALIDATION,
    `onCollision must be one of ${COLLISION_POLICIES.join("|")}`,
    400,
  );
}

/**
 * Register admin-only backup/restore routes:
 *
 *   GET  /api/backup              → application/gzip tar.gz archive
 *   POST /api/restore?onCollision=skip|overwrite|abort
 *        body: application/gzip | application/x-gzip | application/octet-stream
 */
export async function registerBackupRoutes(
  app: FastifyInstance,
  deps: { db: Database; store: FileStore },
): Promise<void> {
  const authPreHandler: preHandlerHookHandler = createAuthPreHandler(deps.db);

  // Accept gzip / raw binary for restore uploads (large body limit).
  const rawParser = (
    _req: FastifyRequest,
    body: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ): void => {
    done(null, body);
  };
  for (const type of ["application/gzip", "application/x-gzip", "application/x-tar"] as const) {
    try {
      app.addContentTypeParser(
        type,
        { parseAs: "buffer", bodyLimit: RESTORE_BODY_LIMIT },
        rawParser,
      );
    } catch {
      // Already registered (hot-reload / double-register in tests) — ignore.
    }
  }

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);
      api.addHook("preHandler", requireAdminPreHandler);

      api.get("/backup", async (_request, reply) => {
        const { bytes, manifest } = await buildBackupArchive(deps.db, deps.store);
        const filename = `excalidraw-collab-backup-${manifest.createdAt.replace(/[:.]/g, "-")}.tar.gz`;
        return reply
          .status(200)
          .header("Content-Type", "application/gzip")
          .header("Content-Length", bytes.byteLength)
          .header("Content-Disposition", `attachment; filename="${filename}"`)
          .header("X-Backup-Scene-Count", String(manifest.sceneCount))
          .header("X-Backup-File-Count", String(manifest.fileCount))
          .send(bytes);
      });

      api.post<{
        Querystring: { onCollision?: string };
      }>(
        "/restore",
        {
          bodyLimit: RESTORE_BODY_LIMIT,
        },
        async (request, reply) => {
          const policy = parseCollisionPolicy(request.query?.onCollision);
          const body = request.body;
          if (!Buffer.isBuffer(body) || body.byteLength === 0) {
            throw new AppError(
              ErrorCode.BAD_REQUEST,
              "restore body must be a non-empty .tar.gz (application/gzip)",
              400,
            );
          }
          const report = restoreBackupArchive(deps.db, deps.store, body, policy);
          return reply.status(200).send(report);
        },
      );
    },
    { prefix: "/api" },
  );
}

/** Test helper: write archive bytes to a path. */
export function writeBackupFile(filePath: string, bytes: Buffer): void {
  writeFileSync(filePath, bytes);
}

/** Test helper: read archive bytes from a path. */
export function readBackupFile(filePath: string): Buffer {
  return readFileSync(filePath);
}
