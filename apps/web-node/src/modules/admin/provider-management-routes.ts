import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import type { AdminProviderService } from "./admin-provider-service.js";
import {
  adminCreateCredentialSchema,
  adminCreateModelSchema,
  adminCreateProviderSchema,
  adminUpdateCredentialSchema,
  adminUpdateModelSchema,
  adminUpdateProviderSchema
} from "./provider-management-schemas.js";

export function adminProviderRouter(adminProviderService: AdminProviderService): Router {
  const router = Router();

  router.get(
    "/admin/providers",
    requireAuth,
    requirePermission("admin.providers.manage"),
    asyncHandler(async (request, response) => {
      const page = await adminProviderService.getProviderManagementPageData();
      response.render("admin/providers", {
        title: "Admin Providers",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/admin/providers",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminCreateProviderSchema),
    asyncHandler(async (request, response) => {
      const provider = await adminProviderService.createProvider(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_PROVIDER_CREATED",
        resourceType: "AiProvider",
        resourceId: provider.id,
        afterData: {
          code: provider.code,
          display_name: provider.displayName,
          enabled: provider.enabled,
          health_status: provider.healthStatus
        },
        request
      });
      response.status(201).json({ data: { message: "Provider created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/providers/:providerId/update",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminUpdateProviderSchema),
    asyncHandler(async (request, response) => {
      const provider = await adminProviderService.updateProvider(
        String(request.params.providerId),
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_PROVIDER_UPDATED",
        resourceType: "AiProvider",
        resourceId: provider.id,
        afterData: {
          code: provider.code,
          display_name: provider.displayName,
          enabled: provider.enabled,
          health_status: provider.healthStatus
        },
        request
      });
      response.json({ data: { message: "Provider updated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/credentials",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminCreateCredentialSchema),
    asyncHandler(async (request, response) => {
      const credential = await adminProviderService.createCredential(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_PLATFORM_CREDENTIAL_CREATED",
        resourceType: "EncryptedCredential",
        resourceId: credential.id,
        afterData: {
          provider_id: credential.providerId,
          label: credential.label,
          status: credential.status,
          masked_hint: credential.maskedHint
        },
        request
      });
      response.status(201).json({ data: { message: "Platform credential created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/credentials/:credentialId/update",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminUpdateCredentialSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as {
        rotate_payload_json?: Record<string, unknown>;
      };
      const credential = await adminProviderService.updateCredential(String(request.params.credentialId), request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: body.rotate_payload_json ? "ADMIN_PLATFORM_CREDENTIAL_ROTATED" : "ADMIN_PLATFORM_CREDENTIAL_UPDATED",
        resourceType: "EncryptedCredential",
        resourceId: credential.id,
        afterData: {
          provider_id: credential.providerId,
          label: credential.label,
          status: credential.status,
          masked_hint: credential.maskedHint
        },
        request
      });
      response.json({ data: { message: body.rotate_payload_json ? "Credential rotated successfully." : "Credential updated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/models",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminCreateModelSchema),
    asyncHandler(async (request, response) => {
      const model = await adminProviderService.createModel(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_MODEL_CREATED",
        resourceType: "AiModel",
        resourceId: model.id,
        afterData: {
          provider_id: model.providerId,
          identifier: model.identifier,
          display_name: model.displayName,
          enabled: model.enabled
        },
        request
      });
      response.status(201).json({ data: { message: "Model created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/models/:modelId/update",
    requireAuth,
    requirePermission("admin.providers.manage"),
    validateBody(adminUpdateModelSchema),
    asyncHandler(async (request, response) => {
      const model = await adminProviderService.updateModel(String(request.params.modelId), request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_MODEL_UPDATED",
        resourceType: "AiModel",
        resourceId: model.id,
        afterData: {
          provider_id: model.providerId,
          identifier: model.identifier,
          display_name: model.displayName,
          enabled: model.enabled
        },
        request
      });
      response.json({ data: { message: "Model updated successfully." } });
    })
  );

  return router;
}
