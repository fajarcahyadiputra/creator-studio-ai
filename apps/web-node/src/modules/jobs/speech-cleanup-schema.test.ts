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
    configuration_mode: "MANUAL",
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

  it("accepts the current compact regenerate form without legacy brief fields", () => {
    const payload = createRegeneratePayload();
    delete payload.selection_brief;
    delete payload.avoidance_brief;
    delete payload.packaging_brief;

    const parsed = regenerateAutoClipJobSchema.parse(payload);

    expect(parsed.selection_brief).toBeUndefined();
    expect(parsed.avoidance_brief).toBeUndefined();
    expect(parsed.packaging_brief).toBeUndefined();
  });

  it("normalizes omitted, null, and empty legacy briefs for compact clients", () => {
    const parsed = regenerateAutoClipJobSchema.parse({
      ...createRegeneratePayload(),
      selection_brief: undefined,
      avoidance_brief: null,
      packaging_brief: ""
    });

    expect(parsed.selection_brief).toBeUndefined();
    expect(parsed.avoidance_brief).toBeUndefined();
    expect(parsed.packaging_brief).toBeUndefined();
  });

  it("accepts the latest regenerate content fields", () => {
    const parsed = regenerateAutoClipJobSchema.parse({
      ...createRegeneratePayload(),
      niche: "Creator education",
      target_audience: "Beginner creators and social media teams"
    });

    expect(parsed.niche).toBe("Creator education");
    expect(parsed.target_audience).toBe("Beginner creators and social media teams");
  });

  it("accepts auto regenerate without manual candidate controls", () => {
    const payload = createRegeneratePayload();
    payload.configuration_mode = "AUTO";
    delete payload.desired_clip_count;
    delete payload.candidate_pool_count;
    delete payload.minimum_duration_seconds;
    delete payload.selection_brief;
    delete payload.avoidance_brief;
    delete payload.packaging_brief;

    const parsed = regenerateAutoClipJobSchema.parse(payload);

    expect(parsed.configuration_mode).toBe("AUTO");
    expect(parsed.desired_clip_count).toBeUndefined();
    expect(parsed.minimum_duration_seconds).toBeUndefined();
    expect(parsed.maximum_duration_seconds).toBe(45);
  });

  it("rejects more than ten final clips for create and regenerate", () => {
    const createPayload = createAutoClipPayload();
    createPayload.strategy.desired_clip_count = 11;
    const regeneratePayload = {
      ...createRegeneratePayload(),
      desired_clip_count: "11",
      candidate_pool_count: "30"
    };

    expect(autoClipJobSchema.safeParse(createPayload).success).toBe(false);
    expect(regenerateAutoClipJobSchema.safeParse(regeneratePayload).success).toBe(false);
  });
});
