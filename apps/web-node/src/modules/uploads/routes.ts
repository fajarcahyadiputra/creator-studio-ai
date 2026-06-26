import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { routeParam } from "../../shared/http/route-param.js";
import { requireAuth } from "../auth/identity-middleware.js";
import { assertIdempotencyKey } from "../jobs/job-service.js";
import { completeUploadSchema, createUploadSchema } from "./schemas.js";
import { UploadService } from "./upload-service.js";

export function uploadsRouter(service: UploadService): Router {
  const router = Router();

  router.post(
    "/api/v1/uploads",
    requireAuth,
    validateBody(createUploadSchema),
    asyncHandler(async (request, response) => {
      assertIdempotencyKey(request.get("idempotency-key"));
      const body = request.validatedBody as {
        file_name: string;
        content_type: string;
        size_bytes: number;
        project_id?: string;
      };
      const upload = await service.create({
        userId: request.identity!.effectiveUserId,
        fileName: body.file_name,
        contentType: body.content_type,
        sizeBytes: body.size_bytes,
        projectId: body.project_id
      });
      response.status(201).json({ data: upload });
    })
  );

  router.post(
    "/api/v1/uploads/:uploadId/complete",
    requireAuth,
    validateBody(completeUploadSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as {
        parts: Array<{ part_number: number; etag: string }>;
        checksum_sha256?: string;
      };
      const asset = await service.complete({
        userId: request.identity!.effectiveUserId,
        uploadId: routeParam(request.params.uploadId, "uploadId"),
        parts: body.parts,
        checksumSha256: body.checksum_sha256
      });
      response.json({ data: { ...asset, sizeBytes: asset.sizeBytes?.toString(), durationMs: asset.durationMs?.toString() } });
    })
  );

  router.post(
    "/api/v1/uploads/:uploadId/abort",
    requireAuth,
    asyncHandler(async (request, response) => {
      await service.abort(request.identity!.effectiveUserId, routeParam(request.params.uploadId, "uploadId"));
      response.status(204).end();
    })
  );

  return router;
}
