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
