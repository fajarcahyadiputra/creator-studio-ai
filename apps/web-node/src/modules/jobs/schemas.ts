import { z } from "zod";

const transcriptWordSchema = z.object({
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0),
  text: z.string().trim().min(1).max(120),
  confidence: z.number().min(0).max(1).optional()
}).refine((value) => value.end_seconds > value.start_seconds, "Word end must be greater than start.");

const transcriptSegmentSchema = z.object({
  segment_id: z.string().trim().min(1).max(100),
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0),
  text: z.string().trim().min(1).max(5000),
  speaker_label: z.string().trim().max(80).optional(),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(transcriptWordSchema).max(5000).default([])
}).refine((value) => value.end_seconds > value.start_seconds, "Segment end must be greater than start.");

const sceneSchema = z.object({
  scene_id: z.string().trim().min(1).max(100),
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0)
}).refine((value) => value.end_seconds > value.start_seconds, "Scene end must be greater than start.");

const silenceSchema = z.object({
  silence_id: z.string().trim().min(1).max(100),
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0)
}).refine((value) => value.end_seconds > value.start_seconds, "Silence end must be greater than start.");

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
    context: z.string().trim().max(20000).optional(),
    topic: z.string().trim().max(255).optional(),
    niche: z.string().trim().max(120).optional(),
    target_audience: z.string().trim().max(255).optional(),
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
    candidate_pool_count: z.number().int().min(1).max(30).default(10),
    minimum_duration_seconds: z.number().int().min(10).max(180),
    maximum_duration_seconds: z.number().int().min(15).max(180),
    minimum_viral_score: z.number().min(0).max(10).default(7),
    preferred_topics: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    topics_to_avoid: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    sensitive_topics: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    clip_style_tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    virality_priorities: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
    selection_brief: z.string().trim().max(12000).optional(),
    avoidance_brief: z.string().trim().max(12000).optional(),
    packaging_brief: z.string().trim().max(12000).optional(),
    hook_style: z.string().trim().max(80).optional(),
    cta_preference: z.string().trim().max(120).optional(),
    standalone_priority: z.enum(["REQUIRED", "PREFERRED", "FLEXIBLE"]).default("PREFERRED"),
    require_spoken_audio: z.boolean().default(true),
    profanity_handling: z.enum(["KEEP", "MUTE", "BLEEP", "SUBTITLE_CENSOR"]).default("KEEP"),
    remove_long_silence: z.boolean().default(true),
    remove_filler_words: z.boolean().default(false)
  }).refine((value) => value.maximum_duration_seconds >= value.minimum_duration_seconds, {
    message: "Maximum duration must be greater than or equal to minimum duration."
  }).refine((value) => value.candidate_pool_count >= value.desired_clip_count, {
    message: "Candidate pool count must be greater than or equal to desired clip count."
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
    format: z.enum(["SRT", "VTT", "ASS", "JSON"]).optional(),
    export_formats: z.array(z.enum(["SRT", "VTT", "ASS", "JSON"])),
    settings: z.object({
      style: z.string().trim().max(80).optional(),
      font_family: z.string().trim().max(120).optional(),
      position: z.enum(["TOP", "CENTER", "BOTTOM"]).optional(),
      max_lines: z.number().int().min(1).max(4).optional(),
      safe_margin_percent: z.number().min(0).max(30).optional(),
      word_highlight: z.boolean().optional(),
      profanity_censor: z.boolean().optional()
    }).catchall(z.unknown()).default({})
  }),
  ai: z.object({
    credential_mode: z.enum(["PLATFORM", "USER_OWNED"]),
    provider_id: z.uuid().optional(),
    analysis_model_id: z.uuid().optional()
  }).default({ credential_mode: "PLATFORM" }),
  analysis_inputs: z.object({
    transcript: z.object({
      language: z.string().trim().min(2).max(20),
      duration_seconds: z.number().gt(0),
      segments: z.array(transcriptSegmentSchema).min(1).max(5000)
    }),
    scenes: z.array(sceneSchema).max(5000).default([]),
    silences: z.array(silenceSchema).max(5000).default([])
  }).optional()
});

export const ttsJobSchema = z.object({
  project_id: z.uuid().optional(),
  script: z.string().trim().min(1).max(100000),
  language: z.string().trim().min(2).max(20).default("id"),
  local_model_key: z.string().trim().min(1).max(200).optional(),
  voice_identifier: z.string().trim().max(200).optional(),
  speaking_style: z.string().trim().max(80).optional(),
  emotion: z.string().trim().max(80).optional(),
  speaking_speed: z.number().min(0.5).max(3).optional(),
  pitch: z.number().min(-20).max(20).optional(),
  pause_intensity: z.number().min(0).max(3).optional(),
  target_duration_ms: z.number().int().positive().max(14_400_000).optional(),
  pronunciation_dictionary: z.record(z.string(), z.string()).default({}),
  output_config: z.object({
    preferred_format: z.enum(["WAV", "MP3", "OGG"]).default("WAV"),
    segmentation_mode: z.enum(["OPENAI", "LOCAL_HEURISTIC"]).default("LOCAL_HEURISTIC"),
    sample_rate: z.number().int().min(8000).max(96000).optional(),
    channels: z.number().int().min(1).max(2).optional()
  }).catchall(z.unknown()).default({ preferred_format: "WAV", segmentation_mode: "LOCAL_HEURISTIC" }),
  user_preferences: z.object({
    tone_notes: z.string().trim().max(4000).optional(),
    delivery_goal: z.string().trim().max(4000).optional(),
    segment_length_preference: z.enum(["SHORT", "BALANCED", "LONG"]).optional(),
    breathing_style: z.enum(["MINIMAL", "NATURAL", "DRAMATIC"]).optional()
  }).catchall(z.unknown()).default({}),
  ai: z.object({
    credential_mode: z.enum(["PLATFORM", "USER_OWNED"]),
    provider_id: z.uuid().optional(),
    model_id: z.uuid().optional()
  }).default({ credential_mode: "PLATFORM" })
});

export const retryJobSchema = z.object({
  stage: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().min(5).max(500)
});

export const clipCandidateSelectionSchema = z.object({
  selected: z.boolean()
});
