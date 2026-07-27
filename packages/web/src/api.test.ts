import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApiError,
  buildApiUrl,
  createApiClient,
  type SceneInfo,
} from "./api.ts";

function scene(overrides: Partial<SceneInfo> = {}): SceneInfo {
  return {
    id: "id-1",
    slug: "arch",
    name: "Architecture",
    headVersion: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    lock: null,
    elementCount: 3,
    headAuthor: "admin",
    ...overrides,
  };
}

test("buildApiUrl joins base and path", () => {
  assert.equal(buildApiUrl("", "/api/scenes"), "/api/scenes");
  assert.equal(
    buildApiUrl("http://localhost:3000", "/api/scenes"),
    "http://localhost:3000/api/scenes",
  );
  assert.equal(
    buildApiUrl("http://localhost:3000/", "/api/scenes"),
    "http://localhost:3000/api/scenes",
  );
});

test("api client attaches Bearer and returns scenes", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const client = createApiClient({
    getToken: () => "my-token",
    onUnauthorized: () => {
      assert.fail("should not unauthorized");
    },
    fetchImpl: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      return new Response(
        JSON.stringify({ scenes: [scene()] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const scenes = await client.listScenes();
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0]!.slug, "arch");
  assert.equal(calls[0]!.url, "/api/scenes");
  assert.equal(calls[0]!.headers.get("Authorization"), "Bearer my-token");
});

test("401 clears via onUnauthorized and rejects with ApiError", async () => {
  let unauthorizedCalls = 0;
  const client = createApiClient({
    getToken: () => "revoked",
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "invalid or revoked token" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  });

  await assert.rejects(
    () => client.listScenes(),
    (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 401);
      assert.equal(err.code, "UNAUTHORIZED");
      assert.equal(err.isUnauthorized, true);
      return true;
    },
  );
  assert.equal(unauthorizedCalls, 1);
});

test("createScene POSTs name (and optional slug)", async () => {
  const bodies: unknown[] = [];
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(scene({ name: "N", slug: "n" })), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.createScene({ name: "N" });
  await client.createScene({ name: "N", slug: "n" });
  assert.deepEqual(bodies[0], { name: "N" });
  assert.deepEqual(bodies[1], { name: "N", slug: "n" });
});

test("renameScene PATCHes { name }", async () => {
  let method = "";
  let body: unknown;
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input, init) => {
      url = String(input);
      method = String(init?.method);
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(scene({ name: "Renamed" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await client.renameScene("arch", "Renamed");
  assert.equal(url, "/api/scenes/arch");
  assert.equal(method, "PATCH");
  assert.deepEqual(body, { name: "Renamed" });
  assert.equal(result.name, "Renamed");
});

test("deleteScene accepts 204 empty body", async () => {
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  await client.deleteScene("arch");
});

test("getDraft returns null on 404", async () => {
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: { code: "NOT_FOUND", message: "no draft" },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
  });
  assert.equal(await client.getDraft("arch"), null);
});

test("putDraft PUTs elements + basedOnVersion", async () => {
  let method = "";
  let body: unknown;
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input, init) => {
      url = String(input);
      method = String(init?.method);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          elements: [],
          appState: {},
          fileIds: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
          updatedBy: "me",
          basedOnVersion: 2,
          headVersion: 2,
          stale: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  await client.putDraft("arch", {
    elements: [{ id: "a" }],
    appState: { viewBackgroundColor: "#fff" },
    fileIds: ["abc"],
    basedOnVersion: 2,
  });
  assert.equal(url, "/api/scenes/arch/draft");
  assert.equal(method, "PUT");
  assert.deepEqual(body, {
    elements: [{ id: "a" }],
    appState: { viewBackgroundColor: "#fff" },
    fileIds: ["abc"],
    basedOnVersion: 2,
  });
});

test("commitScene POSTs parentVersion + message", async () => {
  let body: unknown;
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          version: 3,
          parentVersion: 2,
          author: "me",
          message: "done",
          createdAt: "2026-01-01T00:00:00.000Z",
          elementCount: 1,
          sceneHash: "h",
          headVersion: 3,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.commitScene("arch", {
    parentVersion: 2,
    elements: [],
    message: "done",
  });
  assert.equal(result.version, 3);
  assert.deepEqual(body, {
    parentVersion: 2,
    elements: [],
    message: "done",
  });
});

test("listVersions GETs paginated history", async () => {
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          versions: [
            {
              version: 2,
              parentVersion: 1,
              author: "alice",
              message: "two",
              createdAt: "2026-01-02T00:00:00.000Z",
              elementCount: 4,
              sceneHash: "h2",
            },
          ],
          total: 2,
          limit: 50,
          offset: 0,
          headVersion: 2,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const page = await client.listVersions("arch", { limit: 10, offset: 0 });
  assert.equal(url, "/api/scenes/arch/versions?limit=10&offset=0");
  assert.equal(page.headVersion, 2);
  assert.equal(page.versions[0]!.version, 2);
});

test("getDiff GETs structured SceneDiff", async () => {
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          from: 1,
          to: 2,
          summary: { added: 1, deleted: 0, updated: 0, reordered: 0 },
          elements: [
            {
              op: "add",
              id: "a",
              type: "rectangle",
              label: "Box",
              bbox: { x: 0, y: 0, width: 10, height: 10 },
              describe: '+ rectangle "Box"',
            },
          ],
          appState: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const diff = await client.getDiff("arch", 1, 2);
  assert.equal(url, "/api/scenes/arch/diff?from=1&to=2");
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.elements[0]!.op, "add");
});

test("getSceneDocument passes version query", async () => {
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          elements: [],
          appState: {},
          files: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  await client.getSceneDocument("arch", 3);
  assert.equal(url, "/api/scenes/arch/scene?v=3");
});

test("uploadFile POSTs BinaryFileData JSON", async () => {
  let body: unknown;
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          fileId: "abc",
          mimeType: "image/png",
          byteLength: 3,
          created: 1,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });

  await client.uploadFile({
    id: "abc",
    mimeType: "image/png",
    dataURL: "data:image/png;base64,aaa",
  });
  assert.deepEqual(body, {
    id: "abc",
    mimeType: "image/png",
    dataURL: "data:image/png;base64,aaa",
  });
});

