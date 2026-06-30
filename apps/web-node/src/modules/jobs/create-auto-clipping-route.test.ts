import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";

const writeAudit = vi.fn();

vi.mock("../audit/audit-service.js", () => ({
  writeAudit
}));

import { jobsRouter } from "./routes.js";

describe("create auto clipping route", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("creates a durable job from an uploaded media asset", async () => {
    const createAutoClippingJob = vi.fn().mockResolvedValue({
      id: "job-media-1",
      status: "QUEUED",
      currentStage: "VALIDATING_SOURCE",
      eventSequence: 0n
    });

    const app = buildApp({ createAutoClippingJob });

    const response = await request(app)
      .post("/api/v1/auto-clipping/jobs")
      .set("idempotency-key", "asset-source-key-123")
      .send({
        source: { type: "MEDIA_ASSET", media_asset_id: "550e8400-e29b-41d4-a716-446655440000" },
        content: {
          title: "Uploaded source clip",
          context: "Long-form workshop about retention hooks.",
          topic: "Audience retention",
          niche: "Creator Education",
          target_audience: "Beginner video creators",
          source_language: "id",
          speaker_count: 2,
          custom_vocabulary: ["retention", "hook"],
          rights_confirmed: true
        },
        strategy: {
          target_platform: "YOUTUBE_SHORTS",
          objective: "EDUCATION",
          tones: ["EDUCATIONAL"],
          desired_clip_count: 3,
          minimum_duration_seconds: 20,
          maximum_duration_seconds: 45,
          minimum_viral_score: 7,
          preferred_topics: ["hooks", "retention"],
          topics_to_avoid: ["politics"],
          sensitive_topics: ["medical claims"],
          hook_style: "QUESTION",
          cta_preference: "COMMENT",
          profanity_handling: "SUBTITLE_CENSOR",
          remove_long_silence: true,
          remove_filler_words: false
        },
        visual: {
          aspect_ratio: "9:16",
          crop_strategy: "AUTO_REFRAME",
          settings: {}
        },
        subtitle: {
          enabled: true,
          language: "id",
          burn_in: true,
          export_formats: ["SRT", "VTT"],
          settings: {
            style: "Bold kinetic",
            font_family: "Montserrat",
            position: "BOTTOM",
            max_lines: 2,
            safe_margin_percent: 8,
            word_highlight: true,
            profanity_censor: true
          }
        },
        ai: {
          credential_mode: "PLATFORM"
        }
      });

    expect(response.status).toBe(202);
    expect(createAutoClippingJob).toHaveBeenCalledWith({
      userId: "user-1",
      idempotencyKey: "asset-source-key-123",
      input: expect.objectContaining({
        source: {
          type: "MEDIA_ASSET",
          media_asset_id: "550e8400-e29b-41d4-a716-446655440000"
        },
        content: expect.objectContaining({
          niche: "Creator Education",
          target_audience: "Beginner video creators",
          custom_vocabulary: ["retention", "hook"]
        }),
        strategy: expect.objectContaining({
          preferred_topics: ["hooks", "retention"],
          profanity_handling: "SUBTITLE_CENSOR"
        }),
        subtitle: expect.objectContaining({
          settings: expect.objectContaining({
            font_family: "Montserrat",
            profanity_censor: true
          })
        })
      })
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTO_CLIP_JOB_CREATED",
        resourceType: "Job",
        resourceId: "job-media-1"
      })
    );
    expect(response.body.data).toEqual(
      expect.objectContaining({
        id: "job-media-1",
        status: "QUEUED",
        currentStage: "VALIDATING_SOURCE",
        eventSequence: "0"
      })
    );
  });

  it("creates a durable job from an external URL source", async () => {
    const createAutoClippingJob = vi.fn().mockResolvedValue({
      id: "job-external-1",
      status: "QUEUED",
      currentStage: "VALIDATING_SOURCE",
      eventSequence: 0n
    });

    const app = buildApp({ createAutoClippingJob });

    const response = await request(app)
      .post("/api/v1/auto-clipping/jobs")
      .set("idempotency-key", "external-source-key-123")
      .send({
        source: { type: "EXTERNAL_URL", url: "https://www.youtube.com/watch?v=abc123" },
        content: {
          title: "External source clip",
          custom_vocabulary: [],
          rights_confirmed: true
        },
        strategy: {
          target_platform: "TIKTOK",
          objective: "ENGAGEMENT",
          tones: ["SERIOUS"],
          desired_clip_count: 5,
          minimum_duration_seconds: 25,
          maximum_duration_seconds: 60,
          minimum_viral_score: 7,
          remove_long_silence: true,
          remove_filler_words: false
        },
        visual: {
          aspect_ratio: "9:16",
          crop_strategy: "CENTER",
          settings: {}
        },
        subtitle: {
          enabled: true,
          language: "id",
          burn_in: true,
          export_formats: ["SRT"],
          settings: {}
        },
        ai: {
          credential_mode: "PLATFORM"
        }
      });

    expect(response.status).toBe(202);
    expect(createAutoClippingJob).toHaveBeenCalledWith({
      userId: "user-1",
      idempotencyKey: "external-source-key-123",
      input: expect.objectContaining({
        source: {
          type: "EXTERNAL_URL",
          url: "https://www.youtube.com/watch?v=abc123"
        }
      })
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AUTO_CLIP_JOB_CREATED",
        resourceType: "Job",
        resourceId: "job-external-1"
      })
    );
  });

  it("rejects create requests without a valid idempotency key", async () => {
    const createAutoClippingJob = vi.fn();
    const app = buildApp({ createAutoClippingJob });

    const response = await request(app)
      .post("/api/v1/auto-clipping/jobs")
      .send({
        source: { type: "EXTERNAL_URL", url: "https://www.youtube.com/watch?v=abc123" },
        content: {
          title: "External source clip",
          custom_vocabulary: [],
          rights_confirmed: true
        },
        strategy: {
          target_platform: "TIKTOK",
          objective: "ENGAGEMENT",
          tones: ["SERIOUS"],
          desired_clip_count: 5,
          minimum_duration_seconds: 25,
          maximum_duration_seconds: 60,
          minimum_viral_score: 7,
          remove_long_silence: true,
          remove_filler_words: false
        },
        visual: {
          aspect_ratio: "9:16",
          crop_strategy: "CENTER",
          settings: {}
        },
        subtitle: {
          enabled: true,
          language: "id",
          burn_in: true,
          export_formats: ["SRT"],
          settings: {}
        },
        ai: {
          credential_mode: "PLATFORM"
        }
      });

    expect(response.status).toBe(400);
    expect(createAutoClippingJob).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(response.body.error).toEqual(
      expect.objectContaining({
        code: "IDEMPOTENCY_KEY_REQUIRED"
      })
    );
  });
});

function buildApp(jobService: { createAutoClippingJob: ReturnType<typeof vi.fn> }) {
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
      jobService as never,
      {
        on: () => () => undefined
      } as never
    )
  );
  app.use(errorHandler);
  return app;
}
