import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import { routeParam } from "../../shared/http/route-param.js";
import type { JobProjectionService } from "../jobs/job-projection-service.js";
import { requireInternalService } from "./service-auth.js";

const progressSchema = z.object({
  stage: z.string().min(1).max(100),
  stage_progress: z.number().int().min(0).max(100),
  overall_progress: z.number().int().min(0).max(100),
  event_type: z.string().min(1).max(100).default("job.progress"),
  message: z.string().min(1).max(2000),
  user_message: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  status: z.enum([
    "DRAFT", "UPLOADING", "QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED",
    "CANCEL_REQUESTED", "CANCELED", "FAILED", "COMPLETED", "PARTIALLY_COMPLETED",
    "NEEDS_REVIEW"
  ]).optional(),
  occurred_at: z.iso.datetime().optional()
});

const clipOutputResultSchema = z.object({
  quality_status: z.enum(["PENDING", "PASSED", "NEEDS_REVIEW", "FAILED"]),
  preview_object_key: z.string().trim().min(1).max(1000).optional(),
  final_object_key: z.string().trim().min(1).max(1000).optional(),
  metadata_object_key: z.string().trim().min(1).max(1000).optional(),
  thumbnail_object_key: z.string().trim().min(1).max(1000).optional(),
  quality_report: z.record(z.string(), z.unknown()).default({}),
  duration_ms: z.string().regex(/^\d+$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

export function internalRouter(projection: JobProjectionService): Router {
  const router = Router();
  router.get("/internal/v1/health", requireInternalService, (_request, response) => {
    response.json({ data: { status: "ok" } });
  });
  router.post(
    "/internal/v1/jobs/:jobId/events",
    requireInternalService,
    validateBody(progressSchema),
    asyncHandler(async (request, response) => {
      const event = await projection.record(routeParam(request.params.jobId, "jobId"), request.validatedBody as never);
      response.status(201).json({ data: { id: event.id, sequence: event.sequence.toString() } });
    })
  );
  router.get(
    "/internal/v1/clip-outputs/:clipOutputId/render-context",
    requireInternalService,
    asyncHandler(async (request, response) => {
      const clipOutputId = routeParam(request.params.clipOutputId, "clipOutputId");
      const clipOutput = await prisma.clipOutput.findFirst({
        where: { id: clipOutputId, deletedAt: null },
        include: {
          candidate: true,
          job: true
        }
      });
      if (!clipOutput) throw new NotFoundError("Clip output");

      response.json({
        data: {
          clip_output_id: clipOutput.id,
          job_id: clipOutput.jobId,
          candidate_id: clipOutput.candidateId,
          version: clipOutput.version,
          quality_status: clipOutput.qualityStatus,
          render_settings: clipOutput.renderSettings,
          candidate: {
            candidate_id: clipOutput.candidate.candidateExternalId,
            title: clipOutput.candidate.title,
            summary: clipOutput.candidate.summary,
            hook_text: clipOutput.candidate.hookText,
            start_ms: clipOutput.candidate.startMs.toString(),
            end_ms: clipOutput.candidate.endMs.toString(),
            duration_ms: clipOutput.candidate.durationMs.toString()
          },
          output_targets: {
            preview_object_key: clipOutput.previewObjectKey,
            final_object_key: clipOutput.finalObjectKey,
            metadata_object_key: clipOutput.metadataObjectKey,
            thumbnail_object_key: clipOutput.thumbnailObjectKey
          }
        }
      });
    })
  );
  router.post(
    "/internal/v1/clip-outputs/:clipOutputId/result",
    requireInternalService,
    validateBody(clipOutputResultSchema),
    asyncHandler(async (request, response) => {
      const clipOutputId = routeParam(request.params.clipOutputId, "clipOutputId");
      const body = request.validatedBody as {
        quality_status: "PENDING" | "PASSED" | "NEEDS_REVIEW" | "FAILED";
        preview_object_key?: string;
        final_object_key?: string;
        metadata_object_key?: string;
        thumbnail_object_key?: string;
        quality_report: Record<string, unknown>;
        duration_ms?: string;
        width?: number;
        height?: number;
      };

      const updated = await prisma.clipOutput.update({
        where: { id: clipOutputId },
        data: {
          qualityStatus: body.quality_status,
          previewObjectKey: body.preview_object_key,
          finalObjectKey: body.final_object_key,
          metadataObjectKey: body.metadata_object_key,
          thumbnailObjectKey: body.thumbnail_object_key,
          qualityReport: body.quality_report as never,
          durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
          width: body.width,
          height: body.height
        }
      });

      response.json({
        data: {
          clip_output_id: updated.id,
          quality_status: updated.qualityStatus
        }
      });
    })
  );
  return router;
}
