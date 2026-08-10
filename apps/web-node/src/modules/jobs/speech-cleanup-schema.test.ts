import { describe, expect, it } from "vitest";
import { autoClipJobSchema, regenerateAutoClipJobSchema } from "./schemas.js";

function createAutoClipPayload() {
  return {
    source: {
      type: "EXTERNAL_URL",
      url: "https://www.youtube.com/watch?v=abc123"
    },
    content: {
      custom_vocabulary: [],
      rights_confirmed: true
    },
    strategy: {
      target_platform: "TIKTOK",
      objective: "ENGAGEMENT",
      tones: ["EDUCATIONAL"],
      desired_clip_count: 3,
      minimum_duration_seconds: 20,
      maximum_duration_seconds: 45
    },
    visual: {
      aspect_ratio: "9:16",
      crop_strategy: "SMART_SPEAKER",
      settings: {}
    },
    subtitle: {
      enabled: true,
      language: "id",
      burn_in: true,
      export_formats: ["ASS"],
      settings: {}
    }
  };
}

function createRegeneratePayload() {
  return {
    content_title: "",
    content_context: "",
    topic: "",
    source_language: "",
    target_platform: "TIKTOK",
    objective: "ENGAGEMENT",
    tones_text: "EDUCATIONAL",
    desired_clip_count: "3",
    candidate_pool_count: "10",
    minimum_duration_seconds: "20",
    maximum_duration_seconds: "45",
    selection_brief: "",
    avoidance_brief: "",
    packaging_brief: "",
    hook_style: "",
    cta_preference: "",
    aspect_ratio: "9:16",
    crop_strategy: "SMART_SPEAKER",
    subtitle_enabled: "on",
    subtitle_language: "id",
    subtitle_style: "",
    subtitle_font_family: ""
  };
}

describe("speech cleanup request schemas", () => {
  it("accepts a multi-line topic longer than the legacy varchar limit", () => {
    const payload = createAutoClipPayload();
    payload.content = {
      ...payload.content,
      topic: "Topik utama dengan konteks yang lengkap. ".repeat(12)
    };

    const parsed = autoClipJobSchema.parse(payload);

    expect(parsed.content.topic?.length).toBeGreaterThan(255);
  });

  it("keeps speech cleanup disabled for existing create payloads", () => {
    const parsed = autoClipJobSchema.parse(createAutoClipPayload());

    expect(parsed.strategy.speech_cleanup_enabled).toBe(false);
    expect(parsed.strategy.remove_long_silence).toBe(false);
    expect(parsed.strategy.remove_filler_words).toBe(false);
  });

  it("accepts speech cleanup for new create payloads", () => {
    const payload = createAutoClipPayload();
    payload.strategy = {
      ...payload.strategy,
      speech_cleanup_enabled: true
    };

    const parsed = autoClipJobSchema.parse(payload);

    expect(parsed.strategy.speech_cleanup_enabled).toBe(true);
  });

  it("normalizes the regenerate HTML checkbox and defaults it to disabled", () => {
    const enabled = regenerateAutoClipJobSchema.parse({
      ...createRegeneratePayload(),
      speech_cleanup_enabled: "on"
    });
    const disabled = regenerateAutoClipJobSchema.parse(createRegeneratePayload());

    expect(enabled.speech_cleanup_enabled).toBe(true);
    expect(disabled.speech_cleanup_enabled).toBe(false);
  });
});
