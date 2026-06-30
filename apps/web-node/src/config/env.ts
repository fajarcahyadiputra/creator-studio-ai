import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalString = z.string().trim().transform((value) => value || undefined).optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAME: z.string().min(1).default("Creator Studio AI"),
  APP_HOST: z.string().min(1).default("0.0.0.0"),
  APP_PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.url(),
  TRUST_PROXY: bool,

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.url(),

  SESSION_SECRET: z.string().min(32),
  COOKIE_SECURE: bool,
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(604800),
  CSRF_SECRET: z.string().min(32),
  INTERNAL_SERVICE_TOKEN: z.string().min(32),
  CREDENTIAL_MASTER_KEY_BASE64: z.string().min(44),

  S3_ENDPOINT: z.url(),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET_MEDIA: z.string().min(3),
  S3_FORCE_PATH_STYLE: bool,
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  UPLOAD_MAX_SIZE_BYTES: z.coerce.number().int().positive().default(10 * 1024 ** 3),
  UPLOAD_PART_SIZE_BYTES: z.coerce.number().int().min(5 * 1024 ** 2).default(16 * 1024 ** 2),

  TEMPORAL_ADDRESS: z.string().min(1),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_AUTO_CLIP_TASK_QUEUE: z.string().min(1).default("auto-clipping"),
  WEB_INTERNAL_BASE_URL: z.url().default("http://web-node:3000"),
  MEDIA_INGESTION_INTERNAL_BASE_URL: z.url().default("http://media-ingestion-node:3100"),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().positive(),
  SMTP_SECURE: bool,
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: z.string().min(3),

  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_CALLBACK_URL: z.url().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info")
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const errors = parsed.error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message
  }));
  throw new Error(`Invalid environment configuration: ${JSON.stringify(errors)}`);
}

export const env = Object.freeze(parsed.data);
