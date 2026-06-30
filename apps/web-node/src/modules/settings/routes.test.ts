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

import { settingsRouter } from "./routes.js";

describe("settings routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("renders settings page", async () => {
    const service = {
      getSettingsPageData: vi.fn().mockResolvedValue({
        user: { plan: null },
        profile: {},
        aiPreference: {},
        providers: [],
        sessions: [],
        notifications: {}
      })
    };

    const response = await request(buildApp(service)).get("/app/settings");

    expect(response.status).toBe(200);
    expect(service.getSettingsPageData).toHaveBeenCalledWith("user-1", "session-1");
  });

  it("updates profile and writes an audit entry", async () => {
    const service = {
      updateProfile: vi.fn().mockResolvedValue({})
    };

    const response = await request(buildApp(service))
      .post("/api/v1/settings/profile")
      .send({
        display_name: "Creator",
        locale: "id",
        timezone: "Asia/Jakarta",
        default_content_niche: "Education",
        default_audience: "Beginners"
      });

    expect(response.status).toBe(200);
    expect(service.updateProfile).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_PROFILE_UPDATED" }));
  });

  it("revokes a session and writes an audit entry", async () => {
    const service = {
      revokeSession: vi.fn().mockResolvedValue({ count: 1 })
    };

    const response = await request(buildApp(service)).post("/api/v1/settings/sessions/session-2/revoke").send({});

    expect(response.status).toBe(200);
    expect(service.revokeSession).toHaveBeenCalledWith("user-1", "session-2", "session-1");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_SESSION_REVOKED" }));
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
    request.session = { csrfToken: "csrf-token", trackedSessionId: "session-1" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(settingsRouter(service as never));
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

