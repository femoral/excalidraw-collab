import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

describe("loadConfig", () => {
  test("applies sane defaults when env is empty", () => {
    const cfg = loadConfig({});
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.dataDir, "./data");
    assert.equal(cfg.bootstrapToken, "");
    assert.equal(cfg.renderWorker, "off");
    assert.equal(cfg.logLevel, "info");
    assert.equal(cfg.serveStatic, false);
    assert.equal(cfg.staticRoot, "./public");
  });

  test("reads valid overrides", () => {
    const cfg = loadConfig({
      PORT: "8080",
      DATA_DIR: "./var/data",
      BOOTSTRAP_TOKEN: "secret-token",
      RENDER_WORKER: "on",
      LOG_LEVEL: "debug",
      SERVE_STATIC: "true",
      STATIC_ROOT: "./dist/web",
    });
    assert.equal(cfg.port, 8080);
    assert.equal(cfg.dataDir, "./var/data");
    assert.equal(cfg.bootstrapToken, "secret-token");
    assert.equal(cfg.renderWorker, "on");
    assert.equal(cfg.logLevel, "debug");
    assert.equal(cfg.serveStatic, true);
    assert.equal(cfg.staticRoot, "./dist/web");
  });

  test("rejects a bad PORT and names the variable", () => {
    assert.throws(
      () => loadConfig({ PORT: "not-a-number" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.variable, "PORT");
        assert.match(err.message, /PORT/);
        return true;
      },
    );
  });

  test("rejects PORT out of range", () => {
    assert.throws(
      () => loadConfig({ PORT: "70000" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.variable, "PORT");
        return true;
      },
    );
  });

  test("rejects a bad LOG_LEVEL and names the variable", () => {
    assert.throws(
      () => loadConfig({ LOG_LEVEL: "verbose" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.variable, "LOG_LEVEL");
        assert.match(err.message, /LOG_LEVEL/);
        return true;
      },
    );
  });

  test("rejects a bad RENDER_WORKER and names the variable", () => {
    assert.throws(
      () => loadConfig({ RENDER_WORKER: "maybe" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.variable, "RENDER_WORKER");
        return true;
      },
    );
  });

  test("rejects a bad SERVE_STATIC and names the variable", () => {
    assert.throws(
      () => loadConfig({ SERVE_STATIC: "sometimes" }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.equal(err.variable, "SERVE_STATIC");
        return true;
      },
    );
  });
});
