import { z } from "zod";

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

export const adminCreateFeatureFlagSchema = z.object({
  key: z.string().trim().min(2).max(120),
  description: optionalText(500),
  enabled: booleanField(false),
  rules_json: objectJsonField()
});

export const adminUpdateFeatureFlagSchema = adminCreateFeatureFlagSchema;

export const adminCreateSystemSettingSchema = z.object({
  key: z.string().trim().min(2).max(160),
  description: optionalText(500),
  is_secret: booleanField(false),
  value_json: objectJsonField()
});

export const adminUpdateSystemSettingSchema = adminCreateSystemSettingSchema;

