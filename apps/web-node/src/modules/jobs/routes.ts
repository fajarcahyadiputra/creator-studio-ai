import { Router } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { routeParam } from "../../shared/http/route-param.js";
import { requireAuth } from "../auth/identity-middleware.js";
import { autoClipJobSchema, retryJobSchema } from "./schemas.js";
import { assertIdempotencyKey, JobService, serializeJob } from "./job-service.js";
import type { JobEventBus } from "./job-event-bus.js";

function serializeEvent(event: {
  id: string;
  sequence: bigint;
  stage: string | null;
  stageProgress: number | null;
  overallProgress: number | null;
  eventType: string;
  message: string;
  userMessage: string | null;
  metadata: unknown;
  occurredAt: Date;
}) {
  return {
    id: event.id,
    sequence: event.sequence.toString(),
    stage: event.stage,
    stage_progress: event.stageProgress,
    overall_progress: event.overallProgress,
    event_type: event.eventType,
    message: event.message,
    user_message: event.userMessage,
    metadata: event.metadata,
    occurred_at: event.occurredAt.toISOString()
  };
}

export function jobsRouter(jobService: JobService, eventBus: JobEventBus): Router {
  const router = Router();

  router.post(
    "/api/v1/auto-clipping/jobs",
    requireAuth,
    validateBody(autoClipJobSchema),
    asyncHandler(async (request, response) => {
      const job = await jobService.createAutoClippingJob({
        userId: request.identity!.effectiveUserId,
        idempotencyKey: assertIdempotencyKey(request.get("idempotency-key")),
        input: request.validatedBody as never
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.post(
    "/api/v1/auto-clipping/jobs/:jobId/duplicate",
    requireAuth,
    asyncHandler(async (request, response) => {
      const job = await jobService.duplicate(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        assertIdempotencyKey(request.get("idempotency-key"))
      );
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.get(
    "/api/v1/jobs",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobs = await jobService.list(request.identity!.effectiveUserId);
      response.json({ data: jobs.map(serializeJob) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId",
    requireAuth,
    asyncHandler(async (request, response) => {
      const job = await jobService.get(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      response.json({ data: serializeJob(job) });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/cancel",
    requireAuth,
    asyncHandler(async (request, response) => {
      await jobService.cancel(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      response.status(202).json({ data: { status: "CANCEL_REQUESTED" } });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/retry",
    requireAuth,
    validateBody(retryJobSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { stage?: string; reason: string };
      const job = await jobService.retry({
        userId: request.identity!.effectiveUserId,
        jobId: routeParam(request.params.jobId, "jobId"),
        reason: body.reason,
        stage: body.stage
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/events",
    requireAuth,
    asyncHandler(async (request, response) => {
      await jobService.get(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      const after = BigInt(String(request.query.after ?? "0"));
      const events = await prisma.jobEvent.findMany({
        where: { jobId: routeParam(request.params.jobId, "jobId"), sequence: { gt: after } },
        orderBy: { sequence: "asc" },
        take: 500
      });
      response.json({ data: events.map(serializeEvent) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/events/stream",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      await jobService.get(request.identity!.effectiveUserId, jobId);

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      let cursor = BigInt(String(request.query.after ?? "0"));
      let fetching = false;

      const flush = async () => {
        if (fetching) return;
        fetching = true;
        try {
          const events = await prisma.jobEvent.findMany({
            where: { jobId, sequence: { gt: cursor } },
            orderBy: { sequence: "asc" },
            take: 500
          });
          for (const event of events) {
            cursor = event.sequence;
            response.write(`id: ${event.sequence.toString()}\n`);
            response.write(`event: ${event.eventType}\n`);
            response.write(`data: ${JSON.stringify(serializeEvent(event))}\n\n`);
          }
        } finally {
          fetching = false;
        }
      };

      await flush();
      const unsubscribe = eventBus.on(jobId, () => void flush());
      const keepAlive = setInterval(() => {
        response.write(": keep-alive\n\n");
        void flush();
      }, 15_000);

      request.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
        response.end();
      });
    })
  );

  return router;
}
