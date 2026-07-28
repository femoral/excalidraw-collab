/**
 * Content-addressed binary file store and HTTP routes.
 *
 * Excalidraw's `fileId` is the SHA-1 hex digest of the raw file bytes
 * (`generateIdFromFile` in @excalidraw/excalidraw). We verify that claim
 * before accepting an upload so a client cannot store content under an id
 * that does not describe it. Storage layout under DATA_DIR:
 *
 *   files/<fileId>       raw bytes
 *   files/<fileId>.json  sidecar { mimeType, created }
 *
 * Dedup is free: putting the same content twice writes one object.
 *
 * ---------------------------------------------------------------------------
 * Upstream nanoid fallback — do not "fix" by accepting unverified ids
 * ---------------------------------------------------------------------------
 * `generateIdFromFile` is approximately:
 *
 *   try {
 *     const hash = await crypto.subtle.digest("SHA-1", bytes);
 *     return bytesToHexString(hash);          // 40-char lowercase hex
 *   } catch {
 *     return nanoid(40);                      // random, NOT a content hash
 *   }
 *
 * `window.crypto.subtle` is undefined outside a **secure context** (HTTPS or
 * localhost). A homelab deploy over plain HTTP on a LAN IP therefore hits the
 * catch path for every pasted image and gets a random 40-char id that is not
 * necessarily hex and never matches SHA-1(content).
 *
 * We deliberately refuse those uploads. Content-addressing only works if the
 * id describes the bytes; accepting nanoid ids would re-store every "same"
 * image under a new key and break the 20-version/3 MB footprint goal.
 * Instead we reject with a distinct error (`reason: "non_secure_context_nanoid"`)
 * that tells the operator to serve the app over HTTPS or from localhost so
 * SubtleCrypto is available. A well-formed hex id that simply does not match
 * the content is a different failure (`reason: "content_hash_mismatch"`).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { createAuthPreHandler } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { AppError, ErrorCode } from "./errors.js";

/** Subdirectory of DATA_DIR holding content-addressed blobs. */
export const FILES_SUBDIR = "files";

/** Sidecar suffix for mimeType / created metadata. */
export const SIDECAR_SUFFIX = ".json";

/**
 * Excalidraw fileId = lowercase SHA-1 hex of raw bytes (40 chars).
 * @see generateIdFromFile in @excalidraw/excalidraw
 */
export const FILE_ID_HEX_RE = /^[0-9a-f]{40}$/;

/**
 * Error `details.reason` when the claimed id is 40-char hex but does not
 * equal SHA-1(content) — corruption, client bug, or intentional spoof.
 */
export const FILE_ID_REASON_HASH_MISMATCH = "content_hash_mismatch" as const;

/**
 * Error `details.reason` when the claimed id is not 40-char hex at all.
 * Strong signal that Excalidraw fell back to `nanoid(40)` because
 * `window.crypto.subtle` was unavailable (non-secure context).
 */
export const FILE_ID_REASON_NON_SECURE_NANOID = "non_secure_context_nanoid" as const;

export type FileIdMismatchReason =
  typeof FILE_ID_REASON_HASH_MISMATCH | typeof FILE_ID_REASON_NON_SECURE_NANOID;

export type FileIdMismatchDetails = {
  reason: FileIdMismatchReason;
  claimed: string;
  computed: string;
};

/** Long-lived immutable cache for content-addressed GET responses. */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

export type FileSidecar = {
  mimeType: string;
  /** Epoch milliseconds (matches Excalidraw BinaryFileData.created). */
  created: number;
};

export type StoredFile = {
  fileId: string;
  bytes: Buffer;
  mimeType: string;
  created: number;
  byteLength: number;
};

export type PutFileResult = {
  fileId: string;
  /** True when this call wrote a new blob; false when it already existed. */
  created: boolean;
  byteLength: number;
  mimeType: string;
};

