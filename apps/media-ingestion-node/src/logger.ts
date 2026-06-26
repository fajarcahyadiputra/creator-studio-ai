import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  name: "media-ingestion-node",
  level: config.LOG_LEVEL,
  base: { service: "media-ingestion-node", environment: config.NODE_ENV },
  redact: { paths: ["req.headers.authorization", "req.headers.cookie", "*.signedUrl"], censor: "[REDACTED]" },
  timestamp: pino.stdTimeFunctions.isoTime
});
