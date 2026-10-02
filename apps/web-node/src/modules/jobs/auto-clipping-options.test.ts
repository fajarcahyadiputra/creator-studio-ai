import { describe, expect, it } from "vitest";
import {
  AUTO_CLIP_OBJECTIVES,
  AUTO_CLIP_OBJECTIVE_OPTIONS,
  AUTO_CLIP_PRIMARY_TONES,
  AUTO_CLIP_SECONDARY_TONES
} from "./auto-clipping-options.js";
import { autoClipJobSchema, regenerateAutoClipJobSchema } from "./schemas.js";

describe("auto-clipping option registry", () => {
  it("contains the expanded objective catalog without duplicate values", () => {
    expect(new Set(AUTO_CLIP_OBJECTIVES).size).toBe(AUTO_CLIP_OBJECTIVES.length);
    expect(AUTO_CLIP_OBJECTIVES).toEqual(expect.arrayContaining([
      "VIRAL_POTENTIAL",
      "SPARK_DISCUSSION",
      "HIGHLIGHT_SHOCKING_MOMENT",
      "HIGHLIGHT_VALUABLE_INFORMATION",
      "BUILD_PERSONAL_BRANDING",
      "ENCOURAGE_CALL_TO_ACTION",
      "CREATE_FOMO",
      "CHALLENGE_AUDIENCE_OPINION"
    ]));
    expect(AUTO_CLIP_OBJECTIVE_OPTIONS).toHaveLength(AUTO_CLIP_OBJECTIVES.length);
  });

  it("contains the expanded primary and secondary tone catalogs", () => {
    expect(new Set(AUTO_CLIP_PRIMARY_TONES).size).toBe(AUTO_CLIP_PRIMARY_TONES.length);
    expect(new Set(AUTO_CLIP_SECONDARY_TONES).size).toBe(AUTO_CLIP_SECONDARY_TONES.length);
    expect(AUTO_CLIP_PRIMARY_TONES).toEqual(expect.arrayContaining([
      "PROVOCATIVE",
      "SHOCKING",
      "INSIGHTFUL",
      "SARCASTIC",
      "INVESTIGATIVE",
      "THOUGHT_PROVOKING",
      "HEARTWARMING",
      "AUTHENTIC"
    ]));
    expect(AUTO_CLIP_SECONDARY_TONES).toEqual(expect.arrayContaining([
      "SKEPTICAL",
      "PERSONAL",
      "AUTHENTIC",
      "ENERGETIC",
      "THOUGHT_PROVOKING",
      "MYSTERIOUS",
      "EXCITING"
    ]));
  });

  it("accepts a new objective in create and regenerate schemas", () => {
    const createResult = autoClipJobSchema.safeParse({
      source: { type: "EXTERNAL_URL", url: "https://www.youtube.com/watch?v=abcdefghijk" },
      content: { rights_confirmed: true },
      strategy: {
        target_platform: "TIKTOK",
        objective: "HIGHLIGHT_SURPRISING_FACT",
        objectives: ["HIGHLIGHT_SURPRISING_FACT", "SPARK_DISCUSSION"],
        primary_tones: ["SURPRISING", "INSIGHTFUL"],
        secondary_tones: ["THOUGHT_PROVOKING"],
        tones: ["SURPRISING", "THOUGHT_PROVOKING"],
        desired_clip_count: 3,
        candidate_pool_count: 10,
        minimum_duration_seconds: 20,
        maximum_duration_seconds: 60
      },
      visual: { aspect_ratio: "9:16", crop_strategy: "SMART_SPEAKER" },
      subtitle: {
        enabled: true,
        language: "id",
        burn_in: true,
        export_formats: ["ASS"],
        settings: {
          style: "PODCAST_HIGHLIGHT",
          max_lines: 2
        }
      }
    });
    const regenerateResult = regenerateAutoClipJobSchema.safeParse({
      configuration_mode: "MANUAL",
      target_platform: "TIKTOK",
      objective: "HIGHLIGHT_SURPRISING_FACT",
      objectives_text: "HIGHLIGHT_SURPRISING_FACT, SPARK_DISCUSSION",
      primary_tones_text: "SURPRISING, INSIGHTFUL",
      secondary_tones_text: "THOUGHT_PROVOKING",
      tones_text: "SURPRISING, THOUGHT_PROVOKING",
      desired_clip_count: "3",
      candidate_pool_count: "10",
      minimum_duration_seconds: "20",
      maximum_duration_seconds: "60",
      aspect_ratio: "9:16",
      crop_strategy: "SMART_SPEAKER",
      subtitle_enabled: "on",
      subtitle_language: "id"
    });

    expect(createResult.success).toBe(true);
    expect(regenerateResult.success).toBe(true);
    if (createResult.success) {
      expect(createResult.data.strategy.objectives).toEqual([
        "HIGHLIGHT_SURPRISING_FACT",
        "SPARK_DISCUSSION"
      ]);
    }
    if (regenerateResult.success) {
      expect(regenerateResult.data.objectives_text).toEqual([
        "HIGHLIGHT_SURPRISING_FACT",
        "SPARK_DISCUSSION"
      ]);
      expect(regenerateResult.data.tones_text).toEqual(["SURPRISING", "THOUGHT_PROVOKING"]);
    }
  });
});