export type GcOptions = {
  /** Delete unreferenced files whose sidecar `created` is older than this. */
  olderThanDays: number;
  /**
   * File ids currently referenced by any version. When omitted, the store
   * cannot decide reachability — pass the result of
   * `Database.listReferencedFileIds()`.
   */
  referencedFileIds: ReadonlySet<string> | readonly string[];
  /** Clock override for tests (epoch ms). Defaults to Date.now(). */
  nowMs?: number;
};

export type GcResult = {
  /** fileIds removed from disk. */
  deleted: string[];
  /** Unreferenced but still within the retention window. */
  retainedRecent: string[];
  /** Still referenced by at least one version. */
  retainedReferenced: string[];
  /** Sidecar/content pairs that looked corrupt and were skipped. */
  skipped: string[];
};

// ---------------------------------------------------------------------------
// Hash / dataURL helpers (match Excalidraw generateIdFromFile)
// ---------------------------------------------------------------------------

/** SHA-1 hex digest of raw bytes — Excalidraw's fileId derivation. */
export function hashFileContent(bytes: Buffer | Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

/**
 * Decode a `data:` URL into raw bytes. Accepts standard base64 data URLs
 * as produced by Excalidraw (`data:<mime>;base64,...`).
 */
export function decodeDataURL(dataURL: string): {
  mimeType: string;
  bytes: Buffer;
} {
  if (typeof dataURL !== "string" || !dataURL.startsWith("data:")) {
    throw new AppError(ErrorCode.VALIDATION, "dataURL must be a data: URL string", 400);
  }
  const comma = dataURL.indexOf(",");
  if (comma < 0) {
    throw new AppError(ErrorCode.VALIDATION, "dataURL is missing payload", 400);
  }
  const header = dataURL.slice(5, comma); // after "data:"
  const payload = dataURL.slice(comma + 1);
  const parts = header.split(";");
  const mimeType = parts[0] && parts[0].length > 0 ? parts[0] : "application/octet-stream";
  const isBase64 = parts.some((p) => p.trim().toLowerCase() === "base64");
  let bytes: Buffer;
  try {
    bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
  } catch {
    throw new AppError(ErrorCode.VALIDATION, "dataURL payload could not be decoded", 400);
  }
  return { mimeType, bytes };
}

function assertValidFileId(fileId: string): void {
  if (!FILE_ID_HEX_RE.test(fileId)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      `fileId must be a 40-char lowercase SHA-1 hex digest; got ${JSON.stringify(fileId)}`,
      400,
    );
  }
}

/**
 * Reject a claimed fileId that does not equal the computed content hash.
 * Splits well-formed-hex mismatch from non-hex (nanoid / non-secure context)
 * so operators get an actionable message instead of a silent upload failure.
 *
 * Never accept the claimed id as authoritative — verification stays strict.
 */
export function claimedFileIdMismatchError(claimed: string, computed: string): AppError {
  if (!FILE_ID_HEX_RE.test(claimed)) {
    const details: FileIdMismatchDetails = {
      reason: FILE_ID_REASON_NON_SECURE_NANOID,
      claimed,
      computed,
    };
    return new AppError(
      ErrorCode.VALIDATION,
      "claimed fileId is not a content hash (expected 40-char lowercase SHA-1 hex). " +
        "Excalidraw's generateIdFromFile falls back to nanoid(40) when " +
        "window.crypto.subtle is unavailable — common when the app is served " +
        "over plain HTTP on a LAN address. Serve the app over HTTPS or from " +
        "localhost so SubtleCrypto works; do not expect the server to accept " +
        "random (non-hash) file ids.",
      400,
      details,
    );
  }

  const details: FileIdMismatchDetails = {
    reason: FILE_ID_REASON_HASH_MISMATCH,
    claimed,
    computed,
  };
  return new AppError(ErrorCode.VALIDATION, "fileId does not match content hash", 400, details);
}

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

/**
 * Content-addressed blob store under `dataDir/files/`.
 * Safe for concurrent put of the same id (atomic rename; last writer wins
 * with identical content after hash verification).
 */
