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

import { adminProviderRouter } from "./provider-management-routes.js";

describe("admin provider management routes", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("creates a provider and writes an audit entry", async () => {
    const adminProviderService = {
      createProvider: vi.fn().mockResolvedValue({
        id: "provider-1",
        code: "OPENAI",
        displayName: "OpenAI",
        enabled: true,
        healthStatus: "UNKNOWN"
      })
    };

    const response = await request(buildApp(adminProviderService))
      .post("/api/v1/admin/providers")
      .send({
        code: "OPENAI",
        display_name: "OpenAI",
        adapter_type: "openai",
        base_url: "https://api.openai.com",
        enabled: true,
        health_status: "UNKNOWN",
        timeout_ms: 60000,
        retry_policy_json: "{}",
        rate_limit_config_json: "{}",
        metadata_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(adminProviderService.createProvider).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_PROVIDER_CREATED" }));
  });

  it("updates a provider and writes an audit entry", async () => {
    const adminProviderService = {
      updateProvider: vi.fn().mockResolvedValue({
        id: "provider-1",
        code: "OPENAI",
        displayName: "OpenAI Platform",
        enabled: false,
        healthStatus: "DEGRADED"
      })
    };

    const response = await request(buildApp(adminProviderService))
      .post("/api/v1/admin/providers/provider-1/update")
      .send({
        code: "OPENAI",
        display_name: "OpenAI Platform",
        adapter_type: "openai",
        base_url: "https://api.openai.com",
        enabled: false,
        health_status: "DEGRADED",
        timeout_ms: 45000,
        retry_policy_json: "{}",
        rate_limit_config_json: "{}",
        metadata_json: "{}"
      });

    expect(response.status).toBe(200);
    expect(adminProviderService.updateProvider).toHaveBeenCalledWith("provider-1", expect.any(Object));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_PROVIDER_UPDATED" }));
  });

  it("creates a model and writes an audit entry", async () => {
    const adminProviderService = {
      createModel: vi.fn().mockResolvedValue({
        id: "model-1",
        providerId: "550e8400-e29b-41d4-a716-446655440000",
        identifier: "gpt-4.1-mini",
        displayName: "GPT-4.1 Mini",
        enabled: true
      })
    };

    const response = await request(buildApp(adminProviderService))
      .post("/api/v1/admin/models")
      .send({
        provider_id: "550e8400-e29b-41d4-a716-446655440000",
        identifier: "gpt-4.1-mini",
        display_name: "GPT-4.1 Mini",
        enabled: true,
        context_limit: 128000,
        input_price_per_million: 0.15,
        output_price_per_million: 0.6,
        capabilities_csv: "CHAT,STRUCTURED_OUTPUT",
        metadata_json: "{}"
      });

    expect(response.status).toBe(201);
    expect(adminProviderService.createModel).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_MODEL_CREATED" }));
  });

  it("creates a platform credential and writes an audit entry", async () => {
    const adminProviderService = {
      createCredential: vi.fn().mockResolvedValue({
        id: "credential-1",
        providerId: "550e8400-e29b-41d4-a716-446655440000",
        label: "Primary key",
        status: "ACTIVE",
        maskedHint: "sk-t...1234"
      })
    };

    const response = await request(buildApp(adminProviderService))
      .post("/api/v1/admin/credentials")
      .send({
        provider_id: "550e8400-e29b-41d4-a716-446655440000",
        label: "Primary key",
        status: "ACTIVE",
        payload_json: "{\"api_key\":\"sk-test-1234\"}",
        allowed_tools_csv: "AUTO_CLIPPING,TRANSCRIPTION",
        allowed_model_ids_csv: "",
        usage_limit_config_json: "{}",
        last_connection_status: "UNKNOWN",
        expires_at: ""
      });

    expect(response.status).toBe(201);
    expect(adminProviderService.createCredential).toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_PLATFORM_CREDENTIAL_CREATED" }));
  });

  it("rotates a platform credential and writes a rotation audit entry", async () => {
    const adminProviderService = {
      updateCredential: vi.fn().mockResolvedValue({
        id: "credential-1",
        providerId: "550e8400-e29b-41d4-a716-446655440000",
        label: "Primary key",
        status: "ACTIVE",
        maskedHint: "sk-n...5678"
      })
    };

    const response = await request(buildApp(adminProviderService))
      .post("/api/v1/admin/credentials/credential-1/update")
      .send({
        label: "Primary key",
        status: "ACTIVE",
        rotate_payload_json: "{\"api_key\":\"sk-new-5678\"}",
        allowed_tools_csv: "AUTO_CLIPPING",
        allowed_model_ids_csv: "",
        usage_limit_config_json: "{}",
        last_connection_status: "OK",
        expires_at: ""
      });

    expect(response.status).toBe(200);
    expect(adminProviderService.updateCredential).toHaveBeenCalledWith("credential-1", expect.any(Object));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ADMIN_PLATFORM_CREDENTIAL_ROTATED" }));
  });

  it("blocks access without admin.providers.manage permission", async () => {
    const adminProviderService = {
      getProviderManagementPageData: vi.fn()
    };

    const response = await request(buildApp(adminProviderService, { permissions: ["admin.users.read"] })).get("/admin/providers");

    expect(response.status).toBe(403);
    expect(adminProviderService.getProviderManagementPageData).not.toHaveBeenCalled();
  });
});

function buildApp(
  adminProviderService: Record<string, ReturnType<typeof vi.fn>>,
  options?: { permissions?: string[] }
) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use((request, response, next) => {
    request.identity = {
      actorUserId: "admin-1",
      effectiveUserId: "admin-1",
      permissions: new Set(options?.permissions ?? ["admin.providers.manage"]),
      isImpersonating: false
    };
    request.session = { csrfToken: "csrf-token" } as never;
    response.render = ((_view: string, locals?: object) => response.status(200).json({ data: locals })) as never;
    next();
  });
  app.use(adminProviderRouter(adminProviderService as never));
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
