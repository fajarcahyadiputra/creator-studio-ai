import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";

const { writeAudit } = vi.hoisted(() => ({
  writeAudit: vi.fn()
}));

vi.mock("../audit/audit-service.js", () => ({
  writeAudit
}));

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));

vi.mock("./job-service.js", () => ({
  assertIdempotencyKey: (value: string | undefined) => value ?? "mock-idempotency-key",
  serializeJob: (job: unknown) => job
}));

import { jobsRouter } from "./routes.js";

describe("clip output rerender route", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("queues a clip output rerender and writes an audit entry", async () => {
    const rerenderClipOutput = vi.fn().mockResolvedValue({
      clipOutputId: "output-1",
      qualityStatus: "PENDING"
    });

    const response = await request(buildApp({ rerenderClipOutput })).post("/api/v1/jobs/job-1/outputs/output-1/rerender");

    expect(response.status).toBe(202);
    expect(rerenderClipOutput).toHaveBeenCalledWith({
      userId: "user-1",
      jobId: "job-1",
      clipOutputId: "output-1"
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CLIP_OUTPUT_RERENDER_REQUESTED",
        resourceType: "ClipOutput",
        resourceId: "output-1"
      })
    );
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      quality_status: "PENDING",
      message: "Clip output rerender queued."
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
