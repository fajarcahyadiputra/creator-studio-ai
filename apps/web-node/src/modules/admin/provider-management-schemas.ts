import { z } from "zod";

const capabilityEnum = z.enum([
  "CHAT",
  "STRUCTURED_OUTPUT",
  "TTS",
  "STT",
  "VISION",
  "EMBEDDING",
  "IMAGE_GENERATION"
]);

function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .transform((value) => value || undefined);
}

function booleanField(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "on") return true;
    if (value === "off") return false;
    return value;
  }, z.boolean().default(defaultValue));
}

function optionalIntegerField(max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    return Number(value);
  }, z.number().int().positive().max(max).optional());
}

function optionalDecimalField(max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    return Number(value);
  }, z.number().nonnegative().max(max).optional());
}

function objectJsonField() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }, z.record(z.string(), z.unknown()));
}

function optionalObjectJsonField() {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }, z.record(z.string(), z.unknown()).optional());
}

function optionalUuidField() {
  return z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .refine((value) => value === undefined || z.uuid().safeParse(value).success, "Invalid UUID.");
}

function capabilitiesCsvField() {
  return z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, z.array(capabilityEnum).default([]));
}

function stringArrayCsvField() {
  return z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, z.array(z.string().min(1)).default([]));
}

const credentialStatusEnum = z.enum(["ACTIVE", "DEGRADED", "REVOKED", "EXPIRED"]);
const jobTypeEnum = z.enum(["AUTO_CLIPPING", "TEXT_TO_SPEECH", "TRANSCRIPTION", "MEDIA_INGESTION", "PUBLISHING"]);

export const adminCreateProviderSchema = z.object({
  code: z.string().trim().min(2).max(80),
  display_name: z.string().trim().min(2).max(120),
  adapter_type: z.string().trim().min(2).max(100),
  base_url: optionalText(500),
  enabled: booleanField(true),
  health_status: z.string().trim().min(2).max(40).default("UNKNOWN"),
  timeout_ms: optionalIntegerField(600000).default(60000),
  retry_policy_json: objectJsonField(),
  rate_limit_config_json: objectJsonField(),
  metadata_json: objectJsonField()
});

export const adminUpdateProviderSchema = adminCreateProviderSchema;

export const adminCreateModelSchema = z.object({
  provider_id: optionalUuidField(),
  identifier: z.string().trim().min(2).max(200),
  display_name: z.string().trim().min(2).max(160),
  enabled: booleanField(true),
  context_limit: optionalIntegerField(10000000),
  input_price_per_million: optionalDecimalField(1000000),
  output_price_per_million: optionalDecimalField(1000000),
  capabilities_csv: capabilitiesCsvField(),
  metadata_json: objectJsonField()
});

export const adminUpdateModelSchema = adminCreateModelSchema.extend({
  provider_id: optionalUuidField().optional()
});

export const adminCreateCredentialSchema = z.object({
  provider_id: z.uuid(),
  label: z.string().trim().min(2).max(120),
  status: credentialStatusEnum.default("ACTIVE"),
  payload_json: objectJsonField(),
  allowed_tools_csv: z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, z.array(jobTypeEnum).default([])),
  allowed_model_ids_csv: stringArrayCsvField(),
  usage_limit_config_json: objectJsonField(),
  last_connection_status: optionalText(40),
  expires_at: optionalText(80)
});

export const adminUpdateCredentialSchema = z.object({
  label: z.string().trim().min(2).max(120),
  status: credentialStatusEnum,
  rotate_payload_json: optionalObjectJsonField(),
  allowed_tools_csv: z.preprocess((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, z.array(jobTypeEnum).default([])),
  allowed_model_ids_csv: stringArrayCsvField(),
  usage_limit_config_json: objectJsonField(),
  last_connection_status: optionalText(40),
  expires_at: optionalText(80)
});
