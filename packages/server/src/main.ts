#!/usr/bin/env node
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";

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

  const app = await buildApp({ config });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
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
    { port: config.port, dataDir: config.dataDir },
    "server listening",
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
