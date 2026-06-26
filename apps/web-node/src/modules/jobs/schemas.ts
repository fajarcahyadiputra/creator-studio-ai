import { z } from "zod";

export const autoClipJobSchema = z.object({
  project_id: z.uuid().optional(),
  source: z.object({
    type: z.enum(["MEDIA_ASSET", "EXTERNAL_URL"]),
    media_asset_id: z.uuid().optional(),
    url: z.url().optional()
  }).refine(
    (value) =>
      (value.type === "MEDIA_ASSET" && Boolean(value.media_asset_id) && !value.url) ||
      (value.type === "EXTERNAL_URL" && Boolean(value.url) && !value.media_asset_id),
    "Source fields do not match source type."
  ),
  content: z.object({
    title: z.string().trim().max(255).optional(),
    context: z.string().trim().max(5000).optional(),
    topic: z.string().trim().max(255).optional(),
    source_language: z.string().trim().max(20).optional(),
    speaker_count: z.number().int().min(1).max(20).optional(),
    custom_vocabulary: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
    rights_confirmed: z.literal(true)
  }),
  strategy: z.object({
    target_platform: z.enum(["TIKTOK", "INSTAGRAM_REELS", "FACEBOOK_REELS", "YOUTUBE_SHORTS", "CUSTOM"]),
    objective: z.enum(["ENGAGEMENT", "EDUCATION", "CONTROVERSY", "STORYTELLING", "PRODUCT_AWARENESS", "LEAD_GENERATION"]),
    tones: z.array(z.string().min(1).max(50)).min(1).max(5),
    desired_clip_count: z.number().int().min(1).max(30),
    minimum_duration_seconds: z.number().int().min(10).max(180),
    maximum_duration_seconds: z.number().int().min(15).max(180),
    minimum_viral_score: z.number().min(0).max(10).default(7),
    remove_long_silence: z.boolean().default(true),
    remove_filler_words: z.boolean().default(false)
  }).refine((value) => value.maximum_duration_seconds >= value.minimum_duration_seconds, {
    message: "Maximum duration must be greater than or equal to minimum duration."
  }),
  visual: z.object({
    aspect_ratio: z.enum(["9:16", "1:1", "4:5", "16:9", "CUSTOM"]),
    crop_strategy: z.enum(["CENTER", "ACTIVE_SPEAKER", "FACE_TRACKING", "AUTO_REFRAME", "SPLIT_SCREEN", "SPEAKER_AND_SCREEN", "BLURRED_BACKGROUND", "MANUAL"]),
    settings: z.record(z.string(), z.unknown()).default({})
  }),
  subtitle: z.object({
    enabled: z.boolean(),
    language: z.string().max(20),
    burn_in: z.boolean(),
    export_formats: z.array(z.enum(["SRT", "VTT", "ASS", "JSON"])),
    settings: z.record(z.string(), z.unknown()).default({})
  }),
  ai: z.object({
    credential_mode: z.enum(["PLATFORM", "USER_OWNED"]),
    provider_id: z.uuid().optional(),
    analysis_model_id: z.uuid().optional()
  }).default({ credential_mode: "PLATFORM" })
});

export const retryJobSchema = z.object({
  stage: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().min(5).max(500)
});
