import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";

const prisma = {
  clipOutput: {
    findFirst: vi.fn(),
    update: vi.fn()
  }
};

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma
}));

describe("internal clip output routes", () => {
  beforeEach(() => {
    prisma.clipOutput.findFirst.mockReset();
    prisma.clipOutput.update.mockReset();
  });

  it("returns render context for a clip output", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.clipOutput.findFirst.mockResolvedValue({
      id: "output-1",
      jobId: "job-1",
      candidateId: "candidate-row-1",
      version: 1,
      qualityStatus: "PENDING",
      renderSettings: { visual: { aspect_ratio: "9:16" } },
      previewObjectKey: null,
      finalObjectKey: null,
      metadataObjectKey: null,
      thumbnailObjectKey: null,
      candidate: {
        candidateExternalId: "candidate-01",
        title: "Candidate title",
        summary: "Candidate summary",
        hookText: "Hook",
        startMs: 12000n,
        endMs: 30000n,
        durationMs: 18000n
      },
      job: {}
    });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .get("/internal/v1/clip-outputs/output-1/render-context")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      job_id: "job-1",
      candidate_id: "candidate-row-1",
      version: 1,
      quality_status: "PENDING",
      render_settings: { visual: { aspect_ratio: "9:16" } },
      candidate: {
        candidate_id: "candidate-01",
        title: "Candidate title",
        summary: "Candidate summary",
        hook_text: "Hook",
        start_ms: "12000",
        end_ms: "30000",
        duration_ms: "18000"
      },
      output_targets: {
        preview_object_key: null,
        final_object_key: null,
        metadata_object_key: null,
        thumbnail_object_key: null
      }
    });
  });

  it("updates clip output result fields", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.clipOutput.update.mockResolvedValue({
      id: "output-1",
      qualityStatus: "PASSED"
    });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .post("/internal/v1/clip-outputs/output-1/result")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters")
      .send({
        quality_status: "PASSED",
        preview_object_key: "users/u/jobs/j/previews/c1.mp4",
        quality_report: { score: 9.1 },
        duration_ms: "18000",
        width: 1080,
        height: 1920
      });

    expect(response.status).toBe(200);
    expect(prisma.clipOutput.update).toHaveBeenCalledWith({
      where: { id: "output-1" },
      data: {
        qualityStatus: "PASSED",
        previewObjectKey: "users/u/jobs/j/previews/c1.mp4",
        finalObjectKey: undefined,
        metadataObjectKey: undefined,
        thumbnailObjectKey: undefined,
        qualityReport: { score: 9.1 },
        durationMs: 18000n,
        width: 1080,
        height: 1920
      }
    });
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      quality_status: "PASSED"
    });
  });
});
