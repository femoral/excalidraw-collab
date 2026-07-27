/**
 * Single module containing all SQL for the server.
 *
 * Escape hatch (PLAN.md): if `node:sqlite` must be swapped for
 * `better-sqlite3`, only this file changes. Callers use the typed
 * data-access surface only — no SQL strings elsewhere.
 */
import "./sqlite-warning.js";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

/** Filename of the SQLite database under `DATA_DIR`. */
export const DB_FILENAME = "db.sqlite";

/** Default busy_timeout in milliseconds. */
export const BUSY_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Row types (mirror PLAN.md §4)
// ---------------------------------------------------------------------------

export type SceneRow = {
  id: string;
  slug: string;
  name: string;
  head_version: number;
  created_at: string;
  updated_at: string;
  lock_holder: string | null;
  lock_expires_at: string | null;
  /**
   * Soft-delete timestamp (ISO-8601). Null while the scene is live.
   * Soft-deleted scenes keep their rows and versions; they are hidden from
   * public list/get-by-slug paths but still occupy their slug under the
   * UNIQUE constraint (see migration 003 comment).
   */
  deleted_at: string | null;
};

/**
 * Scene list/detail row with the head version's element count joined in.
 * When `head_version` is 0 (no versions yet), `element_count` is 0.
 */
export type SceneListRow = SceneRow & {
  element_count: number;
};

export type VersionRow = {
  scene_id: string;
  version: number;
  parent_version: number | null;
  author: string;
  message: string;
  created_at: string;
  /** Gzipped JSON element array. */
  elements: Buffer;
  /** Gzipped JSON appState (whitelisted keys only). */
  app_state: Buffer;
  /** JSON-encoded string array of content-addressed file ids. */
  file_ids: string;
  element_count: number;
  scene_hash: string;
};

export type DraftRow = {
  scene_id: string;
  elements: Buffer;
  app_state: Buffer;
  file_ids: string;
  updated_at: string;
  updated_by: string;
};

export type TokenRow = {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  /** Explicit privilege flag; never inferred from `name`. */
  is_admin: boolean;
};

/** Key/value row in the `meta` table (server-side durable flags). */
export type MetaRow = {
  key: string;
  value: string;
};

/** Meta key set when first-boot bootstrap has completed (value `"1"`). */
export const META_BOOTSTRAP_COMPLETED = "bootstrap_completed";

export type SchemaMigrationRow = {
  id: number;
  name: string;
  applied_at: string;
};

// ---------------------------------------------------------------------------
// Input types for inserts / upserts
// ---------------------------------------------------------------------------

export type NewScene = {
  id: string;
  slug: string;
  name: string;
  head_version?: number;
  created_at?: string;
  updated_at?: string;
  lock_holder?: string | null;
  lock_expires_at?: string | null;
  deleted_at?: string | null;
};

export type NewVersion = {
  scene_id: string;
  version: number;
  parent_version: number | null;
  author: string;
  message: string;
  created_at?: string;
  elements: Buffer | Uint8Array;
  app_state: Buffer | Uint8Array;
  file_ids?: string[] | string;
  element_count?: number;
  scene_hash?: string;
};

export type UpsertDraft = {
  scene_id: string;
  elements: Buffer | Uint8Array;
  app_state: Buffer | Uint8Array;
  file_ids?: string[] | string;
  updated_at?: string;
  updated_by: string;
};

export type NewToken = {
  id: string;
  name: string;
  token_hash: string;
  created_at?: string;
  last_used_at?: string | null;
  /** Defaults to false (non-admin). */
  is_admin?: boolean;
};

// ---------------------------------------------------------------------------
// Blob / hash helpers (node:zlib, node:crypto — no extra deps)
// ---------------------------------------------------------------------------

/** Gzip a JSON-serializable value to a Buffer for BLOB columns. */
export function gzipJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8"));
}

/** Gunzip a BLOB column back to a parsed JSON value. */
export function gunzipJson<T = unknown>(data: Buffer | Uint8Array): T {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return JSON.parse(gunzipSync(buf).toString("utf8")) as T;
}

/** SHA-256 hex digest of a bearer token (tokens are stored hashed only). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** ISO-8601 UTC timestamp. */
export function nowIso(): string {
  return new Date().toISOString();
}

function asBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function encodeFileIds(fileIds: string[] | string | undefined): string {
  if (fileIds === undefined) return "[]";
  if (typeof fileIds === "string") return fileIds;
  return JSON.stringify(fileIds);
}

function blobToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value === null || value === undefined) {
    return Buffer.alloc(0);
  }
  // node:sqlite may return Uint8Array for BLOB columns
  return Buffer.from(value as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

type Migration = {
  id: number;
  name: string;
  sql: string;
};

/**
 * Forward-only numbered migrations. Each runs once inside a transaction
 * and is recorded in `schema_migrations`.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "001_initial_schema",
    sql: `
      CREATE TABLE scenes (
        id              TEXT PRIMARY KEY NOT NULL,
        slug            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        head_version    INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        lock_holder     TEXT,
        lock_expires_at TEXT
      );

      CREATE TABLE versions (
        scene_id       TEXT NOT NULL,
        version        INTEGER NOT NULL,
        parent_version INTEGER,
        author         TEXT NOT NULL,
        message        TEXT NOT NULL DEFAULT '',
        created_at     TEXT NOT NULL,
        elements       BLOB NOT NULL,
        app_state      BLOB NOT NULL,
        file_ids       TEXT NOT NULL DEFAULT '[]',
        element_count  INTEGER NOT NULL DEFAULT 0,
        scene_hash     TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (scene_id, version),
        FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
      );

      CREATE TABLE drafts (
        scene_id   TEXT PRIMARY KEY NOT NULL,
        elements   BLOB NOT NULL,
        app_state  BLOB NOT NULL,
        file_ids   TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
      );

      CREATE TABLE tokens (
        id           TEXT PRIMARY KEY NOT NULL,
        name         TEXT NOT NULL,
        token_hash   TEXT NOT NULL UNIQUE,
        created_at   TEXT NOT NULL,
        last_used_at TEXT
      );

      -- Read paths: list scenes by recency, look up versions by scene, auth by hash.
      CREATE INDEX idx_scenes_updated_at ON scenes(updated_at);
      CREATE INDEX idx_versions_scene_created ON versions(scene_id, created_at);
      CREATE INDEX idx_tokens_token_hash ON tokens(token_hash);
    `,
  },
  {
    id: 2,
    name: "002_token_admin_and_meta",
    sql: `
      -- Explicit privilege bit (was previously inferred from name === "admin").
      ALTER TABLE tokens ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

      -- Durable key/value store for server flags (e.g. bootstrap completed).
      -- Lives in the DB so backup/restore cannot lose it independently of tokens.
      CREATE TABLE meta (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 3,
    name: "003_scenes_soft_delete",
    sql: `
      -- Soft delete: DELETE /api/scenes/:slug sets deleted_at rather than
      -- destroying the row. Versions are never destroyed (no CASCADE on this
      -- path). Soft-deleted scenes disappear from listings and return 404 by
      -- slug, but their rows and version history survive.
      --
      -- Slug uniqueness interaction: scenes.slug remains UNIQUE across *all*
      -- rows, including soft-deleted ones. A deleted scene therefore continues
      -- to occupy its slug. Collision-suffixing for auto-derived slugs skips
      -- taken slugs (live and deleted); an explicit slug that collides with a
      -- soft-deleted scene is rejected with 409. We deliberately do not free
      -- slugs on soft-delete: reusing a slug would make "GET by slug" ambiguous
      -- against historical rows, and partial UNIQUE indexes would require a
      -- table rebuild to drop the column-level UNIQUE from migration 001.
      ALTER TABLE scenes ADD COLUMN deleted_at TEXT;

      CREATE INDEX idx_scenes_deleted_at ON scenes(deleted_at);
    `,
  },
];

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

export type OpenDatabaseOptions = {
  /**
   * When true, open an in-memory database (tests). `dataDir` is still used
   * for the public `dataDir` property but no file is created.
   */
  memory?: boolean;
};

/**
 * Typed SQLite data-access layer. All SQL for the process lives here.
 */
export class Database {
  readonly dataDir: string;
  readonly dbPath: string;
  private readonly raw: DatabaseSync;
  private closed = false;

