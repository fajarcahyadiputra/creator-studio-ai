import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import type { AdminUserService } from "./admin-user-service.js";
import { adminCreateUserSchema, adminUpdateUserSchema } from "./user-management-schemas.js";

export function adminUserRouter(adminUserService: AdminUserService): Router {
  const router = Router();

  router.get(
    "/admin/users",
    requireAuth,
    requirePermission("admin.users.read"),
    asyncHandler(async (request, response) => {
      const page = await adminUserService.getUserManagementPageData({
        q: typeof request.query.q === "string" ? request.query.q : undefined,
        status: typeof request.query.status === "string" ? request.query.status : undefined
      });

      response.render("admin/users", {
        title: "Admin Users",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/admin/users",
    requireAuth,
    requirePermission("admin.users.write"),
    validateBody(adminCreateUserSchema),
    asyncHandler(async (request, response) => {
      const user = await adminUserService.createUser(request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: user.id,
        action: "ADMIN_USER_CREATED",
        resourceType: "User",
        resourceId: user.id,
        afterData: {
          email: user.email,
          status: user.status,
          roles: user.roles.map((assignment) => assignment.role.code),
          plan: user.plan?.code ?? null
        },
        request
      });
      response.status(201).json({ data: { message: "User created successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/users/:userId/update",
    requireAuth,
    requirePermission("admin.users.write"),
    validateBody(adminUpdateUserSchema),
    asyncHandler(async (request, response) => {
      const user = await adminUserService.updateUser(
        String(request.params.userId),
        request.identity!.actorUserId,
        request.validatedBody as never
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: user.id,
        action: "ADMIN_USER_UPDATED",
        resourceType: "User",
        resourceId: user.id,
        afterData: {
          email: user.email,
          status: user.status,
          roles: user.roles.map((assignment) => assignment.role.code),
          plan: user.plan?.code ?? null
        },
        request
      });
      response.json({ data: { message: "User updated successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/users/:userId/verify-email",
    requireAuth,
    requirePermission("admin.users.write"),
    asyncHandler(async (request, response) => {
      const user = await adminUserService.verifyEmail(String(request.params.userId));
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: user.id,
        action: "ADMIN_USER_EMAIL_VERIFIED",
        resourceType: "User",
        resourceId: user.id,
        request
      });
      response.json({ data: { message: "Email verified successfully." } });
    })
  );

  router.post(
    "/api/v1/admin/users/:userId/reset-password",
    requireAuth,
    requirePermission("admin.users.write"),
    asyncHandler(async (request, response) => {
      const user = await adminUserService.sendPasswordReset(String(request.params.userId));
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: user.id,
        action: "ADMIN_USER_PASSWORD_RESET_REQUESTED",
        resourceType: "User",
        resourceId: user.id,
        request
      });
      response.json({ data: { message: "Password reset link queued." } });
    })
  );

  router.post(
    "/api/v1/admin/users/:userId/revoke-sessions",
    requireAuth,
    requirePermission("admin.users.write"),
    asyncHandler(async (request, response) => {
      const userId = String(request.params.userId);
      const result = await adminUserService.revokeSessions(userId, request.identity!.actorUserId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: userId,
        action: "ADMIN_USER_SESSIONS_REVOKED",
        resourceType: "User",
        resourceId: userId,
        metadata: { revoked_sessions: result.count },
        request
      });
      response.json({ data: { message: `Revoked ${result.count} active session(s).` } });
    })
  );

  router.post(
    "/api/v1/admin/users/:userId/delete",
    requireAuth,
    requirePermission("admin.users.write"),
    asyncHandler(async (request, response) => {
      const userId = String(request.params.userId);
      await adminUserService.softDeleteUser(userId, request.identity!.actorUserId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: userId,
        action: "ADMIN_USER_SOFT_DELETED",
        resourceType: "User",
        resourceId: userId,
        request
      });
      response.json({ data: { message: "User deleted successfully." } });
    })
  );

  return router;
}