export class FileStore {
  readonly rootDir: string;
  readonly maxFileBytes: number;

  constructor(dataDir: string, maxFileBytes: number) {
    this.rootDir = path.resolve(dataDir, FILES_SUBDIR);
    this.maxFileBytes = maxFileBytes;
    mkdirSync(this.rootDir, { recursive: true });
  }

  contentPath(fileId: string): string {
    assertValidFileId(fileId);
    return path.join(this.rootDir, fileId);
  }

  sidecarPath(fileId: string): string {
    assertValidFileId(fileId);
    return path.join(this.rootDir, fileId + SIDECAR_SUFFIX);
  }

  exists(fileId: string): boolean {
    if (!FILE_ID_HEX_RE.test(fileId)) return false;
    return existsSync(this.contentPath(fileId));
  }

  /**
   * Store bytes under their content hash. If `claimedFileId` is provided it
   * must equal `hashFileContent(bytes)`. Idempotent: re-uploading existing
   * content is a no-op on disk and returns `created: false`.
   */
  put(input: {
    bytes: Buffer;
    mimeType: string;
    created?: number;
    claimedFileId?: string;
  }): PutFileResult {
    const { bytes, mimeType } = input;
    if (!Buffer.isBuffer(bytes)) {
      throw new AppError(ErrorCode.BAD_REQUEST, "file body must be binary", 400);
    }
    if (bytes.byteLength > this.maxFileBytes) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `file exceeds size limit of ${this.maxFileBytes} bytes`,
        413,
        {
          maxFileBytes: this.maxFileBytes,
          actualBytes: bytes.byteLength,
        },
      );
    }
    if (typeof mimeType !== "string" || mimeType.length === 0) {
      throw new AppError(ErrorCode.VALIDATION, "mimeType is required", 400);
    }

    const fileId = hashFileContent(bytes);
    if (input.claimedFileId !== undefined) {
      if (input.claimedFileId !== fileId) {
        throw claimedFileIdMismatchError(input.claimedFileId, fileId);
      }
    }

    const contentPath = this.contentPath(fileId);
    const sidecarPath = this.sidecarPath(fileId);
    const alreadyThere = existsSync(contentPath);

    if (!alreadyThere) {
      // Atomic write: temp file in the same directory, then rename.
      const tmpPath = path.join(this.rootDir, `.${fileId}.${process.pid}.${Date.now()}.tmp`);
      try {
        const fd = openSync(tmpPath, "w");
        try {
          writeSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmpPath, contentPath);
      } catch (err) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // ignore cleanup errors
        }
        throw err;
      }
    }

    // Write sidecar only when missing (first-seen mimeType/created win).
    if (!existsSync(sidecarPath)) {
      const created =
        input.created !== undefined && Number.isFinite(input.created)
          ? Math.trunc(input.created)
          : Date.now();
      const sidecar: FileSidecar = { mimeType, created };
      writeFileSync(sidecarPath, JSON.stringify(sidecar), "utf8");
    }

    return {
      fileId,
      created: !alreadyThere,
      byteLength: bytes.byteLength,
      mimeType,
    };
  }

  get(fileId: string): StoredFile | undefined {
    if (!FILE_ID_HEX_RE.test(fileId)) return undefined;
    const contentPath = this.contentPath(fileId);
    if (!existsSync(contentPath)) return undefined;

    const bytes = readFileSync(contentPath);
    let mimeType = "application/octet-stream";
    let created = 0;
    const sidecarPath = this.sidecarPath(fileId);
    if (existsSync(sidecarPath)) {
      try {
        const raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as Partial<FileSidecar>;
        if (typeof raw.mimeType === "string" && raw.mimeType.length > 0) {
          mimeType = raw.mimeType;
        }
        if (typeof raw.created === "number" && Number.isFinite(raw.created)) {
          created = raw.created;
        }
      } catch {
        // tolerate corrupt sidecar
      }
    }

    return {
      fileId,
      bytes,
      mimeType,
      created,
      byteLength: bytes.byteLength,
    };
  }

  /**
   * List fileIds present on disk (content files only; skips sidecars/temps).
   */
  listStoredFileIds(): string[] {
    if (!existsSync(this.rootDir)) return [];
    return readdirSync(this.rootDir).filter((name) => FILE_ID_HEX_RE.test(name));
  }

  /**
   * Sum of on-disk byte sizes for content blobs (excludes sidecars).
   * Used by the multi-version footprint regression test.
   */
  totalContentBytes(): number {
    let total = 0;
    for (const id of this.listStoredFileIds()) {
      try {
        total += statSync(this.contentPath(id)).size;
      } catch {
        // race with delete — ignore
      }
    }
    return total;
  }

  /**
   * Garbage-collect unreferenced files older than `olderThanDays`.
   * Referenced files always survive. Unreferenced but recent files survive.
   * Does not touch drafts — only the provided reference set matters.
   */
  gc(options: GcOptions): GcResult {
    if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 0) {
      throw new AppError(ErrorCode.VALIDATION, "olderThanDays must be a non-negative number", 400);
    }

    const referenced =
      options.referencedFileIds instanceof Set
        ? options.referencedFileIds
        : new Set(options.referencedFileIds);
    const nowMs = options.nowMs ?? Date.now();
    const cutoffMs = nowMs - options.olderThanDays * 24 * 60 * 60 * 1000;

    const deleted: string[] = [];
    const retainedRecent: string[] = [];
    const retainedReferenced: string[] = [];
    const skipped: string[] = [];

    for (const fileId of this.listStoredFileIds()) {
      if (referenced.has(fileId)) {
        retainedReferenced.push(fileId);
        continue;
      }

      const sidecarPath = this.sidecarPath(fileId);
      let created = 0;
      if (existsSync(sidecarPath)) {
        try {
          const raw = JSON.parse(readFileSync(sidecarPath, "utf8")) as Partial<FileSidecar>;
          if (typeof raw.created === "number" && Number.isFinite(raw.created)) {
            created = raw.created;
          } else {
            // Fall back to content mtime when sidecar lacks created.
            created = statSync(this.contentPath(fileId)).mtimeMs;
          }
        } catch {
          skipped.push(fileId);
          continue;
        }
      } else {
        try {
          created = statSync(this.contentPath(fileId)).mtimeMs;
        } catch {
          skipped.push(fileId);
          continue;
        }
      }

      if (created > cutoffMs) {
        retainedRecent.push(fileId);
        continue;
      }

      try {
        unlinkSync(this.contentPath(fileId));
        if (existsSync(sidecarPath)) {
          unlinkSync(sidecarPath);
        }
        deleted.push(fileId);
      } catch {
        skipped.push(fileId);
      }
    }

    return { deleted, retainedRecent, retainedReferenced, skipped };
  }
}

