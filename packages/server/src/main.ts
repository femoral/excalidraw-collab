#!/usr/bin/env node
// Filter node:sqlite experimental warnings before the db module loads it.
import "./sqlite-warning.js";

import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type Database } from "./db.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Invalid configuration: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let db: Database;
  try {
    db = openDatabase(config.dataDir);
  } catch (err) {
    console.error("Failed to open database:", err);
    process.exit(1);
  }

  const app = await buildApp({
    config,
    readinessCheck: () => db.isHealthy(),
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      try {
        db.close();
      } catch {
        // ignore
      }
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(
    { port: config.port, dataDir: config.dataDir, dbPath: db.dbPath },
    "server listening",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
