import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { requestContext } from "../../shared/http/request-context.js";

vi.mock("../auth/identity-middleware.js", () => ({
  requireAuth: (request: any, _response: any, next: any) => {
    if (!request.identity) throw new Error("identity missing");
    next();
  }
}));

import { mediaRouter } from "./routes.js";

describe("media routes", () => {
  it("redirects admin users to the new admin media page", async () => {
    const response = await request(buildApp({ permissions: ["admin.jobs.manage"] })).get("/app/media");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/admin/media");
  });

  it("blocks non-admin users from the legacy page", async () => {
    const response = await request(buildApp()).get("/app/media");

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("redirects admin downloads to the admin media page", async () => {
    const response = await request(buildApp({ permissions: ["admin.jobs.manage"] })).get("/app/media/asset-1/download");

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/admin/media/asset-1/download");
  });

  it("blocks legacy rename endpoint even for admins", async () => {
    const response = await request(buildApp({ permissions: ["admin.jobs.manage"] }))
      .post("/api/v1/media/asset-1/rename")
      .send({ display_name: "Renamed asset" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("blocks legacy restore endpoint", async () => {
    const response = await request(buildApp({ permissions: ["admin.jobs.manage"] }))
      .post("/api/v1/media/asset-1/restore")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("blocks legacy delete endpoint even for admins", async () => {
    const response = await request(buildApp({ permissions: ["admin.jobs.manage"] }))
      .post("/api/v1/media/asset-1/delete")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });
});

function buildApp(options?: { permissions?: string[] }) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "user-1",
      effectiveUserId: "user-1",
      permissions: new Set<string>(options?.permissions ?? []),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(mediaRouter());
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
