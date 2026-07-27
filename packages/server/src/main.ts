#!/usr/bin/env node
// Filter node:sqlite experimental warnings before the db module loads it.
import "./sqlite-warning.js";

import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import type { SkeletonConverterHolder } from "./skeleton.js";

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

  // Late-bound: filled after listen when RENDER_WORKER=on so Chromium can
  // hit this process's /render route (requires SERVE_STATIC).
  const skeletonHolder: SkeletonConverterHolder = { current: null };

  const app = await buildApp({
    config,
    db,
    readinessCheck: () => db.isHealthy(),
    skeletonConverter: skeletonHolder,
  });

  let renderWorker: { close(): Promise<void> } | null = null;

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      skeletonHolder.current = null;
      if (renderWorker) {
        try {
          await renderWorker.close();
        } catch (err) {
          app.log.warn({ err }, "error closing render worker");
        }
        renderWorker = null;
      }
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

  if (config.renderWorker === "on") {
    try {
      // Dynamic import keeps Playwright out of the process when off.
      const { createRenderWorker } = await import("@excalidraw-collab/render");
      const addr = app.server.address();
      const port =
        addr && typeof addr === "object" ? addr.port : config.port;
      // Chromium loads our own /render SPA route (SERVE_STATIC must be on
      // in production, or STATIC_ROOT must point at packages/web/dist).
      const baseUrl = `http://127.0.0.1:${port}`;
      const worker = await createRenderWorker({ baseUrl });
      renderWorker = worker;
      skeletonHolder.current = {
        convert: (request) => worker.convertSkeleton(request),
      };
      app.log.info(
        { baseUrl, renderWorker: "on" },
        "render worker ready for skeleton conversion",
      );
    } catch (err) {
      app.log.error(
        { err },
        "failed to start render worker; skeleton conversion will return 501",
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
