/**
 * Thin HTTP client for the collab server API.
 *
 * Mirrors wire shapes from `packages/server`. On any 401 the configured
 * `onUnauthorized` callback runs (clears token + resets UI state); callers
 * must not leave half-rendered authenticated UI on screen after that.
 */

/** Wire shape for scene list items (camelCase, matches server SceneInfo). */
export type SceneInfo = {
  id: string;
  slug: string;
  name: string;
  headVersion: number;
  createdAt: string;
  updatedAt: string;
  lock: {
    holder: string;
    expiresAt: string;
  } | null;
  elementCount: number;
  headAuthor: string | null;
};

export type SceneListResponse = {
  scenes: SceneInfo[];
};

/** Full `.excalidraw` document returned by GET /scene. */
export type SceneDocumentResponse = {
  type?: string;
  version?: number;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, BinaryFilePayload>;
};

/** Wire shape for GET/PUT draft. */
export type DraftResponse = {
  elements: unknown[];
  appState: Record<string, unknown>;
  fileIds: string[];
  updatedAt: string;
  updatedBy: string;
  basedOnVersion: number;
  headVersion: number;
  stale: boolean;
};

export type PutDraftBody = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  fileIds?: string[];
  basedOnVersion?: number;
};

export type CommitSceneBody = {
  parentVersion: number;
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, BinaryFilePayload>;
  message: string;
};

export type CommitSceneResponse = {
  version: number;
  parentVersion: number | null;
  author: string;
  message: string;
  createdAt: string;
  elementCount: number;
  sceneHash: string;
  headVersion: number;
};

/** Excalidraw BinaryFileData-shaped payload for /api/files and scene push. */
export type BinaryFilePayload = {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
};

export type FileUploadResponse = {
  fileId: string;
  mimeType: string;
  byteLength: number;
  created: number;
};

export type ServerErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === "UNAUTHORIZED";
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === "NOT_FOUND";
  }

  get isConflict(): boolean {
    return this.status === 409 || this.code === "CONFLICT";
  }
}

