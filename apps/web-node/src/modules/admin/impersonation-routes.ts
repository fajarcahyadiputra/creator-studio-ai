import { Router } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import { impersonationSchema } from "../auth/schemas.js";
import { rotateAuthenticatedSession } from "../auth/session-auth.js";

export const impersonationRouter = Router();

impersonationRouter.post(
  "/api/v1/admin/impersonation/start",
  requireAuth,
  requirePermission("admin.users.impersonate"),
  validateBody(impersonationSchema),
  asyncHandler(async (request, response) => {
    const body = request.validatedBody as { target_user_id: string; reason: string };
    const target = await prisma.user.findFirst({
      where: { id: body.target_user_id, deletedAt: null, status: { not: "DISABLED" } }
    });
    if (!target) throw new NotFoundError("User");

    const audit = await writeAudit({
      actorUserId: request.identity!.actorUserId,
      targetUserId: target.id,
      action: "IMPERSONATION_STARTED",
      resourceType: "User",
      resourceId: target.id,
      reason: body.reason,
      request
    });

    await rotateAuthenticatedSession(request, {
      actorUserId: request.identity!.actorUserId,
      trackedSessionId: request.session.trackedSessionId,
      impersonation: {
        targetUserId: target.id,
        reason: body.reason,
        startedAt: new Date().toISOString(),
        auditLogId: audit.id
      }
    });
    response.json({ data: { redirect: "/app/dashboard" } });
  })
);

impersonationRouter.post(
  "/api/v1/admin/impersonation/stop",
  requireAuth,
  asyncHandler(async (request, response) => {
    const impersonation = request.session.impersonation;
    if (impersonation) {
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: impersonation.targetUserId,
        action: "IMPERSONATION_STOPPED",
        resourceType: "User",
        resourceId: impersonation.targetUserId,
        reason: impersonation.reason,
        metadata: { started_at: impersonation.startedAt, start_audit_log_id: impersonation.auditLogId },
        request
      });
    }
    await rotateAuthenticatedSession(request, {
      actorUserId: request.identity!.actorUserId,
      trackedSessionId: request.session.trackedSessionId
    });
    response.json({ data: { redirect: "/admin/dashboard" } });
  })
);
