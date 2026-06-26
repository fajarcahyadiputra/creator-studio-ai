import { createServer } from "node:http";
import { env } from "./config/env.js";
import { createApplication } from "./app.js";
import { logger } from "./shared/logging/logger.js";

const runtime = await createApplication();
const server = createServer(runtime.app);

server.listen(env.APP_PORT, env.APP_HOST, () => {
  logger.info({ host: env.APP_HOST, port: env.APP_PORT }, "Creator Studio AI web started");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");

  const forceTimer = setTimeout(() => {
    logger.fatal("Graceful shutdown timed out");
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  server.close(async (error) => {
    if (error) logger.error({ err: error }, "HTTP server close failed");
    try {
      await runtime.close();
      clearTimeout(forceTimer);
      process.exit(error ? 1 : 0);
    } catch (closeError) {
      logger.error({ err: closeError }, "Resource shutdown failed");
      process.exit(1);
    }
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  logger.fatal({ err: error }, "Unhandled rejection");
  void shutdown("unhandledRejection");
});