test("getFileBytes returns binary payload", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async () =>
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  });
  const got = await client.getFileBytes("abc");
  assert.equal(got.mimeType, "image/png");
  assert.equal(got.bytes.byteLength, 3);
});

test("getSceneDocument GETs /scene", async () => {
  let url = "";
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          type: "excalidraw",
          version: 2,
          elements: [],
          appState: {},
          files: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  await client.getSceneDocument("arch");
  assert.equal(url, "/api/scenes/arch/scene");
});

test("getSceneEvents long-poll returns event body on 200", async () => {
  let url = "";
  let signalPassed = false;
  const ac = new AbortController();
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input, init) => {
      url = String(input);
      signalPassed = init?.signal === ac.signal;
      return new Response(
        JSON.stringify({
          version: 4,
          parentVersion: 3,
          author: "agent",
          message: "pushed",
          createdAt: "2026-01-01T00:00:00.000Z",
          elementCount: 2,
          sceneHash: "h4",
          headVersion: 4,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const event = await client.getSceneEvents("arch", 3, { signal: ac.signal });
  assert.equal(url, "/api/scenes/arch/events?since=3");
  assert.equal(signalPassed, true);
  assert.ok(event);
  assert.equal(event!.headVersion, 4);
  assert.equal(event!.author, "agent");
});

test("getSceneEvents returns null on 204 timeout", async () => {
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.equal(await client.getSceneEvents("arch", 2), null);
});

test("mergeScene POSTs to /scene?merge=true (issue #29 seam)", async () => {
  let url = "";
  let method = "";
  let body: unknown;
  const client = createApiClient({
    getToken: () => "t",
    onUnauthorized: () => {},
    fetchImpl: async (input, init) => {
      url = String(input);
      method = String(init?.method);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          version: 5,
          parentVersion: 3,
          author: "me",
          message: "merge with v4",
          createdAt: "2026-01-01T00:00:00.000Z",
          elementCount: 3,
          sceneHash: "hm",
          headVersion: 5,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await client.mergeScene("arch", {
    parentVersion: 3,
    elements: [{ id: "local" }],
    message: "merge with v4",
  });
  assert.equal(url, "/api/scenes/arch/scene?merge=true");
  assert.equal(method, "POST");
  assert.deepEqual(body, {
    parentVersion: 3,
    elements: [{ id: "local" }],
    message: "merge with v4",
  });
  assert.equal(result.headVersion, 5);
});
