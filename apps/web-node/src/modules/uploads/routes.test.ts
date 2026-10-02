import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../../shared/http/request-context.js";
import { uploadsRouter } from "./routes.js";

vi.mock("../auth/identity-middleware.js", () => ({
  requireAuth: (_request: express.Request, _response: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../jobs/job-service.js", () => ({
  assertIdempotencyKey: vi.fn(),
}));

describe("upload status route", () => {
  it("returns the validation state for an upload owned by the current user", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      uploadId: "upload-1",
      uploadStatus: "COMPLETED",
      expiresAt: new Date("2026-10-03T00:00:00.000Z"),
      mediaAsset: {
        id: "asset-1",
        status: "READY",
        displayName: "source.mp4",
        sizeBytes: 123n,
        durationMs: 456n,
        metadata: { validation: { status: "READY" } },
      },
    });
    const app = buildApp({ getStatus });

    const response = await request(app).get("/api/v1/uploads/upload-1");

    expect(response.status).toBe(200);
    expect(getStatus).toHaveBeenCalledWith("user-1", "upload-1");
    expect(response.body.data).toEqual({
      upload_id: "upload-1",
      upload_status: "COMPLETED",
      expires_at: "2026-10-03T00:00:00.000Z",
      media_asset: {
        id: "asset-1",
        status: "READY",
        display_name: "source.mp4",
        size_bytes: "123",
        duration_ms: "456",
        metadata: { validation: { status: "READY" } },
      },
    });
  });
});

function buildApp(service: { getStatus: ReturnType<typeof vi.fn> }) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, _response, next) => {
    request.identity = {
      actorUserId: "user-1",
      effectiveUserId: "user-1",
      permissions: new Set<string>(),
      isImpersonating: false,
    };
    next();
  });
  app.use(uploadsRouter(service as never));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    response.status(statusCode).json({ error: { message: error instanceof Error ? error.message : "Unknown error" } });
  });
  return app;
}
