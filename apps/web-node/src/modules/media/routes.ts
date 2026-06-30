import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { routeParam } from "../../shared/http/route-param.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth } from "../auth/identity-middleware.js";
import type { MediaService } from "./media-service.js";
import { mediaRenameSchema } from "./schemas.js";

export function mediaRouter(mediaService: MediaService): Router {
  const router = Router();

  router.get(
    "/app/media",
    requireAuth,
    asyncHandler(async (request, response) => {
      const page = await mediaService.getMediaLibraryPageData(request.identity!.effectiveUserId, {
        q: typeof request.query.q === "string" ? request.query.q : undefined,
        type: typeof request.query.type === "string" ? request.query.type : undefined,
        status: typeof request.query.status === "string" ? request.query.status : undefined,
        view: typeof request.query.view === "string" ? request.query.view : undefined,
        deleted: typeof request.query.deleted === "string" ? request.query.deleted : undefined
      });
      response.render("app/media", {
        title: "Media Library",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.get(
    "/app/media/:mediaAssetId/download",
    requireAuth,
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const url = await mediaService.createDownloadUrl(request.identity!.effectiveUserId, mediaAssetId);
      response.redirect(url);
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/rename",
    requireAuth,
    validateBody(mediaRenameSchema),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const body = request.validatedBody as { display_name: string };
      const asset = await mediaService.rename(request.identity!.effectiveUserId, mediaAssetId, body.display_name);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "MEDIA_ASSET_RENAMED",
        resourceType: "MediaAsset",
        resourceId: asset.id,
        metadata: { display_name: asset.displayName },
        request
      });
      response.json({ data: { message: "Media metadata updated successfully." } });
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/delete",
    requireAuth,
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const asset = await mediaService.softDelete(request.identity!.effectiveUserId, mediaAssetId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "MEDIA_ASSET_SOFT_DELETED",
        resourceType: "MediaAsset",
        resourceId: asset.id,
        request
      });
      response.json({ data: { message: "Media asset moved to deleted state." } });
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/restore",
    requireAuth,
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const asset = await mediaService.restore(request.identity!.effectiveUserId, mediaAssetId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "MEDIA_ASSET_RESTORED",
        resourceType: "MediaAsset",
        resourceId: asset.id,
        request
      });
      response.json({ data: { message: "Media asset restored successfully." } });
    })
  );

  return router;
}

