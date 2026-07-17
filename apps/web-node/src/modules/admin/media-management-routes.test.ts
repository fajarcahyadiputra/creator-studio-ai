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
  },
  requirePermission:
    (permission: string) => (request: any, _response: any, next: any) => {
      if (!request.identity?.permissions.has(permission)) {
        const error = new Error("Forbidden");
        (error as Error & { statusCode?: number }).statusCode = 403;
        throw error;
      }
      next();
    }
}));

import { adminMediaRouter } from "./media-management-routes.js";

describe("admin media management routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("renders the admin media page", async () => {
    const adminMediaService = {
      getMediaManagementPageData: vi.fn().mockResolvedValue({
        filters: { q: "", type: "ALL", status: "ALL", kind: "ALL", family: "ALL", userId: "", view: "list", deleted: false },
        typeOptions: ["VIDEO"],
        statusOptions: ["READY"],
        kindOptions: ["IMPORTED_SOURCE", "CLIP_RESULT"],
        familyOptions: ["SOURCE_ONLY", "OUTPUTS_ONLY"],
        userOptions: [],
        kindCounts: [],
        userSummaries: [],
        storageBytes: 0,
        assets: []
      })
    };

    const response = await request(buildApp(adminMediaService)).get("/admin/media");

    expect(response.status).toBe(200);
    expect(adminMediaService.getMediaManagementPageData).toHaveBeenCalled();
  });

  it("hard deletes media and writes an audit entry", async () => {
    const adminMediaService = {
      hardDelete: vi.fn().mockResolvedValue({
        id: "asset-1",
        userId: "user-1",
        objectKey: "users/user-1/imports/job-1/source/video.mp4",
        deletedObjectCount: 2
      })
    };

    const response = await request(buildApp(adminMediaService)).post("/api/v1/admin/media/asset-1/delete").send({});

    expect(response.status).toBe(200);
    expect(adminMediaService.hardDelete).toHaveBeenCalledWith("asset-1");
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_MEDIA_ASSET_HARD_DELETED",
        resourceId: "asset-1"
      })
    );
  });

  it("bulk deletes filtered media and writes an audit entry", async () => {
    const adminMediaService = {
      bulkHardDelete: vi.fn().mockResolvedValue({
        deletedAssetCount: 3,
        matchedAssetCount: 3,
        filters: {
          includeDeleted: false,
          search: "",
          type: "ALL",
          status: "ALL",
          kind: "ALL",
          family: "SOURCE_ONLY",
          userId: "user-1",
          view: "list"
        }
      })
    };

    const response = await request(buildApp(adminMediaService))
      .post("/api/v1/admin/media/bulk-delete")
      .send({ family: "SOURCE_ONLY", user_id: "user-1" });

    expect(response.status).toBe(200);
    expect(adminMediaService.bulkHardDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "SOURCE_ONLY",
        userId: "user-1"
      })
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_MEDIA_BULK_HARD_DELETED"
      })
    );
  });

  it("blocks access without admin.jobs.manage permission", async () => {
    const adminMediaService = {
      getMediaManagementPageData: vi.fn()
    };

    const response = await request(buildApp(adminMediaService, { permissions: ["admin.users.read"] })).get("/admin/media");

    expect(response.status).toBe(403);
    expect(adminMediaService.getMediaManagementPageData).not.toHaveBeenCalled();
  });
});

function buildApp(
  adminMediaService: Record<string, ReturnType<typeof vi.fn>>,
  options?: { permissions?: string[] }
) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "admin-1",
      effectiveUserId: "admin-1",
      permissions: new Set(options?.permissions ?? ["admin.jobs.manage"]),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(adminMediaRouter(adminMediaService as never));
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
