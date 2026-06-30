import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));

vi.mock("./job-service.js", () => ({
  assertIdempotencyKey: (value: string | undefined) => value ?? "mock-idempotency-key",
  serializeJob: (job: unknown) => job
}));

import { jobsRouter } from "./routes.js";

describe("clip output export index route", () => {
  it("downloads a JSON export index for all available artifacts", async () => {
    const createClipOutputExportIndex = vi.fn().mockResolvedValue({
      clipOutputId: "output-1",
      jobId: "job-1",
      candidateId: "candidate-row-1",
      qualityStatus: "PASSED",
      artifacts: [
        { artifact: "final", label: "Final video", url: "https://signed.example/final.mp4" },
        { artifact: "subtitle", label: "Subtitle file", url: "https://signed.example/subtitle.srt" }
      ]
    });

    const response = await request(buildApp({ createClipOutputExportIndex })).get(
      "/app/jobs/job-1/outputs/output-1/export-index"
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toContain("clip-output-output-1-export-index.json");
    expect(createClipOutputExportIndex).toHaveBeenCalledWith("user-1", "job-1", "output-1");
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      job_id: "job-1",
      candidate_id: "candidate-row-1",
      quality_status: "PASSED",
      artifacts: [
        { artifact: "final", label: "Final video", url: "https://signed.example/final.mp4" },
        { artifact: "subtitle", label: "Subtitle file", url: "https://signed.example/subtitle.srt" }
      ]
    });
  });
});

function buildApp(service: Record<string, ReturnType<typeof vi.fn>>) {
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
      service as never,
      {
        on: () => () => undefined
      } as never
    )
  );
  app.use(errorHandler);
  return app;
}