function isServerErrorBody(value: unknown): value is ServerErrorBody {
  if (value === null || typeof value !== "object") return false;
  const err = (value as { error?: unknown }).error;
  if (err === null || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  return typeof e.code === "string" && typeof e.message === "string";
}

export type ApiClientOptions = {
  /** Absolute or relative base (default `""` so `/api/...` hits the same origin / Vite proxy). */
  baseUrl?: string;
  getToken: () => string | null;
  /**
   * Invoked exactly once per 401 response, before the rejection propagates.
   * Should clear the token and bounce UI to login with clean state.
   */
  onUnauthorized: () => void;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type RequestOptions = {
  method?: string;
  body?: unknown;
  /** When true, skip attaching Authorization (unused today; reserved). */
  skipAuth?: boolean;
  /** Override Accept / Content-Type for non-JSON bodies. */
  headers?: Record<string, string>;
  /** When true, return raw Response body as ArrayBuffer (binary GET). */
  binary?: boolean;
};

/**
 * Build a request URL from base + path. Paths should start with `/`.
 */
export function buildApiUrl(baseUrl: string, path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function throwHttpError(
  status: number,
  statusText: string,
  parsed: unknown,
  onUnauthorized: () => void,
): never {
  if (status === 401) {
    onUnauthorized();
  }

  if (isServerErrorBody(parsed)) {
    throw new ApiError(
      status,
      parsed.error.code,
      parsed.error.message,
      parsed.error.details,
    );
  }

  throw new ApiError(
    status,
    "ERROR",
    typeof parsed === "string" && parsed.length > 0
      ? parsed
      : `HTTP ${status} ${statusText}`,
  );
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) {
      headers.set("Accept", init.binary ? "*/*" : "application/json");
    }

    if (!init.skipAuth) {
      const token = options.getToken();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    }

    let body: string | undefined;
    if (init.body !== undefined) {
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      body =
        typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body);
    }

    const response = await fetchImpl(buildApiUrl(baseUrl, path), {
      method: init.method ?? "GET",
      headers,
      body,
    });

    if (init.binary) {
      if (!response.ok) {
        const text = await response.text();
        let parsed: unknown = text;
        if (text.length > 0) {
          try {
            parsed = JSON.parse(text) as unknown;
          } catch {
            parsed = text;
          }
        }
        throwHttpError(
          response.status,
          response.statusText,
          parsed,
          options.onUnauthorized,
        );
      }
      const buf = await response.arrayBuffer();
      return {
        bytes: buf,
        mimeType:
          response.headers.get("Content-Type") ?? "application/octet-stream",
      } as T;
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throwHttpError(
        response.status,
        response.statusText,
        parsed,
        options.onUnauthorized,
      );
    }

    // 204 No Content and empty bodies.
    if (response.status === 204 || text.length === 0) {
      return undefined as T;
    }

    return parsed as T;
  }

  return {
    request,

    /** Probe that the current token is accepted. */
    async verifySession(): Promise<void> {
      await request<SceneListResponse>("/api/scenes");
    },

    async listScenes(): Promise<SceneInfo[]> {
      const body = await request<SceneListResponse>("/api/scenes");
      return body.scenes;
    },

    async createScene(input: {
      name: string;
      slug?: string;
    }): Promise<SceneInfo> {
      return request<SceneInfo>("/api/scenes", {
        method: "POST",
        body: input.slug !== undefined ? input : { name: input.name },
      });
    },

    async getSceneMeta(slug: string): Promise<SceneInfo> {
      return request<SceneInfo>(`/api/scenes/${encodeURIComponent(slug)}`);
    },

    async renameScene(slug: string, name: string): Promise<SceneInfo> {
      return request<SceneInfo>(
        `/api/scenes/${encodeURIComponent(slug)}`,
        {
          method: "PATCH",
          body: { name },
        },
      );
    },

    async deleteScene(slug: string): Promise<void> {
      await request<void>(`/api/scenes/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
    },

    /** Full head (or versioned) scene document, files rehydrated. */
    async getSceneDocument(
      slug: string,
      version?: number | string,
    ): Promise<SceneDocumentResponse> {
      const qs =
        version === undefined
          ? ""
          : `?v=${encodeURIComponent(String(version))}`;
      return request<SceneDocumentResponse>(
        `/api/scenes/${encodeURIComponent(slug)}/scene${qs}`,
      );
    },

    /**
     * Push a committed turn. Author is taken from the token server-side.
     * On 409 the ApiError.details carries the conflict diff.
     */
    async commitScene(
      slug: string,
      body: CommitSceneBody,
    ): Promise<CommitSceneResponse> {
      return request<CommitSceneResponse>(
        `/api/scenes/${encodeURIComponent(slug)}/scene`,
        { method: "POST", body },
      );
    },

    async getDraft(slug: string): Promise<DraftResponse | null> {
      try {
        return await request<DraftResponse>(
          `/api/scenes/${encodeURIComponent(slug)}/draft`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.isNotFound) {
          return null;
        }
        throw err;
      }
    },

    async putDraft(slug: string, body: PutDraftBody): Promise<DraftResponse> {
      return request<DraftResponse>(
        `/api/scenes/${encodeURIComponent(slug)}/draft`,
        { method: "PUT", body },
      );
    },

    async deleteDraft(slug: string): Promise<void> {
      try {
        await request<void>(
          `/api/scenes/${encodeURIComponent(slug)}/draft`,
          { method: "DELETE" },
        );
      } catch (err) {
        // Idempotent: already-cleared draft is fine (commit clears it too).
        if (err instanceof ApiError && err.isNotFound) {
          return;
        }
        throw err;
      }
    },

    /**
     * Upload a BinaryFileData-shaped payload. Server verifies claimed id is
     * SHA-1(content); non-secure-context nanoid ids fail with a clear message.
     */
    async uploadFile(file: BinaryFilePayload): Promise<FileUploadResponse> {
      return request<FileUploadResponse>("/api/files", {
        method: "POST",
        body: file,
      });
    },

    /** Fetch raw file bytes for rehydration into Excalidraw BinaryFiles. */
    async getFileBytes(
      fileId: string,
    ): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
      return request<{ bytes: ArrayBuffer; mimeType: string }>(
        `/api/files/${encodeURIComponent(fileId)}`,
        { binary: true },
      );
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
