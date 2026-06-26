import type { Request } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { env } from "../../config/env.js";

function regenerate(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function save(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

export async function establishLoginSession(request: Request, userId: string): Promise<void> {
  await regenerate(request);
  request.session.actorUserId = userId;
  await save(request);

  const tracked = await prisma.session.create({
    data: {
      userId,
      sessionId: request.sessionID,
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
      expiresAt: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000)
    }
  });
  request.session.trackedSessionId = tracked.id;
  await save(request);
}

export async function destroyLoginSession(request: Request): Promise<void> {
  if (request.session.trackedSessionId) {
    await prisma.session.updateMany({
      where: { id: request.session.trackedSessionId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  await new Promise<void>((resolve, reject) => {
    request.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

export async function rotateAuthenticatedSession(
  request: Request,
  data: {
    actorUserId: string;
    trackedSessionId?: string;
    impersonation?: {
      targetUserId: string;
      reason: string;
      startedAt: string;
      auditLogId: string;
    };
  }
): Promise<void> {
  const oldTrackedSessionId = data.trackedSessionId;
  await regenerate(request);
  request.session.actorUserId = data.actorUserId;
  request.session.impersonation = data.impersonation;
  await save(request);

  if (oldTrackedSessionId) {
    await prisma.session.updateMany({
      where: { id: oldTrackedSessionId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  const tracked = await prisma.session.create({
    data: {
      userId: data.actorUserId,
      sessionId: request.sessionID,
      ipAddress: request.ip,
      userAgent: request.get("user-agent"),
      impersonatedUserId: data.impersonation?.targetUserId,
      impersonationReason: data.impersonation?.reason,
      expiresAt: new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000)
    }
  });
  request.session.trackedSessionId = tracked.id;
  await save(request);
}
