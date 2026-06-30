import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";
import { jobsRouter } from "./routes.js";

describe("job outputs route", () => {
  it("returns structured output summary and serialized clip outputs", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "job-1",
      status: "COMPLETED",
      outputSummary: {
        analysis_version: "2.3",
        source_summary: "Source material summary.",
        candidate_count: 2,
        analyzer: { analysis_mode: "openai" },
        candidates: [{ candidate_id: "candidate-1" }]
      },
      clipCandidates: [
        {
          id: "db-candidate-1",
          transcriptId: "transcript-1",
          candidateExternalId: "candidate-1",
          startMs: 12500n,
          endMs: 30250n,
          durationMs: 17750n,
          title: "Kenapa intro ini bikin retention naik",
          hookText: "Kenapa orang langsung berhenti scroll di sini?",
          endingText: "Karena payoff-nya cepat terasa.",
          summary: "Potongan insight tentang hook dan retention.",
          whyItWorks: ["Opens with a clear hook."],
          contentCategory: "insight",
          scoreBreakdown: { final_viral_score: 8.15 },
          baseViralScore: "8.42",
          finalViralScore: "8.15",
          contextComplete: true,
          safetyNotes: [],
          metadataSuggestions: {
            suggested_caption: "Caption",
            hook_second: 0,
            main_point_second: 6.2,
            punchline_second: 17.5,
            retention_level: "very_high",
            requires_context: false,
            can_standalone: true
          },
          speakerIds: ["speaker-1"],
          sceneIds: ["scene-2"],
          analyzerMetadata: { analysis_version: "2.3" },
          selected: true,
          rank: 1,
          createdAt: new Date("2026-06-26T09:59:00.000Z"),
          updatedAt: new Date("2026-06-26T10:04:00.000Z")
        }
      ],
      clipOutputs: [
        {
          id: "output-1",
          candidateId: "candidate-row-1",
          mediaAssetId: "asset-1",
          version: 1,
          qualityStatus: "APPROVED",
          previewObjectKey: "preview/key.mp4",
          finalObjectKey: "final/key.mp4",
          metadataObjectKey: "meta/key.json",
          thumbnailObjectKey: "thumb/key.jpg",
          renderSettings: {
            visual: { aspect_ratio: "9:16" },
            candidate: { candidate_id: "candidate-1", start_ms: "12500" },
            analyzer: { analysis_mode: "openai" }
          },
          qualityReport: {
            score: 9.1,
            renderer: "phase2-placeholder",
            status: "preview_ready",
            candidate: {
              title: "Kenapa intro ini bikin retention naik",
              start_ms: "12500",
              end_ms: "30250"
            },
            metadata: {
              suggested_caption: "Caption siap upload",
              suggested_hashtags: ["#retention", "#hook"],
              retention_level: "very_high"
            },
            validation: {
              status: "passed",
              checks: {
                playable: true,
                resolution_matches_target: true,
                audio_present: true
              }
            }
          },
          durationMs: 27500n,
          width: 1080,
          height: 1920,
          subtitles: [
            {
              id: "subtitle-1",
              format: "srt",
              language: "id",
              objectKey: "subtitle/key.srt",
              isBurnedIn: false,
              createdAt: new Date("2026-06-26T10:04:30.000Z")
            }
          ],
          createdAt: new Date("2026-06-26T10:00:00.000Z"),
          updatedAt: new Date("2026-06-26T10:05:00.000Z")
        }
      ]
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use((request, _response, next) => {
      request.identity = {
        actorUserId: "user-1",
        effectiveUserId: "user-1",
        permissions: new Set<string>(),
        isImpersonating: false
      };
      next();
    });
    app.use(
      jobsRouter(
        { get } as never,
        {
          on: () => () => undefined
        } as never
      )
    );
    app.use(errorHandler);

    const response = await request(app).get("/api/v1/jobs/job-1/outputs");

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith("user-1", "job-1");
    expect(response.body.data).toEqual({
      job_id: "job-1",
      status: "COMPLETED",
      candidate_count: 2,
      output_summary: {
        analysis_version: "2.3",
        source_summary: "Source material summary.",
        candidate_count: 2,
        analyzer: { analysis_mode: "openai" },
        candidates: [{ candidate_id: "candidate-1" }]
      },
      clip_candidates: [
        {
          id: "db-candidate-1",
          transcript_id: "transcript-1",
          candidate_id: "candidate-1",
          start_ms: "12500",
          end_ms: "30250",
          duration_ms: "17750",
          title: "Kenapa intro ini bikin retention naik",
          hook_text: "Kenapa orang langsung berhenti scroll di sini?",
          ending_text: "Karena payoff-nya cepat terasa.",
          summary: "Potongan insight tentang hook dan retention.",
          why_it_works: ["Opens with a clear hook."],
          content_category: "insight",
          score_breakdown: { final_viral_score: 8.15 },
          base_viral_score: "8.42",
          final_viral_score: "8.15",
          context_complete: true,
          safety_notes: [],
          metadata_suggestions: {
            suggested_caption: "Caption",
            hook_second: 0,
            main_point_second: 6.2,
            punchline_second: 17.5,
            retention_level: "very_high",
            requires_context: false,
            can_standalone: true
          },
          speaker_ids: ["speaker-1"],
          scene_ids: ["scene-2"],
          analyzer_metadata: { analysis_version: "2.3" },
          selected: true,
          rank: 1,
          created_at: "2026-06-26T09:59:00.000Z",
          updated_at: "2026-06-26T10:04:00.000Z"
        }
      ],
      clip_outputs: [
        {
          id: "output-1",
          candidate_id: "candidate-row-1",
          media_asset_id: "asset-1",
          version: 1,
          quality_status: "APPROVED",
          preview_object_key: "preview/key.mp4",
          final_object_key: "final/key.mp4",
          metadata_object_key: "meta/key.json",
          thumbnail_object_key: "thumb/key.jpg",
          render_settings: {
            visual: { aspect_ratio: "9:16" },
            candidate: { candidate_id: "candidate-1", start_ms: "12500" },
            analyzer: { analysis_mode: "openai" }
          },
          quality_report: {
            score: 9.1,
            renderer: "phase2-placeholder",
            status: "preview_ready",
            candidate: {
              title: "Kenapa intro ini bikin retention naik",
              start_ms: "12500",
              end_ms: "30250"
            },
            metadata: {
              suggested_caption: "Caption siap upload",
              suggested_hashtags: ["#retention", "#hook"],
              retention_level: "very_high"
            },
            validation: {
              status: "passed",
              checks: {
                playable: true,
                resolution_matches_target: true,
                audio_present: true
              }
            }
          },
          duration_ms: "27500",
          width: 1080,
          height: 1920,
          output_summary: {
            aspect_ratio: "9:16",
            target_platform: null,
            objective: null,
            renderer: "phase2-placeholder",
            render_status: "preview_ready",
            candidate_title: "Kenapa intro ini bikin retention naik",
            clip_start_ms: "12500",
            clip_end_ms: "30250",
            suggested_caption: "Caption siap upload",
            suggested_hashtags: ["#retention", "#hook"],
            retention_level: "very_high",
            validation_status: "passed",
            output_playable: true,
            resolution_matches_target: true,
            audio_present: true,
            subtitle_format: null,
            subtitle_language: null,
            subtitle_burned_in: null
          },
          subtitles: [
            {
              id: "subtitle-1",
              format: "srt",
              language: "id",
              object_key: "subtitle/key.srt",
              is_burned_in: false,
              created_at: "2026-06-26T10:04:30.000Z"
            }
          ],
          created_at: "2026-06-26T10:00:00.000Z",
          updated_at: "2026-06-26T10:05:00.000Z"
        }
      ]
    });
  });

  it("falls back to clip output count when output summary is not attached yet", async () => {
    const get = vi.fn().mockResolvedValue({
      id: "job-2",
      status: "RUNNING",
      outputSummary: null,
      clipCandidates: [],
      clipOutputs: [
        {
          id: "output-2",
          candidateId: "candidate-row-2",
          mediaAssetId: null,
          version: 1,
          qualityStatus: "PENDING",
          previewObjectKey: null,
          finalObjectKey: null,
          metadataObjectKey: null,
          thumbnailObjectKey: null,
          renderSettings: {},
          qualityReport: {},
          durationMs: null,
          width: null,
          height: null,
          subtitles: [],
          createdAt: new Date("2026-06-26T11:00:00.000Z"),
          updatedAt: new Date("2026-06-26T11:00:00.000Z")
        }
      ]
    });

    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use((request, _response, next) => {
      request.identity = {
        actorUserId: "user-1",
        effectiveUserId: "user-1",
        permissions: new Set<string>(),
        isImpersonating: false
      };
      next();
    });
    app.use(
      jobsRouter(
        { get } as never,
        {
          on: () => () => undefined
        } as never
      )
    );
    app.use(errorHandler);

    const response = await request(app).get("/api/v1/jobs/job-2/outputs");

    expect(response.status).toBe(200);
    expect(response.body.data.candidate_count).toBe(1);
    expect(response.body.data.output_summary).toBeNull();
  });
});