  private constructor(
    dataDir: string,
    dbPath: string,
    raw: DatabaseSync,
  ) {
    this.dataDir = dataDir;
    this.dbPath = dbPath;
    this.raw = raw;
  }

  /**
   * Open (or create) the database under `dataDir`, apply pragmas, and run
   * any pending migrations. Creates `dataDir` if it does not exist.
   */
  static open(
    dataDir: string,
    options: OpenDatabaseOptions = {},
  ): Database {
    const resolvedDir = path.resolve(dataDir);
    if (!options.memory) {
      mkdirSync(resolvedDir, { recursive: true });
    }
    const dbPath = options.memory
      ? ":memory:"
      : path.join(resolvedDir, DB_FILENAME);

    const raw = new DatabaseSync(dbPath, {
      enableForeignKeyConstraints: true,
    });

    const db = new Database(resolvedDir, dbPath, raw);
    db.applyPragmas();
    db.migrate();
    return db;
  }

  /** Apply required connection pragmas. */
  private applyPragmas(): void {
    // WAL is a no-op for :memory: (reports "memory"); fine for tests.
    this.raw.exec(`PRAGMA journal_mode = WAL`);
    this.raw.exec(`PRAGMA foreign_keys = ON`);
    this.raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }

  /**
   * Run pending forward-only migrations. Each migration runs inside a
   * transaction with its `schema_migrations` insert. Re-running against an
   * up-to-date database is a no-op.
   */
  migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INTEGER PRIMARY KEY NOT NULL,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      (
        this.raw
          .prepare(`SELECT id FROM schema_migrations ORDER BY id`)
          .all() as Array<{ id: number }>
      ).map((r) => r.id),
    );

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;

      this.raw.exec("BEGIN");
      try {
        this.raw.exec(migration.sql);
        this.raw
          .prepare(
            `INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`,
          )
          .run(migration.id, migration.name, nowIso());
        this.raw.exec("COMMIT");
      } catch (err) {
        try {
          this.raw.exec("ROLLBACK");
        } catch {
          // ignore rollback errors
        }
        throw err;
      }
    }
  }

  /** Re-run migrations (idempotent). Useful for tests and readiness. */
  migrateAgain(): void {
    this.migrate();
  }

  /** True when a simple round-trip against the open connection succeeds. */
  isHealthy(): boolean {
    if (this.closed) return false;
    try {
      const row = this.raw.prepare("SELECT 1 AS ok").get() as
        | { ok: number }
        | undefined;
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  /** Close the underlying connection. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.raw.close();
    } catch {
      // already closed or never fully open
    }
  }

  /** Current journal mode (`wal` on file-backed DBs). */
  journalMode(): string {
    const row = this.raw.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    return row.journal_mode;
  }

  /** Whether foreign_keys pragma is on (1). */
  foreignKeysEnabled(): boolean {
    const row = this.raw.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    return row.foreign_keys === 1;
  }

  /** Applied migration rows, ordered by id. */
  listMigrations(): SchemaMigrationRow[] {
    return this.raw
      .prepare(
        `SELECT id, name, applied_at FROM schema_migrations ORDER BY id`,
      )
      .all() as SchemaMigrationRow[];
  }

  /**
   * List user tables (excludes `schema_migrations` and sqlite internals).
   * Used by migration tests.
   */
  listUserTables(): string[] {
    const rows = this.raw
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  // -------------------------------------------------------------------------
  // Scenes
  // -------------------------------------------------------------------------

  insertScene(input: NewScene): SceneRow {
    const created_at = input.created_at ?? nowIso();
    const updated_at = input.updated_at ?? created_at;
    const head_version = input.head_version ?? 0;
    const lock_holder = input.lock_holder ?? null;
    const lock_expires_at = input.lock_expires_at ?? null;
    const deleted_at = input.deleted_at ?? null;

    this.raw
      .prepare(
        `INSERT INTO scenes (
          id, slug, name, head_version, created_at, updated_at,
          lock_holder, lock_expires_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.slug,
        input.name,
        head_version,
        created_at,
        updated_at,
        lock_holder,
        lock_expires_at,
        deleted_at,
      );

    return this.getSceneById(input.id)!;
  }

  getSceneById(id: string): SceneRow | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM scenes WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapScene(row) : undefined;
  }

  /**
   * Live scene by slug (excludes soft-deleted). Public GET-by-slug path.
   */
  getSceneBySlug(slug: string): SceneRow | undefined {
    const row = this.raw
      .prepare(
        `SELECT * FROM scenes WHERE slug = ? AND deleted_at IS NULL`,
      )
      .get(slug) as Record<string, unknown> | undefined;
    return row ? mapScene(row) : undefined;
  }

  /**
   * Scene by slug including soft-deleted rows. Used for slug-occupation
   * checks and tests that assert rows survive soft delete.
   */
  getSceneBySlugIncludingDeleted(slug: string): SceneRow | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM scenes WHERE slug = ?`)
      .get(slug) as Record<string, unknown> | undefined;
    return row ? mapScene(row) : undefined;
  }

  /**
   * True when any scene row (live or soft-deleted) occupies `slug`.
   * Soft-deleted scenes still hold their slug under the UNIQUE constraint.
   */
  slugExists(slug: string): boolean {
    const row = this.raw
      .prepare(`SELECT 1 AS ok FROM scenes WHERE slug = ? LIMIT 1`)
      .get(slug) as { ok: number } | undefined;
    return row !== undefined;
  }

  /**
   * Live scenes ordered by recency, with head-version element_count joined.
   * Soft-deleted scenes are omitted.
   */
  listScenes(): SceneListRow[] {
    const rows = this.raw
      .prepare(
        `SELECT s.*,
                COALESCE(v.element_count, 0) AS element_count
         FROM scenes s
         LEFT JOIN versions v
           ON v.scene_id = s.id AND v.version = s.head_version
         WHERE s.deleted_at IS NULL
         ORDER BY s.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapSceneList);
  }

  /**
   * Live scene by slug with head element_count. Soft-deleted → undefined.
   */
  getSceneListRowBySlug(slug: string): SceneListRow | undefined {
    const row = this.raw
      .prepare(
        `SELECT s.*,
                COALESCE(v.element_count, 0) AS element_count
         FROM scenes s
         LEFT JOIN versions v
           ON v.scene_id = s.id AND v.version = s.head_version
         WHERE s.slug = ? AND s.deleted_at IS NULL`,
      )
      .get(slug) as Record<string, unknown> | undefined;
    return row ? mapSceneList(row) : undefined;
  }

  updateSceneHead(
    id: string,
    headVersion: number,
    updatedAt: string = nowIso(),
  ): void {
    this.raw
      .prepare(
        `UPDATE scenes SET head_version = ?, updated_at = ? WHERE id = ?`,
      )
      .run(headVersion, updatedAt, id);
  }

  setSceneLock(
    id: string,
    lockHolder: string | null,
    lockExpiresAt: string | null,
  ): void {
    this.raw
      .prepare(
        `UPDATE scenes SET lock_holder = ?, lock_expires_at = ? WHERE id = ?`,
      )
      .run(lockHolder, lockExpiresAt, id);
  }

  /**
   * Soft-delete a scene: set `deleted_at` so it vanishes from listings and
   * get-by-slug, while the row and all versions remain. Idempotent when
   * already soft-deleted (refreshes `deleted_at` only if currently null).
   * Returns true when a live row was marked deleted.
   */
  softDeleteScene(id: string, deletedAt: string = nowIso()): boolean {
    const result = this.raw
      .prepare(
        `UPDATE scenes SET deleted_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(deletedAt, id) as { changes: number };
    return Number(result.changes) > 0;
  }

  /**
   * Hard-delete a scene row (cascades to versions/drafts). Not used by the
   * HTTP API — soft delete is the only public delete path. Kept for tests
   * and eventual admin maintenance tooling.
   */
  deleteScene(id: string): void {
    this.raw.prepare(`DELETE FROM scenes WHERE id = ?`).run(id);
  }

  // -------------------------------------------------------------------------
  // Versions
  // -------------------------------------------------------------------------

  insertVersion(input: NewVersion): VersionRow {
    const created_at = input.created_at ?? nowIso();
    const file_ids = encodeFileIds(input.file_ids);
    const element_count = input.element_count ?? 0;
    const scene_hash = input.scene_hash ?? "";
    const elements = asBuffer(input.elements);
    const app_state = asBuffer(input.app_state);

    this.raw
      .prepare(
        `INSERT INTO versions (
          scene_id, version, parent_version, author, message, created_at,
          elements, app_state, file_ids, element_count, scene_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.scene_id,
        input.version,
        input.parent_version,
        input.author,
        input.message,
        created_at,
        elements,
        app_state,
        file_ids,
        element_count,
        scene_hash,
      );

    return this.getVersion(input.scene_id, input.version)!;
  }

  getVersion(sceneId: string, version: number): VersionRow | undefined {
    const row = this.raw
      .prepare(
        `SELECT * FROM versions WHERE scene_id = ? AND version = ?`,
      )
      .get(sceneId, version) as Record<string, unknown> | undefined;
    return row ? mapVersion(row) : undefined;
  }

  listVersions(sceneId: string): VersionRow[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM versions WHERE scene_id = ? ORDER BY version ASC`,
      )
      .all(sceneId) as Array<Record<string, unknown>>;
    return rows.map(mapVersion);
  }

  /**
   * Union of every content-addressed file id referenced by any version row.
   * Used by the file-store GC helper (unreferenced + older-than-N-days).
   * Drafts are intentionally excluded — only committed history anchors files.
   */
  listReferencedFileIds(): string[] {
    const rows = this.raw
      .prepare(`SELECT file_ids FROM versions`)
      .all() as Array<{ file_ids: string }>;

    const ids = new Set<string>();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.file_ids ?? "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const id of parsed) {
        if (typeof id === "string" && id.length > 0) {
          ids.add(id);
        }
      }
    }
    return [...ids];
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  upsertDraft(input: UpsertDraft): DraftRow {
    const updated_at = input.updated_at ?? nowIso();
    const file_ids = encodeFileIds(input.file_ids);
    const elements = asBuffer(input.elements);
    const app_state = asBuffer(input.app_state);

    this.raw
      .prepare(
        `INSERT INTO drafts (
          scene_id, elements, app_state, file_ids, updated_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scene_id) DO UPDATE SET
          elements = excluded.elements,
          app_state = excluded.app_state,
          file_ids = excluded.file_ids,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`,
      )
      .run(
        input.scene_id,
        elements,
        app_state,
        file_ids,
        updated_at,
        input.updated_by,
      );

    return this.getDraft(input.scene_id)!;
  }

  getDraft(sceneId: string): DraftRow | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM drafts WHERE scene_id = ?`)
      .get(sceneId) as Record<string, unknown> | undefined;
    return row ? mapDraft(row) : undefined;
  }

  deleteDraft(sceneId: string): void {
    this.raw.prepare(`DELETE FROM drafts WHERE scene_id = ?`).run(sceneId);
  }

  // -------------------------------------------------------------------------
  // Meta (key/value flags)
  // -------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.raw
      .prepare(`SELECT value FROM meta WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  insertToken(input: NewToken): TokenRow {
    const created_at = input.created_at ?? nowIso();
    const last_used_at = input.last_used_at ?? null;
    const is_admin = input.is_admin ? 1 : 0;

    this.raw
      .prepare(
        `INSERT INTO tokens (id, name, token_hash, created_at, last_used_at, is_admin)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.token_hash,
        created_at,
        last_used_at,
        is_admin,
      );

    return this.getTokenById(input.id)!;
  }

  getTokenById(id: string): TokenRow | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM tokens WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapToken(row) : undefined;
  }

  getTokenByHash(tokenHash: string): TokenRow | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM tokens WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, unknown> | undefined;
    return row ? mapToken(row) : undefined;
  }

  listTokens(): TokenRow[] {
    const rows = this.raw
      .prepare(`SELECT * FROM tokens ORDER BY created_at ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(mapToken);
  }

  touchToken(id: string, lastUsedAt: string = nowIso()): void {
    this.raw
      .prepare(`UPDATE tokens SET last_used_at = ? WHERE id = ?`)
      .run(lastUsedAt, id);
  }

  deleteToken(id: string): void {
    this.raw.prepare(`DELETE FROM tokens WHERE id = ?`).run(id);
  }

  /**
   * First-boot bootstrap seed in a single transaction:
   * - If `bootstrap_completed` meta is already set, no-op.
   * - If the tokens table is empty, insert the admin token (`is_admin = 1`).
   * - Always set `bootstrap_completed` so a later boot never re-seeds,
   *   even after the admin token is revoked.
   *
   * Token insert and meta flag share one transaction so they cannot disagree.
   * Returns true when a new admin row was inserted.
   */
  runBootstrapSeed(input: {
    id: string;
    name: string;
    token_hash: string;
  }): boolean {
    this.raw.exec("BEGIN");
    try {
      const existing = this.raw
        .prepare(`SELECT value FROM meta WHERE key = ?`)
        .get(META_BOOTSTRAP_COMPLETED) as { value: string } | undefined;
      if (existing?.value === "1") {
        this.raw.exec("COMMIT");
        return false;
      }

      const countRow = this.raw
        .prepare(`SELECT COUNT(*) AS n FROM tokens`)
        .get() as { n: number };
      const tokenCount = Number(countRow.n);

      let seeded = false;
      if (tokenCount === 0) {
        const hashHit = this.raw
          .prepare(`SELECT id FROM tokens WHERE token_hash = ?`)
          .get(input.token_hash) as { id: string } | undefined;
        if (!hashHit) {
          this.raw
            .prepare(
              `INSERT INTO tokens (id, name, token_hash, created_at, last_used_at, is_admin)
               VALUES (?, ?, ?, ?, NULL, 1)`,
            )
            .run(input.id, input.name, input.token_hash, nowIso());
          seeded = true;
        }
      }

      this.raw
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(META_BOOTSTRAP_COMPLETED, "1");

      this.raw.exec("COMMIT");
      return seeded;
    } catch (err) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
      throw err;
    }
  }
}

function mapScene(row: Record<string, unknown> | SceneRow): SceneRow {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    head_version: Number(r.head_version),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    lock_holder:
      r.lock_holder === null || r.lock_holder === undefined
        ? null
        : String(r.lock_holder),
    lock_expires_at:
      r.lock_expires_at === null || r.lock_expires_at === undefined
        ? null
        : String(r.lock_expires_at),
    deleted_at:
      r.deleted_at === null || r.deleted_at === undefined
        ? null
        : String(r.deleted_at),
  };
}

function mapSceneList(row: Record<string, unknown>): SceneListRow {
  return {
    ...mapScene(row),
    element_count: Number(row.element_count ?? 0),
  };
}

function mapVersion(row: Record<string, unknown>): VersionRow {
  return {
    scene_id: String(row.scene_id),
    version: Number(row.version),
    parent_version:
      row.parent_version === null || row.parent_version === undefined
        ? null
        : Number(row.parent_version),
    author: String(row.author),
    message: String(row.message ?? ""),
    created_at: String(row.created_at),
    elements: blobToBuffer(row.elements),
    app_state: blobToBuffer(row.app_state),
    file_ids: String(row.file_ids ?? "[]"),
    element_count: Number(row.element_count ?? 0),
    scene_hash: String(row.scene_hash ?? ""),
  };
}

function mapDraft(row: Record<string, unknown>): DraftRow {
  return {
    scene_id: String(row.scene_id),
    elements: blobToBuffer(row.elements),
    app_state: blobToBuffer(row.app_state),
    file_ids: String(row.file_ids ?? "[]"),
    updated_at: String(row.updated_at),
    updated_by: String(row.updated_by),
  };
}

function mapToken(row: Record<string, unknown>): TokenRow {
  return {
    id: String(row.id),
    name: String(row.name),
    token_hash: String(row.token_hash),
    created_at: String(row.created_at),
    last_used_at:
      row.last_used_at === null || row.last_used_at === undefined
        ? null
        : String(row.last_used_at),
    is_admin: Number(row.is_admin ?? 0) === 1,
  };
}

/** Convenience alias matching the issue brief. */
export function openDatabase(
  dataDir: string,
  options?: OpenDatabaseOptions,
): Database {
  return Database.open(dataDir, options);
}
