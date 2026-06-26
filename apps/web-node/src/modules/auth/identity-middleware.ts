import type { RequestHandler } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { ForbiddenError, UnauthorizedError } from "../../shared/errors/app-error.js";

export const loadIdentity: RequestHandler = async (request, response, next) => {
  const actorUserId = request.session.actorUserId;
  if (!actorUserId) {
    response.locals.identity = null;
    next();
    return;
  }

  try {
    const actor = await prisma.user.findFirst({
      where: { id: actorUserId, deletedAt: null },
      include: {
        roles: {
          include: { role: { include: { permissions: { include: { permission: true } } } } }
        }
      }
    });
    if (!actor || actor.status !== "ACTIVE") {
      request.session.destroy(() => undefined);
      next(new UnauthorizedError());
      return;
    }

    const permissions = new Set<string>();
    for (const assignment of actor.roles) {
      permissions.add(`ROLE:${assignment.role.code}`);
      for (const item of assignment.role.permissions) permissions.add(item.permission.code);
    }

    const targetUserId = request.session.impersonation?.targetUserId;
    request.identity = {
      actorUserId,
      effectiveUserId: targetUserId ?? actorUserId,
      permissions,
      isImpersonating: Boolean(targetUserId)
    };
    response.locals.identity = request.identity;
    response.locals.currentUser = actor;
    next();
  } catch (error) {
    next(error);
  }
};

export const requireAuth: RequestHandler = (request, _response, next) => {
  if (!request.identity) return next(new UnauthorizedError());
  next();
};

export function requirePermission(permission: string): RequestHandler {
  return (request, _response, next) => {
    if (!request.identity) return next(new UnauthorizedError());
    if (!request.identity.permissions.has(permission)) {
      return next(new ForbiddenError(`Missing permission: ${permission}`));
    }
    next();
  };
}
