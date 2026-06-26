import { Router } from "express";
import passport from "passport";
import type { User } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { AppError } from "../../shared/errors/app-error.js";
import { writeAudit } from "../audit/audit-service.js";
import { AuthService } from "./auth-service.js";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema
} from "./schemas.js";
import { destroyLoginSession, establishLoginSession } from "./session-auth.js";

export function authRouter(authService: AuthService): Router {
  const router = Router();

  router.get("/login", (request, response) => {
    response.render("auth/login", { title: "Login", csrfToken: request.session.csrfToken });
  });
  router.get("/register", (request, response) => {
    response.render("auth/register", { title: "Register", csrfToken: request.session.csrfToken });
  });
  router.get("/forgot-password", (request, response) => {
    response.render("auth/forgot-password", { title: "Forgot password", csrfToken: request.session.csrfToken });
  });
  router.get("/reset-password", (request, response) => {
    response.render("auth/reset-password", {
      title: "Reset password",
      csrfToken: request.session.csrfToken,
      token: String(request.query.token ?? "")
    });
  });

  router.get("/api/v1/auth/csrf", (request, response) => {
    response.json({ data: { csrf_token: request.session.csrfToken } });
  });

  router.post(
    "/api/v1/auth/register",
    validateBody(registerSchema),
    asyncHandler(async (request, response) => {
      const user = await authService.register(request.validatedBody as never);
      await writeAudit({
        actorUserId: user.id,
        targetUserId: user.id,
        action: "AUTH_REGISTER",
        resourceType: "User",
        resourceId: user.id,
        request
      });
      response.status(201).json({ data: { user, redirect: "/login?registered=1" } });
    })
  );

  router.post(
    "/api/v1/auth/login",
    validateBody(loginSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { email: string; password: string };
      const user = await authService.login(body.email, body.password);
      await establishLoginSession(request, user.id);
      await writeAudit({
        actorUserId: user.id,
        targetUserId: user.id,
        action: "AUTH_LOGIN",
        resourceType: "Session",
        resourceId: request.session.trackedSessionId,
        request
      });
      const isAdmin = user.roles.some((assignment) => assignment.role.code === "SUPERADMIN");
      response.json({ data: { redirect: isAdmin ? "/admin/dashboard" : "/app/dashboard" } });
    })
  );

  router.post(
    "/api/v1/auth/logout",
    asyncHandler(async (request, response) => {
      const actorUserId = request.session.actorUserId;
      await destroyLoginSession(request);
      if (actorUserId) {
        await writeAudit({ actorUserId, action: "AUTH_LOGOUT", resourceType: "Session", request });
      }
      response.json({ data: { redirect: "/login" } });
    })
  );

  router.post(
    "/api/v1/auth/forgot-password",
    validateBody(forgotPasswordSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { email: string };
      await authService.requestPasswordReset(body.email);
      response.json({
        data: { message: "If the account exists, a password reset email has been sent." }
      });
    })
  );

  router.post(
    "/api/v1/auth/reset-password",
    validateBody(resetPasswordSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { token: string; password: string };
      await authService.resetPassword(body.token, body.password);
      response.json({ data: { redirect: "/login?password_reset=1" } });
    })
  );

  router.get(
    "/api/v1/auth/verify-email",
    asyncHandler(async (request, response) => {
      const token = String(request.query.token ?? "");
      if (!token) throw new AppError({ code: "TOKEN_REQUIRED", message: "Verification token is required.", statusCode: 400 });
      await authService.verifyEmail(token);
      response.redirect("/login?verified=1");
    })
  );

  router.get("/api/v1/auth/google", (request, response, next) => {
    if (!env.GOOGLE_CLIENT_ID) {
      next(new AppError({ code: "GOOGLE_OAUTH_DISABLED", message: "Google login is not configured.", statusCode: 503 }));
      return;
    }
    passport.authenticate("google", { scope: ["profile", "email"], session: false })(request, response, next);
  });

  router.get(
    "/api/v1/auth/google/callback",
    passport.authenticate("google", { session: false, failureRedirect: "/login?oauth_error=1" }),
    asyncHandler(async (request, response) => {
      const user = request.user as User;
      await establishLoginSession(request, user.id);
      await writeAudit({
        actorUserId: user.id,
        targetUserId: user.id,
        action: "AUTH_LOGIN_GOOGLE",
        resourceType: "Session",
        resourceId: request.session.trackedSessionId,
        request
      });
      response.redirect("/app/dashboard");
    })
  );

  router.get("/api/v1/auth/me", (request, response) => {
    if (!request.identity) {
      response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication is required.", request_id: request.requestId, details: {} } });
      return;
    }
    response.json({
      data: {
        actor_user_id: request.identity.actorUserId,
        effective_user_id: request.identity.effectiveUserId,
        is_impersonating: request.identity.isImpersonating,
        permissions: [...request.identity.permissions]
      }
    });
  });

  return router;
}
