import "dotenv/config";
import { z } from "zod";

const parsed = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  INGESTION_PORT: z.coerce.number().int().positive().default(3100),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  INGESTION_ALLOWED_HOSTS: z.string().min(1),
  INGESTION_MAX_DOWNLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
}).safeParse(process.env);

if (!parsed.success) throw new Error(`Invalid ingestion environment: ${parsed.error.message}`);

export const config = {
  ...parsed.data,
  allowedHosts: new Set(parsed.data.INGESTION_ALLOWED_HOSTS.split(",").map((host) => host.trim().toLowerCase()))
};
