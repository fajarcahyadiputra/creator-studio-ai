import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { routeParam } from "../../shared/http/route-param.js";
import { ForbiddenError } from "../../shared/errors/app-error.js";
import { requireAuth } from "../auth/identity-middleware.js";

export function mediaRouter(): Router {
  const router = Router();

  router.get(
    "/app/media",
    requireAuth,
    asyncHandler(async (request, response) => {
      if (request.identity!.permissions.has("admin.jobs.manage")) {
        response.redirect("/admin/media");
        return;
      }
      throw new ForbiddenError("Media library is now available from the admin console.");
    })
  );

  router.get(
    "/app/media/:mediaAssetId/download",
    requireAuth,
    asyncHandler(async (request, response) => {
      if (request.identity!.permissions.has("admin.jobs.manage")) {
        const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
        response.redirect(`/admin/media/${mediaAssetId}/download`);
        return;
      }
      throw new ForbiddenError("Media downloads are now available from the admin console.");
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/rename",
    requireAuth,
    asyncHandler(async (request, response) => {
      void routeParam(request.params.mediaAssetId, "mediaAssetId");
      throw new ForbiddenError("Media management is now handled from the admin console.");
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/delete",
    requireAuth,
    asyncHandler(async (request, response) => {
      void routeParam(request.params.mediaAssetId, "mediaAssetId");
      throw new ForbiddenError("Media management is now handled from the admin console.");
    })
  );

  router.post(
    "/api/v1/media/:mediaAssetId/restore",
    requireAuth,
    asyncHandler(async (request, response) => {
      void routeParam(request.params.mediaAssetId, "mediaAssetId");
      throw new ForbiddenError("Media management is now handled from the admin console.");
    })
  );

  return router;
}
