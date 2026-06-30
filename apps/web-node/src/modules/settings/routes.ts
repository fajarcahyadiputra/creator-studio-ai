import { Router } from "express";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { routeParam } from "../../shared/http/route-param.js";
import { validateBody } from "../../shared/http/validate.js";
import { writeAudit } from "../audit/audit-service.js";
import { requireAuth } from "../auth/identity-middleware.js";
import {
  aiPreferenceSettingsSchema,
  changePasswordSchema,
  notificationSettingsSchema,
  profileSettingsSchema
} from "./schemas.js";
import type { SettingsService } from "./settings-service.js";

export function settingsRouter(settingsService: SettingsService): Router {
  const router = Router();

  router.get(
    "/app/settings",
    requireAuth,
    asyncHandler(async (request, response) => {
      const page = await settingsService.getSettingsPageData(
        request.identity!.effectiveUserId,
        request.session.trackedSessionId
      );
      response.render("app/settings", {
        title: "Settings",
        ...page,
        csrfToken: request.session.csrfToken
      });
    })
  );

  router.post(
    "/api/v1/settings/profile",
    requireAuth,
    validateBody(profileSettingsSchema),
    asyncHandler(async (request, response) => {
      await settingsService.updateProfile(request.identity!.effectiveUserId, request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_PROFILE_UPDATED",
        resourceType: "UserSetting",
        resourceId: request.identity!.effectiveUserId,
        request
      });
      response.json({ data: { message: "Profile updated successfully." } });
    })
  );

  router.post(
    "/api/v1/settings/ai-preference",
    requireAuth,
    validateBody(aiPreferenceSettingsSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { credential_mode: "PLATFORM" | "USER_OWNED" };
      await settingsService.updateAiPreference(request.identity!.effectiveUserId, request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action:
          body.credential_mode === "USER_OWNED"
            ? "USER_AI_PREFERENCE_UPDATED_OWNED"
            : "USER_AI_PREFERENCE_UPDATED_PLATFORM",
        resourceType: "UserAiPreference",
        resourceId: request.identity!.effectiveUserId,
        request
      });
      response.json({ data: { message: "AI preference updated successfully." } });
    })
  );

  router.post(
    "/api/v1/settings/notifications",
    requireAuth,
    validateBody(notificationSettingsSchema),
    asyncHandler(async (request, response) => {
      await settingsService.updateNotifications(request.identity!.effectiveUserId, request.validatedBody as never);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_NOTIFICATION_SETTINGS_UPDATED",
        resourceType: "UserSetting",
        resourceId: request.identity!.effectiveUserId,
        request
      });
      response.json({ data: { message: "Notification preferences updated successfully." } });
    })
  );

  router.post(
    "/api/v1/settings/password",
    requireAuth,
    validateBody(changePasswordSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { current_password: string; new_password: string };
      await settingsService.changePassword(
        request.identity!.effectiveUserId,
        request.session.trackedSessionId,
        body.current_password,
        body.new_password
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_PASSWORD_CHANGED",
        resourceType: "User",
        resourceId: request.identity!.effectiveUserId,
        request
      });
      response.json({ data: { message: "Password updated successfully. Other sessions were revoked." } });
    })
  );

  router.post(
    "/api/v1/settings/sessions/:sessionId/revoke",
    requireAuth,
    asyncHandler(async (request, response) => {
      const sessionId = routeParam(request.params.sessionId, "sessionId");
      await settingsService.revokeSession(
        request.identity!.effectiveUserId,
        sessionId,
        request.session.trackedSessionId
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "USER_SESSION_REVOKED",
        resourceType: "Session",
        resourceId: sessionId,
        request
      });
      response.json({ data: { message: "Session revoked successfully." } });
    })
  );

  return router;
}

