import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import type { AdminObservabilityService } from "./admin-observability-service.js";

export function adminObservabilityRouter(adminObservabilityService: AdminObservabilityService): Router {
  const router = Router();

  router.get(
    "/admin/audit-logs",
    requireAuth,
    requirePermission("admin.audit.read"),
    asyncHandler(async (request, response) => {
      const page = await adminObservabilityService.getAuditLogPageData({
        q: typeof request.query.q === "string" ? request.query.q : undefined,
        action: typeof request.query.action === "string" && request.query.action !== "ALL" ? request.query.action : undefined
      });
      response.render("admin/audit-logs", {
        title: "Admin Audit Logs",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.get(
    "/admin/workers",
    requireAuth,
    requirePermission("admin.dashboard.view"),
    asyncHandler(async (request, response) => {
      const page = await adminObservabilityService.getWorkerHealthPageData();
      response.render("admin/workers", {
        title: "Admin Worker Health",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  return router;
}

