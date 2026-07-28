#!/usr/bin/env node
// Filter node:sqlite experimental warnings before the db module loads it.
import "./sqlite-warning.js";

import { openRenderWorker, type RenderWorker } from "@excalidraw-collab/render";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase, type Database } from "./db.js";
import type { SceneMergeService } from "./merge.js";
import type { SceneRenderWorker } from "./render.js";
import type { SkeletonConverterHolder } from "./skeleton.js";

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

  // Late-bound skeleton converter: filled after listen when RENDER_WORKER=on
  // so Chromium can hit this process's /render route (requires SERVE_STATIC).
  const skeletonHolder: SkeletonConverterHolder = { current: null };

  // Optional render worker for merge + skeleton + export. Browser launch is
  // lazy (first real request), so opening before listen is safe as long as
  // the first call happens after the HTTP port is bound.
  let renderWorker: RenderWorker | null = null;
  let merge: SceneMergeService | null = null;
  if (config.renderWorker === "on") {
    const baseUrl = `http://127.0.0.1:${config.port}`;
    try {
      renderWorker = await openRenderWorker({ baseUrl }, { RENDER_WORKER: "on" });
      if (renderWorker) {
        merge = mergeServiceFromWorker(renderWorker);
      }
    } catch (err) {
      console.error("failed to open render worker; merge/skeleton/render will return 501:", err);
      renderWorker = null;
      merge = null;
    }
  }

  const app = await buildApp({
    config,
    db,
    readinessCheck: () => db.isHealthy(),
    skeletonConverter: skeletonHolder,
    // Share one worker across render routes, merge, and skeleton — do not
    // let createRenderService open a second Chromium.
    renderWorker: (renderWorker as SceneRenderWorker | null) ?? null,
    renderBaseUrl: `http://127.0.0.1:${config.port}`,
    merge,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      skeletonHolder.current = null;
      await app.close();
      if (renderWorker) {
        try {
          await renderWorker.close();
        } catch (err) {
          app.log.warn({ err }, "error closing render worker");
        }
        renderWorker = null;
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

  // Bind skeleton conversion once the /render route is reachable.
  if (renderWorker) {
    skeletonHolder.current = {
      convert: (request) => renderWorker!.convertSkeleton(request),
    };
    app.log.info(
      {
        baseUrl: `http://127.0.0.1:${config.port}`,
        renderWorker: "on",
      },
      "render worker ready for export, skeleton conversion, and merge",
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