/**
 * Convenience wrapper: run GC using the database's version-level references.
 */
export function gcUnreferencedFiles(
  store: FileStore,
  db: Database,
  olderThanDays: number,
  nowMs?: number,
): GcResult {
  return store.gc({
    olderThanDays,
    referencedFileIds: db.listReferencedFileIds(),
    nowMs,
  });
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

type BinaryFileDataBody = {
  id?: string;
  mimeType?: string;
  dataURL?: string;
  created?: number;
  lastRetrieved?: number;
  version?: number;
};

/**
 * Register POST /api/files and GET /api/files/:fileId under Bearer auth.
 */
export async function registerFileRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    store: FileStore;
    config: Config;
  },
): Promise<void> {
  const authPreHandler: preHandlerHookHandler = createAuthPreHandler(deps.db);
  const { store } = deps;

  // Accept raw binary bodies for image/* and application/octet-stream.
  // JSON remains the default Fastify parser.
  const rawParser = (
    _req: FastifyRequest,
    body: Buffer,
    done: (err: Error | null, body?: Buffer) => void,
  ): void => {
    done(null, body);
  };
  app.addContentTypeParser(
    /^image\/.*/,
    { parseAs: "buffer", bodyLimit: deps.config.maxFileBytes },
    rawParser,
  );
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: deps.config.maxFileBytes },
    rawParser,
  );

  await app.register(
    async (api) => {
      api.addHook("preHandler", authPreHandler);

      api.post(
        "/files",
        {
          // Raise limit for JSON dataURL payloads (base64 expands ~4/3).
          bodyLimit: Math.ceil(deps.config.maxFileBytes * 1.4) + 4096,
        },
        async (request, reply) => {
          return handleUpload(request, reply, store);
        },
      );

      api.get<{ Params: { fileId: string } }>("/files/:fileId", async (request, reply) => {
        const { fileId } = request.params;
        if (!FILE_ID_HEX_RE.test(fileId)) {
          throw new AppError(ErrorCode.NOT_FOUND, `file not found: ${fileId}`, 404);
        }
        const stored = store.get(fileId);
        if (!stored) {
          throw new AppError(ErrorCode.NOT_FOUND, `file not found: ${fileId}`, 404);
        }
        return reply
          .status(200)
          .header("Content-Type", stored.mimeType)
          .header("Content-Length", stored.byteLength)
          .header("Cache-Control", IMMUTABLE_CACHE_CONTROL)
          .header("ETag", `"${fileId}"`)
          .send(stored.bytes);
      });
    },
    { prefix: "/api" },
  );
}

