import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestContext } from "../../shared/http/request-context.js";

const mockPrisma = vi.hoisted(() => ({
  job: {
    findFirst: vi.fn(),
  },
  jobEvent: {
    findMany: vi.fn(),
  },
  mediaAsset: {
    findMany: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
  preset: {
    findMany: vi.fn(),
  },
  brandKit: {
    findMany: vi.fn(),
  },
}));

const mockListLocalTtsModels = vi.hoisted(() => vi.fn());
const mockCreatePublicSignedObjectReadUrl = vi.hoisted(() => vi.fn());

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../auth/identity-middleware.js", () => ({
  requireAuth: (request: any, _response: any, next: any) => {
    if (!request.identity) throw new Error("identity missing");
    next();
  },
  requirePermission: () => (_request: any, _response: any, next: any) => next(),
}));

vi.mock("../tts/local-tts-model-registry.js", () => ({
  listLocalTtsModels: mockListLocalTtsModels,
}));

vi.mock("../../infrastructure/storage/s3.js", () => ({
  createPublicSignedObjectReadUrl: mockCreatePublicSignedObjectReadUrl,
}));

import { dashboardRouter } from "./routes.js";

describe("dashboard tool routes", () => {
  beforeEach(() => {
    mockPrisma.job.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.jobEvent.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.mediaAsset.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.user.findUnique.mockReset().mockResolvedValue({
      setting: {
        defaultContentNiche: "Education",
        defaultAudience: "Beginners",
        preferences: {},
      },
    });
    mockPrisma.preset.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.brandKit.findMany.mockReset().mockResolvedValue([]);
    mockListLocalTtsModels.mockReset().mockResolvedValue([]);
    mockCreatePublicSignedObjectReadUrl.mockReset().mockResolvedValue("https://example.com/object.mp4");
  });

  it("renders auto clipping page with safe defaults", async () => {
    const response = await request(buildApp()).get("/app/tools/auto-clipping");

    expect(response.status).toBe(200);
    expect(response.body.data.formDefaults.layoutTemplate).toBe("STANDARD");
    expect(response.body.data.formDefaults.hookStyle).toBe("");
    expect(response.body.data.formDefaults.ctaPreference).toBe("");
    expect(response.body.data.formDefaults.standalonePriority).toBe("FLEXIBLE");
    expect(response.body.data.formDefaults.subtitleStyle).toBe("PODCAST_HIGHLIGHT");
    expect(response.body.data.formDefaults.channelName).toBe("");
  });

  it("renders text to speech page even when malformed local models are returned", async () => {
    mockListLocalTtsModels.mockResolvedValue([
      { key: "broken-model" },
      {
        key: "id_ID-test-medium",
        displayName: "Indonesia - Test Medium",
        languageCode: "id_ID",
        localeGroup: "id-ID",
        voiceName: "Test Medium",
        quality: "medium",
        sampleRate: 22050,
        speakerCount: 1,
        phonemeType: null,
        dataset: null,
        defaultSampleText: "Halo dunia",
      },
    ]);

    const response = await request(buildApp()).get("/app/tools/text-to-speech");

    expect(response.status).toBe(200);
    expect(response.body.data.localTtsModels).toHaveLength(1);
    expect(response.body.data.formDefaults.localModelKey).toBe("id_ID-test-medium");
  });

  it("renders auto clipping job detail when clip outputs exist", async () => {
    mockPrisma.job.findFirst.mockResolvedValue({
      id: "job-1",
      userId: "user-1",
      type: "AUTO_CLIPPING",
      status: "COMPLETED",
      workflowId: "wf-1",
      progressPercent: 92,
      currentStage: "UPLOADING_OUTPUTS",
      createdAt: new Date("2026-07-07T08:11:03.000Z"),
      startedAt: new Date("2026-07-07T08:12:00.000Z"),
      completedAt: new Date("2026-07-07T08:20:00.000Z"),
      outputSummary: {},
      inputSnapshot: {},
      project: { name: "No project" },
      sourceMediaAsset: {
        displayName: "source.mp4",
        durationMs: 120000,
        objectKey: "source.mp4",
        mimeType: "video/mp4",
      },
      autoClipRequest: null,
      ttsRequest: null,
      attempts: [],
      errors: [],
      stages: [],
      clipCandidates: [],
      clipOutputs: [
        {
          id: "output-1",
          candidateId: "candidate-1",
          qualityStatus: "COMPLETED",
          durationMs: 10000,
          version: 1,
          width: 1080,
          height: 1920,
          createdAt: new Date("2026-07-07T08:19:00.000Z"),
          previewObjectKey: "preview.mp4",
          finalObjectKey: "final.mp4",
          metadataObjectKey: null,
          thumbnailObjectKey: null,
          renderSettings: {},
          qualityReport: {},
          subtitles: [],
        },
      ],
    });

    const response = await request(buildApp()).get("/app/jobs/job-1");

    expect(response.status).toBe(200);
    expect(response.body.data.job.id).toBe("job-1");
    expect(response.body.data.clipOutputs).toHaveLength(1);
  });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "user-1",
      effectiveUserId: "user-1",
      permissions: new Set<string>(),
      isImpersonating: false,
    };
    request.session = { csrfToken: "csrf-token", trackedSessionId: "session-1" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(dashboardRouter);
  app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({
      error: {
        code: error.code ?? "INTERNAL_SERVER_ERROR",
        message: error.message,
      },
    });
  });
  return app;
}
