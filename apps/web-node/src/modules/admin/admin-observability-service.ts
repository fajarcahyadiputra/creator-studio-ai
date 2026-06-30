import { emailQueue } from "../../infrastructure/queue/email-queue.js";
import { temporalClient } from "../../infrastructure/temporal/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";

interface AdminObservabilityServiceDeps {
  prisma: typeof prisma;
}

interface AuditFilters {
  q?: string;
  action?: string;
}

export class AdminObservabilityService {
  public constructor(private readonly deps: AdminObservabilityServiceDeps = { prisma }) {}

  public async getAuditLogPageData(filters: AuditFilters) {
    const where = {
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.q
        ? {
            OR: [
              { action: { contains: filters.q, mode: "insensitive" as const } },
              { resourceType: { contains: filters.q, mode: "insensitive" as const } },
              { resourceId: { contains: filters.q, mode: "insensitive" as const } },
              { reason: { contains: filters.q, mode: "insensitive" as const } },
              { actorUser: { email: { contains: filters.q, mode: "insensitive" as const } } },
              { targetUser: { email: { contains: filters.q, mode: "insensitive" as const } } }
            ]
          }
        : {})
    };

    const [auditLogs, actionGroups] = await Promise.all([
      this.deps.prisma.auditLog.findMany({
        where,
        include: {
          actorUser: { select: { id: true, email: true, displayName: true } },
          targetUser: { select: { id: true, email: true, displayName: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      this.deps.prisma.auditLog.groupBy({ by: ["action"], _count: true })
    ]);

    return {
      filters: {
        q: filters.q?.trim() ?? "",
        action: filters.action ?? "ALL"
      },
      actionOptions: actionGroups.map((item) => item.action).sort(),
      auditLogs
    };
  }

  public async getWorkerHealthPageData() {
    const [jobGroups, providers] = await Promise.all([
      this.deps.prisma.job.groupBy({ by: ["status"], _count: true }),
      this.deps.prisma.aiProvider.findMany({
        select: {
          id: true,
          code: true,
          displayName: true,
          enabled: true,
          healthStatus: true,
          timeoutMs: true,
          _count: { select: { models: true, credentials: true } }
        },
        orderBy: { displayName: "asc" }
      })
    ]);

    const [dbHealth, queueHealth, temporalHealth] = await Promise.all([
      checkDatabaseHealth(this.deps.prisma),
      checkEmailQueueHealth(),
      checkTemporalHealth()
    ]);

    const backlog = Object.fromEntries(jobGroups.map((item) => [item.status, item._count]));

    return {
      services: [
        dbHealth,
        temporalHealth,
        queueHealth
      ],
      jobBacklog: backlog,
      providers
    };
  }
}

async function checkDatabaseHealth(db: typeof prisma) {
  try {
    await db.$queryRaw`SELECT 1`;
    return {
      name: "PostgreSQL",
      status: "healthy",
      detail: "Primary application database responded to a readiness query."
    };
  } catch (error) {
    return {
      name: "PostgreSQL",
      status: "degraded",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkTemporalHealth() {
  try {
    await temporalClient();
    return {
      name: "Temporal",
      status: "healthy",
      detail: "Temporal client connection succeeded."
    };
  } catch (error) {
    return {
      name: "Temporal",
      status: "degraded",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkEmailQueueHealth() {
  try {
    const counts = await emailQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed", "paused");
    return {
      name: "BullMQ Email Queue",
      status: (counts.failed ?? 0) > 0 ? "degraded" : "healthy",
      detail: `waiting=${counts.waiting ?? 0}, active=${counts.active ?? 0}, failed=${counts.failed ?? 0}, delayed=${counts.delayed ?? 0}, paused=${counts.paused ?? 0}`
    };
  } catch (error) {
    return {
      name: "BullMQ Email Queue",
      status: "degraded",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}
