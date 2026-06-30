import { describe, expect, it, vi } from "vitest";

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));
import { buildRenderSettings } from "./job-service.js";

describe("buildRenderSettings", () => {
  it("captures stable render context from the job snapshot and selected candidate", () => {
    const settings = buildRenderSettings({
      inputSnapshot: {
        visual: {
          aspect_ratio: "9:16",
          crop_strategy: "AUTO_REFRAME",
          settings: { safe_zone: "center" }
        },
        subtitle: {
          enabled: true,
          language: "id",
          burn_in: true,
          export_formats: ["SRT", "VTT"],
          settings: { theme: "bold" }
        },
        strategy: {
          target_platform: "YOUTUBE_SHORTS",
          objective: "EDUCATION"
        }
      },
      candidate: {
        id: "row-candidate-1",
        candidateExternalId: "candidate-01",
        startMs: 12000n,
        endMs: 30500n,
        durationMs: 18500n,
        contentCategory: "insight",
        metadataSuggestions: {
          suggested_caption: "Caption text",
          suggested_cta: "Watch until the end.",
          suggested_hashtags: ["#creatorstudio", "#shortclips"],
          thumbnail_text: "Hook thumbnail",
          hook_second: 0,
          main_point_second: 5.2,
          punchline_second: 17.8,
          retention_level: "very_high",
          requires_context: false,
          can_standalone: true
        },
        analyzerMetadata: {
          analysis_version: "2.3",
          analysis_mode: "openai",
          prompt_version: "phase2-candidate-analyzer-v2",
          provider: "openai",
          model: "gpt-5.5"
        }
      }
    });

    expect(settings).toEqual({
      visual: {
        aspect_ratio: "9:16",
        crop_strategy: "AUTO_REFRAME",
        settings: { safe_zone: "center" }
      },
      subtitle: {
        enabled: true,
        language: "id",
        burn_in: true,
        export_formats: ["SRT", "VTT"],
        settings: { theme: "bold" }
      },
      strategy: {
        target_platform: "YOUTUBE_SHORTS",
        objective: "EDUCATION"
      },
      candidate: {
        candidate_id: "candidate-01",
        clip_candidate_id: "row-candidate-1",
        start_ms: "12000",
        end_ms: "30500",
        duration_ms: "18500",
        content_category: "insight"
      },
      metadata: {
        suggested_caption: "Caption text",
        suggested_cta: "Watch until the end.",
        suggested_hashtags: ["#creatorstudio", "#shortclips"],
        thumbnail_text: "Hook thumbnail",
        hook_second: 0,
        main_point_second: 5.2,
        punchline_second: 17.8,
        retention_level: "very_high",
        requires_context: false,
        can_standalone: true
      },
      analyzer: {
        analysis_version: "2.3",
        analysis_mode: "openai",
        prompt_version: "phase2-candidate-analyzer-v2",
        provider: "openai",
        model: "gpt-5.5"
      }
    });
  });
});
