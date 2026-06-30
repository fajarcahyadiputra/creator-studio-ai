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

import { adminJobRouter } from "./job-management-routes.js";

describe("admin job management routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("renders the admin jobs page", async () => {
    const adminJobService = {
      getJobManagementPageData: vi.fn().mockResolvedValue({
        filters: { q: "", status: "ALL", type: "ALL" },
        jobStatusOptions: ["FAILED"],
        jobTypeOptions: ["AUTO_CLIPPING"],
        jobs: []
      })
    };

    const response = await request(buildApp(adminJobService)).get("/admin/jobs");

    expect(response.status).toBe(200);
    expect(adminJobService.getJobManagementPageData).toHaveBeenCalled();
  });

  it("requests admin cancel and writes an audit entry", async () => {
    const adminJobService = {
      cancelJob: vi.fn().mockResolvedValue({ id: "job-1", userId: "user-1" })
    };

    const response = await request(buildApp(adminJobService)).post("/api/v1/admin/jobs/job-1/cancel").send({});

    expect(response.status).toBe(200);
    expect(adminJobService.cancelJob).toHaveBeenCalledWith("job-1");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_JOB_CANCEL_REQUESTED" }));
  });

  it("requests admin retry and writes an audit entry", async () => {
    const adminJobService = {
      retryJob: vi.fn().mockResolvedValue({ id: "job-1", userId: "user-1", workflowId: "job-1:attempt:2" })
    };

    const response = await request(buildApp(adminJobService))
      .post("/api/v1/admin/jobs/job-1/retry")
      .send({ reason: "Recover infra failure", stage: "TRANSCRIBING" });

    expect(response.status).toBe(200);
    expect(adminJobService.retryJob).toHaveBeenCalledWith("job-1", "Recover infra failure", "TRANSCRIBING");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_JOB_RETRY_REQUESTED" }));
  });

  it("blocks access without admin.jobs.manage permission", async () => {
    const adminJobService = {
      getJobManagementPageData: vi.fn()
    };

    const response = await request(buildApp(adminJobService, { permissions: ["admin.users.read"] })).get("/admin/jobs");

    expect(response.status).toBe(403);
    expect(adminJobService.getJobManagementPageData).not.toHaveBeenCalled();
  });
});

function buildApp(
  adminJobService: Record<string, ReturnType<typeof vi.fn>>,
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
  app.use(adminJobRouter(adminJobService as never));
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

