#!/usr/bin/env node
// Filter node:sqlite experimental warnings before the db module loads it.
import "./sqlite-warning.js";

import { openRenderWorker, type RenderWorker } from "@excalidraw-collab/render";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import type { SceneMergeService } from "./merge.js";

function mergeServiceFromWorker(worker: RenderWorker): SceneMergeService {
  return {
    async merge(input) {
      const result = await worker.merge({
        local: { elements: input.localElements },
        remote: { elements: input.remoteElements },
        appState: input.appState ?? {},
      });
      return { elements: result.elements };
    },
  };
}

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

  // Optional render worker for server-side merge (and later export/skeleton).
  // baseUrl points at this process once listen() binds — merge() is lazy so
  // the first real request happens after the server is up.
  let renderWorker: RenderWorker | null = null;
  let merge: SceneMergeService | null = null;
  if (config.renderWorker === "on") {
    const baseUrl = `http://127.0.0.1:${config.port}`;
    renderWorker = await openRenderWorker({ baseUrl });
    if (renderWorker) {
      merge = mergeServiceFromWorker(renderWorker);
    }
  }

  const app = await buildApp({
    config,
    db,
    readinessCheck: () => db.isHealthy(),
    merge,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      if (renderWorker) {
        try {
          await renderWorker.close();
        } catch {
          // ignore worker teardown errors on shutdown
        }
      }
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
    {
      port: config.port,
      dataDir: config.dataDir,
      dbPath: db.dbPath,
      renderWorker: config.renderWorker,
      mergeEnabled: merge !== null,
    },
    "server listening",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
