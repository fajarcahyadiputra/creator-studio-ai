import { z } from "zod";

const strongPassword = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, "Must contain a lowercase letter.")
  .regex(/[A-Z]/, "Must contain an uppercase letter.")
  .regex(/[0-9]/, "Must contain a number.");

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

function optionalText(maxLength: number) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .transform((value) => value || undefined);
}

function optionalUuid() {
  return z
    .string()
    .trim()
    .transform((value) => value || undefined)
    .refine((value) => value === undefined || z.uuid().safeParse(value).success, "Invalid UUID.");
}

function optionalJsonObjectField() {
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

export const profileSettingsSchema = z.object({
  display_name: z.string().trim().min(2).max(160),
  locale: z.string().trim().min(2).max(10),
  timezone: z.string().trim().min(2).max(64),
  default_content_niche: optionalText(120),
  default_audience: optionalText(255)
});

export const aiPreferenceSettingsSchema = z.object({
  credential_mode: z.enum(["PLATFORM", "USER_OWNED"]),
  provider_id: optionalUuid(),
  analysis_model_id: optionalUuid(),
  text_model_id: optionalUuid(),
  tts_model_id: optionalUuid(),
  base_url_override: optionalText(500),
  organization_id: optionalText(160),
  project_id: optionalText(160),
  label: optionalText(120),
  payload_json: optionalJsonObjectField(),
  rotate_payload_json: optionalJsonObjectField()
});

export const notificationSettingsSchema = z.object({
  email_job_completed: booleanField(false),
  email_job_failed: booleanField(true),
  email_quota_warning: booleanField(true),
  in_app_job_completed: booleanField(true),
  in_app_job_failed: booleanField(true),
  in_app_publish_completed: booleanField(false)
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: strongPassword
});

