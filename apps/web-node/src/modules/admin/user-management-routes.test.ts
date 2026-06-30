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

import { adminUserRouter } from "./user-management-routes.js";

describe("admin user management routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("creates a user and writes an audit entry", async () => {
    const adminUserService = {
      createUser: vi.fn().mockResolvedValue({
        id: "user-2",
        email: "creator@example.com",
        status: "ACTIVE",
        plan: { code: "FREE" },
        roles: [{ role: { code: "USER" } }]
      })
    };

    const response = await request(buildApp(adminUserService))
      .post("/api/v1/admin/users")
      .send({
        email: "creator@example.com",
        display_name: "Creator",
        password: "StrongPassword12",
        status: "ACTIVE",
        plan_code: "FREE",
        role_codes_csv: "USER"
      });

    expect(response.status).toBe(201);
    expect(adminUserService.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "creator@example.com",
        display_name: "Creator",
        role_codes_csv: "USER"
      })
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_USER_CREATED",
        resourceId: "user-2"
      })
    );
  });

  it("updates a user and writes an audit entry", async () => {
    const adminUserService = {
      updateUser: vi.fn().mockResolvedValue({
        id: "user-2",
        email: "creator@example.com",
        status: "SUSPENDED",
        plan: null,
        roles: [{ role: { code: "USER" } }]
      })
    };

    const response = await request(buildApp(adminUserService))
      .post("/api/v1/admin/users/user-2/update")
      .send({
        email: "creator@example.com",
        display_name: "Creator Updated",
        status: "SUSPENDED",
        plan_code: "",
        role_codes_csv: "USER"
      });

    expect(response.status).toBe(200);
    expect(adminUserService.updateUser).toHaveBeenCalledWith(
      "user-2",
      "admin-1",
      expect.objectContaining({ status: "SUSPENDED" })
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_USER_UPDATED",
        resourceId: "user-2"
      })
    );
  });

  it("revoke sessions route includes the revoked count in audit metadata", async () => {
    const adminUserService = {
      revokeSessions: vi.fn().mockResolvedValue({ count: 3 })
    };

    const response = await request(buildApp(adminUserService)).post("/api/v1/admin/users/user-2/revoke-sessions").send({});

    expect(response.status).toBe(200);
    expect(adminUserService.revokeSessions).toHaveBeenCalledWith("user-2", "admin-1");
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ADMIN_USER_SESSIONS_REVOKED",
        metadata: { revoked_sessions: 3 }
      })
    );
  });

  it("enforces admin.users.write permission on mutations", async () => {
    const adminUserService = {
      verifyEmail: vi.fn()
    };

    const response = await request(buildApp(adminUserService, { permissions: ["admin.users.read"] }))
      .post("/api/v1/admin/users/user-2/verify-email")
      .send({});

    expect(response.status).toBe(403);
    expect(adminUserService.verifyEmail).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

function buildApp(
  adminUserService: Record<string, ReturnType<typeof vi.fn>>,
  options?: { permissions?: string[] }
) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "admin-1",
      effectiveUserId: "admin-1",
      permissions: new Set(options?.permissions ?? ["admin.users.read", "admin.users.write"]),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(adminUserRouter(adminUserService as never));
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
