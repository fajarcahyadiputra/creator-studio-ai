import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestContext } from "../../shared/http/request-context.js";

const { writeAudit } = vi.hoisted(() => ({
  writeAudit: vi.fn()
}));

vi.mock("../audit/audit-service.js", () => ({
  writeAudit
}));

vi.mock("../auth/identity-middleware.js", () => ({
  requireAuth: (request: any, _response: any, next: any) => {
    if (!request.identity) throw new Error("identity missing");
    next();
  }
}));

import { mediaRouter } from "./routes.js";

describe("media routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("renders media library page", async () => {
    const service = {
      getMediaLibraryPageData: vi.fn().mockResolvedValue({
        filters: { q: "", type: "ALL", status: "ALL", view: "list", deleted: false },
        typeOptions: [],
        statusOptions: [],
        storageBytes: 0,
        assets: []
      })
    };

    const response = await request(buildApp(service)).get("/app/media");

    expect(response.status).toBe(200);
    expect(service.getMediaLibraryPageData).toHaveBeenCalled();
  });

  it("renames media and writes an audit entry", async () => {
    const service = {
      rename: vi.fn().mockResolvedValue({ id: "asset-1", displayName: "Renamed asset" })
    };

    const response = await request(buildApp(service))
      .post("/api/v1/media/asset-1/rename")
      .send({ display_name: "Renamed asset" });

    expect(response.status).toBe(200);
    expect(service.rename).toHaveBeenCalledWith("user-1", "asset-1", "Renamed asset");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_ASSET_RENAMED" }));
  });

  it("restores media and writes an audit entry", async () => {
    const service = {
      restore: vi.fn().mockResolvedValue({ id: "asset-1" })
    };

    const response = await request(buildApp(service)).post("/api/v1/media/asset-1/restore").send({});

    expect(response.status).toBe(200);
    expect(service.restore).toHaveBeenCalledWith("user-1", "asset-1");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "MEDIA_ASSET_RESTORED" }));
  });
});

function buildApp(service: Record<string, ReturnType<typeof vi.fn>>) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "user-1",
      effectiveUserId: "user-1",
      permissions: new Set<string>(),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(mediaRouter(service as never));
  app.use((error: any, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error.statusCode ?? 500).json({
      error: {
        code: error.code ?? "INTERNAL_SERVER_ERROR",
        message: error.message
      }
    });
  });
  return app;
}

