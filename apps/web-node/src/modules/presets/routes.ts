import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { routeParam } from "../../shared/http/route-param.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth } from "../auth/identity-middleware.js";
import type { PresetService } from "./preset-service.js";
import { brandKitSchema, presetSchema } from "./schemas.js";

export function presetsRouter(presetService: PresetService): Router {
  const router = Router();

  router.get(
    "/app/presets",
    requireAuth,
    asyncHandler(async (request, response) => {
      const page = await presetService.getPresetsPageData(request.identity!.effectiveUserId);
      response.render("app/presets", {
        title: "Presets",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/presets",
    requireAuth,
    validateBody(presetSchema),
    asyncHandler(async (request, response) => {
      const preset = await presetService.createPreset(request.identity!.effectiveUserId, request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_PRESET_CREATED",
        resourceType: "Preset",
        resourceId: preset.id,
        request
      });
      response.status(201).json({ data: { message: "Preset created successfully." } });
    })
  );

  router.post(
    "/api/v1/presets/:presetId/update",
    requireAuth,
    validateBody(presetSchema),
    asyncHandler(async (request, response) => {
      const preset = await presetService.updatePreset(
        request.identity!.effectiveUserId,
        routeParam(request.params.presetId, "presetId"),
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_PRESET_UPDATED",
        resourceType: "Preset",
        resourceId: preset.id,
        request
      });
      response.json({ data: { message: "Preset updated successfully." } });
    })
  );

  router.post(
    "/api/v1/brand-kits",
    requireAuth,
    validateBody(brandKitSchema),
    asyncHandler(async (request, response) => {
      const brandKit = await presetService.createBrandKit(request.identity!.effectiveUserId, request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_BRAND_KIT_CREATED",
        resourceType: "BrandKit",
        resourceId: brandKit.id,
        request
      });
      response.status(201).json({ data: { message: "Brand kit created successfully." } });
    })
  );

  router.post(
    "/api/v1/brand-kits/:brandKitId/update",
    requireAuth,
    validateBody(brandKitSchema),
    asyncHandler(async (request, response) => {
      const brandKit = await presetService.updateBrandKit(
        request.identity!.effectiveUserId,
        routeParam(request.params.brandKitId, "brandKitId"),
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_BRAND_KIT_UPDATED",
        resourceType: "BrandKit",
        resourceId: brandKit.id,
        request
      });
      response.json({ data: { message: "Brand kit updated successfully." } });
    })
  );

  return router;
}

