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

import { presetsRouter } from "./routes.js";

describe("presets routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("renders presets page", async () => {
    const service = {
      getPresetsPageData: vi.fn().mockResolvedValue({
        presets: [],
        brandKits: []
      })
    };

    const response = await request(buildApp(service)).get("/app/presets");

    expect(response.status).toBe(200);
    expect(service.getPresetsPageData).toHaveBeenCalledWith("user-1");
  });

  it("creates a preset and writes an audit entry", async () => {
    const service = {
      createPreset: vi.fn().mockResolvedValue({ id: "preset-1" })
    };

    const response = await request(buildApp(service))
      .post("/api/v1/presets")
      .send({
        name: "TikTok preset",
        description: "Fast hook",
        type: "CLIPPING",
        is_default: true,
        config_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(service.createPreset).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_PRESET_CREATED" }));
  });

  it("creates a brand kit and writes an audit entry", async () => {
    const service = {
      createBrandKit: vi.fn().mockResolvedValue({ id: "brand-1" })
    };

    const response = await request(buildApp(service))
      .post("/api/v1/brand-kits")
      .send({
        name: "Studio kit",
        is_default: true,
        font_config_json: "{}",
        color_config_json: "{}",
        safe_margin_config_json: "{}",
        subtitle_preset_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(service.createBrandKit).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_BRAND_KIT_CREATED" }));
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
  app.use(presetsRouter(service as never));
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