async function handleUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  store: FileStore,
): Promise<unknown> {
  const contentType = (request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();

  // --- Raw bytes path ---
  if (contentType === "application/octet-stream" || contentType.startsWith("image/")) {
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new AppError(ErrorCode.BAD_REQUEST, "raw upload body must be binary", 400);
    }
    const claimedHeader = request.headers["x-file-id"];
    const claimedFileId =
      typeof claimedHeader === "string" && claimedHeader.length > 0 ? claimedHeader : undefined;
    // Do not pre-filter non-hex ids here: put() rejects with the
    // non_secure_context_nanoid vs content_hash_mismatch distinction.
    const result = store.put({
      bytes: body,
      mimeType: contentType || "application/octet-stream",
      claimedFileId,
    });
    return reply.status(result.created ? 201 : 200).send({
      fileId: result.fileId,
      mimeType: result.mimeType,
      byteLength: result.byteLength,
      created: result.created,
    });
  }

  // --- JSON BinaryFileData path ---
  if (contentType === "application/json" || contentType === "" || contentType.endsWith("+json")) {
    const body = request.body as BinaryFileDataBody | undefined;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new AppError(ErrorCode.VALIDATION, "JSON body must be a BinaryFileData object", 400);
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      throw new AppError(ErrorCode.VALIDATION, "id is required", 400);
    }
    if (typeof body.mimeType !== "string" || body.mimeType.length === 0) {
      throw new AppError(ErrorCode.VALIDATION, "mimeType is required", 400);
    }
    if (typeof body.dataURL !== "string" || body.dataURL.length === 0) {
      throw new AppError(ErrorCode.VALIDATION, "dataURL is required", 400);
    }

    const decoded = decodeDataURL(body.dataURL);
    // Prefer the explicit mimeType field when present; dataURL header is fallback.
    const mimeType = body.mimeType || decoded.mimeType;
    // Claimed id verified in put() with distinct mismatch reasons (see module header).
    const result = store.put({
      bytes: decoded.bytes,
      mimeType,
      created: typeof body.created === "number" ? body.created : undefined,
      claimedFileId: body.id,
    });
    return reply.status(result.created ? 201 : 200).send({
      fileId: result.fileId,
      mimeType: result.mimeType,
      byteLength: result.byteLength,
      created: result.created,
    });
  }

  throw new AppError(
    ErrorCode.BAD_REQUEST,
    `unsupported Content-Type for file upload: ${contentType || "(missing)"}`,
    415,
  );
}
