import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { ErrorCode, type ErrorEnvelope } from "./errors.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({}),
    serveStatic: false,
    logLevel: "silent",
    ...overrides,
  };
}

describe("buildApp", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({
      config: testConfig(),
      fastifyOpts: { logger: false },
    });

    // Minimal schema-validated route so we can exercise the validation envelope
    // without introducing production endpoints this issue doesn't own.
    app.post(
      "/__test/echo",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      async (request) => {
        const body = request.body as { name: string };
        return { name: body.name };
      },
    );

    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test("GET /healthz returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });

  test("GET /readyz returns 200 when readiness check passes", async () => {
    const res = await app.inject({ method: "GET", url: "/readyz" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ready" });
  });

  test("GET /readyz returns 503 envelope when readiness check fails", async () => {
    const notReady = await buildApp({
      config: testConfig(),
      readinessCheck: () => false,
      fastifyOpts: { logger: false },
    });
    try {
      const res = await notReady.inject({ method: "GET", url: "/readyz" });
      assert.equal(res.statusCode, 503);
      const body = res.json() as ErrorEnvelope;
      assert.equal(body.error.code, ErrorCode.NOT_READY);
      assert.equal(typeof body.error.message, "string");
    } finally {
      await notReady.close();
    }
  });

  test("unknown route returns error envelope on 404", async () => {
    const res = await app.inject({ method: "GET", url: "/no-such-route" });
    assert.equal(res.statusCode, 404);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.NOT_FOUND);
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
    assert.equal("details" in body.error ? body.error.details : undefined, undefined);
  });

  test("schema validation failure returns error envelope on 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/__test/echo",
      headers: { "content-type": "application/json" },
      payload: { notName: 1 },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json() as ErrorEnvelope;
    assert.equal(body.error.code, ErrorCode.VALIDATION);
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.details !== undefined);
  });
});
