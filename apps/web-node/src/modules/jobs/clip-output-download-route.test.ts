import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";

vi.mock("../auth/identity-middleware.js", () => ({
  requireAuth: (request: any, _response: any, next: any) => {
    if (!request.identity) throw new Error("identity missing");
    next();
  }
}));

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));

vi.mock("./job-service.js", () => ({
  assertIdempotencyKey: (value: string | undefined) => value ?? "mock-idempotency-key",
  serializeJob: (job: unknown) => job
}));

import { jobsRouter } from "./routes.js";

describe("clip output download route", () => {
  it("redirects to a signed URL for the requested artifact", async () => {
    const createClipOutputArtifactUrl = vi.fn().mockResolvedValue("https://signed.example/final.mp4");

    const response = await request(
      buildApp({
        createClipOutputArtifactUrl
      })
    ).get("/app/jobs/job-1/outputs/output-1/download?artifact=final");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://signed.example/final.mp4");
    expect(createClipOutputArtifactUrl).toHaveBeenCalledWith("user-1", "job-1", "output-1", "final");
  });

  it("rejects an invalid artifact query", async () => {
    const createClipOutputArtifactUrl = vi.fn();

    const response = await request(
      buildApp({
        createClipOutputArtifactUrl
      })
    ).get("/app/jobs/job-1/outputs/output-1/download?artifact=invalid");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_CLIP_OUTPUT_ARTIFACT");
    expect(createClipOutputArtifactUrl).not.toHaveBeenCalled();
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
