import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configPath, loadConfig, readConfigFile, writeConfigFile } from "./config.js";

function tempEnv(): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excali-config-"));
  return {
    dir,
    env: { ...process.env, XDG_CONFIG_HOME: dir },
  };
}

test("writeConfigFile creates dir and writes mode 0600", () => {
  const { env, dir } = tempEnv();
  const file = writeConfigFile({ server: "http://127.0.0.1:9999", token: "sekrit" }, env);

  assert.equal(file, configPath(env));
  assert.ok(file.startsWith(dir));
  assert.ok(fs.existsSync(file));

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);

  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    server: string;
    token: string;
  };
  assert.equal(raw.server, "http://127.0.0.1:9999");
  assert.equal(raw.token, "sekrit");
});

test("read/write round-trip", () => {
  const { env } = tempEnv();
  writeConfigFile({ server: "http://example.test", token: "t1" }, env);
  const got = readConfigFile(env);
  assert.deepEqual(got, { server: "http://example.test", token: "t1" });
});

test("missing config file yields empty object", () => {
  const { env } = tempEnv();
  assert.deepEqual(readConfigFile(env), {});
});

test("env vars override file values", () => {
  const { env } = tempEnv();
  writeConfigFile({ server: "http://from-file", token: "from-file" }, env);

  const resolved = loadConfig({
    ...env,
    EXCALI_SERVER: "http://from-env",
    EXCALI_TOKEN: "from-env",
  });

  assert.equal(resolved.server, "http://from-env");
  assert.equal(resolved.token, "from-env");
});

test("partial env override keeps other file field", () => {
  const { env } = tempEnv();
  writeConfigFile({ server: "http://from-file", token: "from-file" }, env);

  const resolved = loadConfig({
    ...env,
    EXCALI_SERVER: "http://from-env",
    EXCALI_TOKEN: undefined,
  });

  assert.equal(resolved.server, "http://from-env");
  assert.equal(resolved.token, "from-file");
});

test("chmod 0600 applied when overwriting existing file", () => {
  const { env } = tempEnv();
  const file = writeConfigFile({ server: "http://a" }, env);
  fs.chmodSync(file, 0o644);
  writeConfigFile({ server: "http://b", token: "x" }, env);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
});
