import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import type { AdminSystemService } from "./admin-system-service.js";
import {
  adminAutoClipAnalyzerRuntimeSchema,
  adminCreateFeatureFlagSchema,
  adminCreateSystemSettingSchema,
  adminUpdateFeatureFlagSchema,
  adminUpdateSystemSettingSchema
} from "./system-management-schemas.js";

export function adminSystemRouter(adminSystemService: AdminSystemService): Router {
  const router = Router();

  router.get(
    "/admin/system",
    requireAuth,
    requirePermission("admin.system.manage"),
    asyncHandler(async (request, response) => {
      const page = await adminSystemService.getSystemManagementPageData();
      response.render("admin/system", {
        title: "Admin System Controls",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/admin/feature-flags",
    requireAuth,
    requirePermission("admin.system.manage"),
    validateBody(adminCreateFeatureFlagSchema),
    asyncHandler(async (request, response) => {
      const featureFlag = await adminSystemService.createFeatureFlag(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_FEATURE_FLAG_CREATED",
        resourceType: "FeatureFlag",
        resourceId: featureFlag.id,
        afterData: {
          key: featureFlag.key,
          enabled: featureFlag.enabled
        },
        request
      });
      response.status(201).json({ data: { message: "Feature flag created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/feature-flags/:featureFlagId/update",
    requireAuth,
    requirePermission("admin.system.manage"),
    validateBody(adminUpdateFeatureFlagSchema),
    asyncHandler(async (request, response) => {
      const featureFlag = await adminSystemService.updateFeatureFlag(
        String(request.params.featureFlagId),
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_FEATURE_FLAG_UPDATED",
        resourceType: "FeatureFlag",
        resourceId: featureFlag.id,
        afterData: {
          key: featureFlag.key,
          enabled: featureFlag.enabled,
          version: featureFlag.version
        },
        request
      });
      response.json({ data: { message: "Feature flag updated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/system-settings/auto-clip-analyzer-runtime",
    requireAuth,
    requirePermission("admin.system.manage"),
    validateBody(adminAutoClipAnalyzerRuntimeSchema),
    asyncHandler(async (request, response) => {
      const systemSetting = await adminSystemService.upsertAutoClipAnalyzerRuntime(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_SYSTEM_SETTING_UPDATED",
        resourceType: "SystemSetting",
        resourceId: systemSetting.id,
        afterData: {
          key: systemSetting.key,
          is_secret: systemSetting.isSecret,
          version: systemSetting.version
        },
        request
      });
      response.json({ data: { message: "Auto-clipping analyzer runtime updated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/system-settings",
    requireAuth,
    requirePermission("admin.system.manage"),
    validateBody(adminCreateSystemSettingSchema),
    asyncHandler(async (request, response) => {
      const systemSetting = await adminSystemService.createSystemSetting(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_SYSTEM_SETTING_CREATED",
        resourceType: "SystemSetting",
        resourceId: systemSetting.id,
        afterData: {
          key: systemSetting.key,
          is_secret: systemSetting.isSecret
        },
        request
      });
      response.status(201).json({ data: { message: "System setting created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/system-settings/:systemSettingId/update",
    requireAuth,
    requirePermission("admin.system.manage"),
    validateBody(adminUpdateSystemSettingSchema),
    asyncHandler(async (request, response) => {
      const systemSetting = await adminSystemService.updateSystemSetting(
        String(request.params.systemSettingId),
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_SYSTEM_SETTING_UPDATED",
        resourceType: "SystemSetting",
        resourceId: systemSetting.id,
        afterData: {
          key: systemSetting.key,
          is_secret: systemSetting.isSecret,
          version: systemSetting.version
        },
        request
      });
      response.json({ data: { message: "System setting updated successfully." } });
    })
  );

  return router;
}
