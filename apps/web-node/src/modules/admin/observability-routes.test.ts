import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../../shared/http/request-context.js";

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

import { adminObservabilityRouter } from "./observability-routes.js";

describe("admin observability routes", () => {
  it("renders audit logs page", async () => {
    const adminObservabilityService = {
      getAuditLogPageData: vi.fn().mockResolvedValue({
        filters: { q: "", action: "ALL" },
        actionOptions: ["AUTH_LOGIN"],
        auditLogs: []
      })
    };

    const response = await request(buildApp(adminObservabilityService, ["admin.audit.read"])).get("/admin/audit-logs");

    expect(response.status).toBe(200);
    expect(adminObservabilityService.getAuditLogPageData).toHaveBeenCalled();
  });

  it("renders worker health page", async () => {
    const adminObservabilityService = {
      getWorkerHealthPageData: vi.fn().mockResolvedValue({
        services: [],
        jobBacklog: {},
        providers: []
      })
    };

    const response = await request(buildApp(adminObservabilityService, ["admin.dashboard.view"])).get("/admin/workers");

    expect(response.status).toBe(200);
    expect(adminObservabilityService.getWorkerHealthPageData).toHaveBeenCalled();
  });
});

function buildApp(service: Record<string, ReturnType<typeof vi.fn>>, permissions: string[]) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "admin-1",
      effectiveUserId: "admin-1",
      permissions: new Set(permissions),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(adminObservabilityRouter(service as never));
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

