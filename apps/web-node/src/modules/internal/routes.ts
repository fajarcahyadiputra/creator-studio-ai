import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
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
  return router;
}
