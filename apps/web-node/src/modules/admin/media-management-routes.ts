import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { routeParam } from "../../shared/http/route-param.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import type { AdminMediaService } from "./admin-media-service.js";

export function adminMediaRouter(adminMediaService: AdminMediaService): Router {
  const router = Router();

  router.get(
    "/admin/media",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const page = await adminMediaService.getMediaManagementPageData({
        q: typeof request.query.q === "string" ? request.query.q : undefined,
        type: typeof request.query.type === "string" ? request.query.type : undefined,
        status: typeof request.query.status === "string" ? request.query.status : undefined,
        kind: typeof request.query.kind === "string" ? request.query.kind : undefined,
        family: typeof request.query.family === "string" ? request.query.family : undefined,
        userId: typeof request.query.user_id === "string" ? request.query.user_id : undefined,
        view: typeof request.query.view === "string" ? request.query.view : undefined,
        deleted: typeof request.query.deleted === "string" ? request.query.deleted : undefined
      });
      response.render("admin/media", {
        title: "Admin Media",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.get(
    "/admin/media/:mediaAssetId/download",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const url = await adminMediaService.createAdminDownloadUrl(mediaAssetId);
      response.redirect(url);
    })
  );

  router.post(
    "/api/v1/admin/media/:mediaAssetId/delete",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const deleted = await adminMediaService.hardDelete(mediaAssetId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: deleted.userId,
        action: "ADMIN_MEDIA_ASSET_HARD_DELETED",
        resourceType: "MediaAsset",
        resourceId: deleted.id,
        metadata: {
          object_key: deleted.objectKey,
          deleted_object_count: deleted.deletedObjectCount
        },
        request
      });
      response.json({ data: { message: "Media asset deleted permanently." } });
    })
  );

  router.post(
    "/api/v1/admin/media/bulk-delete",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const deleted = await adminMediaService.bulkHardDelete({
        q: typeof request.body.q === "string" ? request.body.q : undefined,
        type: typeof request.body.type === "string" ? request.body.type : undefined,
        status: typeof request.body.status === "string" ? request.body.status : undefined,
        kind: typeof request.body.kind === "string" ? request.body.kind : undefined,
        family: typeof request.body.family === "string" ? request.body.family : undefined,
        userId: typeof request.body.user_id === "string" ? request.body.user_id : undefined,
        view: typeof request.body.view === "string" ? request.body.view : undefined,
        deleted: typeof request.body.deleted === "string" ? request.body.deleted : undefined
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: undefined,
        action: "ADMIN_MEDIA_BULK_HARD_DELETED",
        resourceType: "MediaAsset",
        resourceId:
          deleted.filters.family !== "ALL"
            ? deleted.filters.family
            : deleted.filters.kind !== "ALL"
              ? deleted.filters.kind
              : deleted.filters.userId || "filtered-scope",
        metadata: {
          deleted_asset_count: deleted.deletedAssetCount,
          matched_asset_count: deleted.matchedAssetCount,
          filters: deleted.filters
        },
        request
      });
      response.json({
        data: {
          message: `Deleted ${deleted.deletedAssetCount} media assets permanently.`,
          deletedAssetCount: deleted.deletedAssetCount,
          matchedAssetCount: deleted.matchedAssetCount
        }
      });
    })
  );

  return router;
}
