import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";

interface AuditInput {
  actorUserId?: string;
  targetUserId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  reason?: string;
  beforeData?: unknown;
  afterData?: unknown;
  metadata?: Record<string, unknown>;
  request?: Request;
}

export async function writeAudit(input: AuditInput) {
  return prisma.auditLog.create({
    data: {
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      reason: input.reason,
      requestId: input.request?.requestId,
      ipAddress: input.request?.ip,
      userAgent: input.request?.get("user-agent"),
      beforeData: input.beforeData as never,
      afterData: input.afterData as never,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue
    }
  });
}
