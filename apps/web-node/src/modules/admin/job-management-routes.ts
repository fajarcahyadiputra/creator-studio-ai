import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { routeParam } from "../../shared/http/route-param.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import { retryJobSchema } from "../jobs/schemas.js";
import type { AdminJobService } from "./admin-job-service.js";

export function adminJobRouter(adminJobService: AdminJobService): Router {
  const router = Router();

  router.get(
    "/admin/jobs",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const page = await adminJobService.getJobManagementPageData({
        q: typeof request.query.q === "string" ? request.query.q : undefined,
        status: typeof request.query.status === "string" && request.query.status !== "ALL" ? request.query.status : undefined,
        type: typeof request.query.type === "string" && request.query.type !== "ALL" ? request.query.type : undefined
      });
      response.render("admin/jobs", {
        title: "Admin Jobs",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.get(
    "/admin/jobs/:jobId",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const page = await adminJobService.getJobDetailPageData(routeParam(request.params.jobId, "jobId"));
      response.render("admin/job-detail", {
        title: `Admin Job ${page.job.id.slice(0, 8)}`,
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/admin/jobs/:jobId/cancel",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const job = await adminJobService.cancelJob(jobId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: job.userId,
        action: "ADMIN_JOB_CANCELED",
        resourceType: "Job",
        resourceId: job.id,
        request
      });
      response.json({ data: { message: "Job canceled successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/jobs/:jobId/retry",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    validateBody(retryJobSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { stage?: string; reason: string };
      const jobId = routeParam(request.params.jobId, "jobId");
      const retried = await adminJobService.retryJob(jobId, body.reason, body.stage);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: retried.userId,
        action: "ADMIN_JOB_RETRY_REQUESTED",
        resourceType: "Job",
        resourceId: jobId,
        reason: body.reason,
        metadata: { requested_stage: body.stage, workflow_id: retried.workflowId },
        request
      });
      response.json({ data: { message: "Retry workflow requested successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/jobs/:jobId/duplicate",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const duplicated = await adminJobService.duplicateJob(jobId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: duplicated.userId as string,
        action: "ADMIN_JOB_DUPLICATED",
        resourceType: "Job",
        resourceId: duplicated.id as string,
        metadata: { source_job_id: jobId },
        request
      });
      response.json({ data: { message: "Job duplicated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/jobs/:jobId/render-queue",
    requireAuth,
    requirePermission("admin.jobs.manage"),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const result = await adminJobService.queueRender(jobId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        action: "ADMIN_JOB_RENDER_QUEUE_REQUESTED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: {
          selected_candidate_count: result.selectedCount,
          created_clip_output_count: result.createdCount,
          started_render_workflow_count: result.startedWorkflowCount
        },
        request
      });
      response.json({ data: { message: "Render queue requested successfully." } });
    })
  );

  return router;
}
