/**
 * Thin HTTP client for the collab server API.
 *
 * Mirrors wire shapes from `packages/server/src/scenes.ts`. On any 401 the
 * configured `onUnauthorized` callback runs (clears token + resets UI state);
 * callers must not leave half-rendered lists on screen after that.
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

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl ?? "";
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    init: RequestOptions = {},
  ): Promise<T> {
    const headers = new Headers();
    headers.set("Accept", "application/json");

    if (!init.skipAuth) {
      const token = options.getToken();
      if (token) {
        headers.set("Authorization", `Bearer ${token}`);
      }
    }

    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.body);
    }

    const response = await fetchImpl(buildApiUrl(baseUrl, path), {
      method: init.method ?? "GET",
      headers,
      body,
    });

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
      if (response.status === 401) {
        options.onUnauthorized();
      }

      if (isServerErrorBody(parsed)) {
        throw new ApiError(
          response.status,
          parsed.error.code,
          parsed.error.message,
          parsed.error.details,
        );
      }

      throw new ApiError(
        response.status,
        "ERROR",
        typeof parsed === "string" && parsed.length > 0
          ? parsed
          : `HTTP ${response.status} ${response.statusText}`,
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
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
