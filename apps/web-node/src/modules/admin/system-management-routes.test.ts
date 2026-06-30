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

import { adminSystemRouter } from "./system-management-routes.js";

describe("admin system management routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("creates a feature flag and writes an audit entry", async () => {
    const adminSystemService = {
      createFeatureFlag: vi.fn().mockResolvedValue({
        id: "flag-1",
        key: "maintenance_mode",
        enabled: true
      })
    };

    const response = await request(buildApp(adminSystemService))
      .post("/api/v1/admin/feature-flags")
      .send({
        key: "maintenance_mode",
        description: "Temporarily block new jobs",
        enabled: true,
        rules_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(adminSystemService.createFeatureFlag).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_FEATURE_FLAG_CREATED" }));
  });

  it("updates a feature flag and writes an audit entry", async () => {
    const adminSystemService = {
      updateFeatureFlag: vi.fn().mockResolvedValue({
        id: "flag-1",
        key: "maintenance_mode",
        enabled: false,
        version: 2
      })
    };

    const response = await request(buildApp(adminSystemService))
      .post("/api/v1/admin/feature-flags/flag-1/update")
      .send({
        key: "maintenance_mode",
        description: "",
        enabled: false,
        rules_json: "{}"
      });

    expect(response.status).toBe(200);
    expect(adminSystemService.updateFeatureFlag).toHaveBeenCalledWith("flag-1", expect.any(Object));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_FEATURE_FLAG_UPDATED" }));
  });

  it("creates a system setting and writes an audit entry", async () => {
    const adminSystemService = {
      createSystemSetting: vi.fn().mockResolvedValue({
        id: "setting-1",
        key: "provider_routing",
        isSecret: false
      })
    };

    const response = await request(buildApp(adminSystemService))
      .post("/api/v1/admin/system-settings")
      .send({
        key: "provider_routing",
        description: "Routing policy",
        is_secret: false,
        value_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(adminSystemService.createSystemSetting).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_SYSTEM_SETTING_CREATED" }));
  });

  it("blocks access without admin.system.manage permission", async () => {
    const adminSystemService = {
      getSystemManagementPageData: vi.fn()
    };

    const response = await request(buildApp(adminSystemService, { permissions: ["admin.users.read"] })).get("/admin/system");

    expect(response.status).toBe(403);
    expect(adminSystemService.getSystemManagementPageData).not.toHaveBeenCalled();
  });
});

function buildApp(
  adminSystemService: Record<string, ReturnType<typeof vi.fn>>,
  options?: { permissions?: string[] }
) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "admin-1",
      effectiveUserId: "admin-1",
      permissions: new Set(options?.permissions ?? ["admin.system.manage"]),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(adminSystemRouter(adminSystemService as never));
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

