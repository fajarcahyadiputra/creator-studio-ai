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

function jsonField() {
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

export const presetSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: optionalText(500),
  type: z.enum(["CLIPPING", "SUBTITLE", "TTS", "BRAND", "PUBLISHING"]),
  is_default: booleanField(false),
  analysis_brief: optionalText(20000),
  config_json: jsonField()
}).transform((value) => {
  const configJson = { ...value.config_json };
  if (value.type === "CLIPPING") {
    if (value.analysis_brief) configJson.analysis_brief = value.analysis_brief;
    else delete configJson.analysis_brief;
  }

  return {
    name: value.name,
    description: value.description,
    type: value.type,
    is_default: value.is_default,
    config_json: configJson
  };
});

export const brandKitSchema = z.object({
  name: z.string().trim().min(2).max(160),
  is_default: booleanField(false),
  font_config_json: jsonField(),
  color_config_json: jsonField(),
  safe_margin_config_json: jsonField(),
  subtitle_preset_json: jsonField()
});
