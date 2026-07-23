import { describe, expect, it, vi } from "vitest";

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));
import {
  computeServerOverallProgress,
  resolveCandidateTranscriptId,
  resolveRecordedJobProgress,
  resolveRecordedJobStage,
  resolvePersistableCandidates,
  resolveOutputSummary,
  resolveStageWeight,
  resolveTotalStageWeight
} from "./job-projection-service.js";

describe("job projection helpers", () => {
  it("uses stage weight from metadata when valid", () => {
    expect(resolveStageWeight({ stage_weight: 16 })).toBe(16);
    expect(resolveStageWeight({ stage_weight: -1 })).toBe(1);
    expect(resolveStageWeight(undefined)).toBe(1);
  });

  it("uses total stage weight from metadata when valid", () => {
    expect(resolveTotalStageWeight({ total_stage_weight: 100 })).toBe(100);
    expect(resolveTotalStageWeight({ total_stage_weight: 0 })).toBeUndefined();
    expect(resolveTotalStageWeight(undefined)).toBeUndefined();
  });

  it("extracts output summary objects only", () => {
    expect(resolveOutputSummary({ output_summary: { candidate_count: 2 } })).toEqual({ candidate_count: 2 });
    expect(resolveOutputSummary({ output_summary: "bad-shape" })).toBeUndefined();
    expect(resolveOutputSummary(undefined)).toBeUndefined();
  });

  it("maps valid output candidates into persistable clip candidate records", () => {
    const candidates = resolvePersistableCandidates({
      output_summary: {
        analysis_version: "2.3",
        candidate_count: 1,
        analyzer: {
          analysis_mode: "heuristic",
          prompt_version: "phase2-candidate-analyzer-v2",
          request_id: "req-123"
        },
        candidates: [
          {
            candidate_id: "candidate-01",
            start_seconds: 12.5,
            end_seconds: 30.25,
            duration_seconds: 17.75,
            title: "Kenapa intro ini bikin retention naik",
            hook_text: "Kenapa orang langsung berhenti scroll di sini?",
            ending_text: "Karena payoff-nya cepat terasa.",
            summary: "Potongan insight tentang hook dan retention.",
            why_it_works: ["Opens with a clear hook."],
            content_category: "insight",
            context_complete: true,
            safety_notes: [],
            suggested_caption: "Hook yang tajam bikin video lebih kuat.",
            suggested_cta: "Watch until the end and share your take.",
            suggested_hashtags: ["#creatorstudio", "#shortclips"],
            thumbnail_text: "Hook yang bikin retention naik",
            speaker_ids: ["speaker-1"],
            scene_ids: ["scene-2"],
            hook_second: 0.0,
            main_point_second: 4.8,
            punchline_second: 17.4,
            retention_level: "very_high",
            requires_context: false,
            can_standalone: true,
            scores: {
              hook: 8.8,
              base_viral_score: 8.42,
              final_viral_score: 8.15
            }
          }
        ]
      }
    });

    expect(candidates).toEqual([
      {
        candidateExternalId: "candidate-01",
        startMs: 12500n,
        endMs: 30250n,
        durationMs: 17750n,
        title: "Kenapa intro ini bikin retention naik",
        hookText: "Kenapa orang langsung berhenti scroll di sini?",
        endingText: "Karena payoff-nya cepat terasa.",
        summary: "Potongan insight tentang hook dan retention.",
        whyItWorks: ["Opens with a clear hook."],
        contentCategory: "insight",
        scoreBreakdown: {
          hook: 8.8,
          base_viral_score: 8.42,
          final_viral_score: 8.15
        },
        baseViralScore: "8.42",
        finalViralScore: "8.15",
        contextComplete: true,
        safetyNotes: [],
        metadataSuggestions: {
          suggested_caption: "Hook yang tajam bikin video lebih kuat.",
          suggested_cta: "Watch until the end and share your take.",
          related_hashtags: [],
          viral_hashtags: [],
          suggested_hashtags: ["#creatorstudio", "#shortclips"],
          thumbnail_text: "Hook yang bikin retention naik",
          hook_second: 0,
          main_point_second: 4.8,
          punchline_second: 17.4,
          retention_level: "very_high",
          requires_context: false,
          can_standalone: true
        },
        speakerIds: ["speaker-1"],
        sceneIds: ["scene-2"],
        analyzerMetadata: {
          analysis_version: "2.3",
          analysis_mode: "heuristic",
          prompt_version: "phase2-candidate-analyzer-v2",
          request_id: "req-123"
        },
        selected: true,
        rank: 1
      }
    ]);
  });

  it("ignores malformed output candidate payloads", () => {
    expect(
      resolvePersistableCandidates({
        output_summary: {
          analysis_version: "2.3",
          candidate_count: 1,
          candidates: [{ candidate_id: "candidate-01" }]
        }
      })
    ).toBeUndefined();
  });

  it("links persisted candidates to the source media transcript when available", () => {
    expect(
      resolveCandidateTranscriptId(
        { sourceMediaAssetId: "asset-1" },
        { id: "transcript-1", mediaAssetId: "asset-1" }
      )
    ).toBe("transcript-1");
    expect(
      resolveCandidateTranscriptId(
        { sourceMediaAssetId: "asset-1" },
        { id: "transcript-2", mediaAssetId: "asset-2" }
      )
    ).toBeNull();
    expect(resolveCandidateTranscriptId({ sourceMediaAssetId: null }, { id: "transcript-1", mediaAssetId: "asset-1" })).toBeNull();
  });

  it("recomputes server-side weighted progress when total stage weight is present", () => {
    const progress = computeServerOverallProgress({
      existingStages: [
        { name: "VALIDATING_SOURCE", progressPercent: 100, progressWeight: "8" },
        { name: "PROBING_MEDIA", progressPercent: 100, progressWeight: "8" },
        { name: "EXTRACTING_AUDIO", progressPercent: 100, progressWeight: "8" }
      ],
      input: {
        stage: "TRANSCRIBING",
        stage_progress: 50,
        overall_progress: 1,
        metadata: { stage_weight: 16, total_stage_weight: 100 }
      }
    });

    expect(progress).toBe(32);
  });

  it("falls back to worker overall progress when total stage weight is missing", () => {
    const progress = computeServerOverallProgress({
      existingStages: [],
      input: {
        stage: "TRANSCRIBING",
        stage_progress: 50,
        overall_progress: 44,
        metadata: { stage_weight: 16 }
      }
    });

    expect(progress).toBe(44);
  });

  it("forces final jobs to 100 percent when completed", () => {
    expect(
      resolveRecordedJobProgress({
        currentProgressPercent: 92,
        computedProgressPercent: 92,
        nextStatus: "COMPLETED"
      })
    ).toBe(100);
    expect(
      resolveRecordedJobProgress({
        currentProgressPercent: 92,
        computedProgressPercent: 92,
        nextStatus: "PARTIALLY_COMPLETED"
      })
    ).toBe(100);
  });

  it("caps failed-like terminal jobs below 100 percent", () => {
    expect(
      resolveRecordedJobProgress({
        currentProgressPercent: 40,
        computedProgressPercent: 92,
        nextStatus: "FAILED"
      })
    ).toBe(92);
    expect(
      resolveRecordedJobProgress({
        currentProgressPercent: 99,
        computedProgressPercent: 100,
        nextStatus: "NEEDS_REVIEW"
      })
    ).toBe(99);
  });

  it("stores terminal status as the display stage", () => {
    expect(resolveRecordedJobStage("UPLOADING_OUTPUTS", "COMPLETED")).toBe("COMPLETED");
    expect(resolveRecordedJobStage("TRANSCRIBING", "FAILED")).toBe("FAILED");
    expect(resolveRecordedJobStage("UPLOADING_OUTPUTS", "RUNNING")).toBe("UPLOADING_OUTPUTS");
  });
});
