import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { z } from "zod";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { requireServiceAuth } from "./service-auth.js";
import { validateSourceUrl } from "./security/source-url.js";

const app = express();
app.use(helmet());
app.use(express.json({ limit: "64kb" }));
app.use(pinoHttp({ logger }));

app.get("/health/live", (_request, response) => response.json({ status: "ok" }));
app.get("/health/ready", (_request, response) => response.json({ status: "ready" }));

app.post("/internal/v1/ingestion/validate-source", requireServiceAuth, async (request, response) => {
  const parsed = z.object({ url: z.url(), declared_rights: z.literal(true) }).safeParse(request.body);
  if (!parsed.success) {
    response.status(422).json({ error: { code: "VALIDATION_ERROR", message: parsed.error.message } });
    return;
  }
  try {
    const source = await validateSourceUrl(parsed.data.url);
    response.json({
      data: {
        normalized_url: source.normalizedUrl,
        hostname: source.hostname,
        resolved_address_count: source.resolvedAddresses.length,
        maximum_download_bytes: config.INGESTION_MAX_DOWNLOAD_BYTES,
        next_action: "Create a Phase 2 ingestion activity after platform capability and copyright checks."
      }
    });
  } catch (error) {
    response.status(422).json({
      error: { code: "SOURCE_URL_REJECTED", message: error instanceof Error ? error.message : String(error) }
    });
  }
});

const server = app.listen(config.INGESTION_PORT, "0.0.0.0", () => {
  logger.info({ port: config.INGESTION_PORT }, "Media ingestion boundary started");
});

function shutdown(): void {
  server.close((error) => {
    if (error) logger.error({ err: error }, "Ingestion shutdown failed");
    process.exit(error ? 1 : 0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
