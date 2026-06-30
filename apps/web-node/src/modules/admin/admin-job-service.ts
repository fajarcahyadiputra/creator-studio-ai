import { randomUUID } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.js";
import { JobStatus, JobType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import type { JobService } from "../jobs/job-service.js";

interface AdminJobServiceDeps {
  prisma: typeof prisma;
  jobService: JobService;
}

interface AdminJobFilters {
  q?: string;
  status?: string;
  type?: string;
}

export class AdminJobService {
  public constructor(private readonly deps: AdminJobServiceDeps) {}

  public async getJobManagementPageData(filters: AdminJobFilters) {
    const search = filters.q?.trim();
    const where: Prisma.JobWhereInput = {
      deletedAt: null,
      ...(isJobStatus(filters.status) ? { status: filters.status } : {}),
      ...(isJobType(filters.type) ? { type: filters.type } : {}),
      ...(search
        ? {
            OR: [
              ...(isUuid(search) ? [{ id: search }] : []),
              { workflowId: { contains: search, mode: "insensitive" as const } },
              { user: { email: { contains: search, mode: "insensitive" as const } } },
              { user: { displayName: { contains: search, mode: "insensitive" as const } } }
            ]
          }
        : {})
    };

    const [jobs, statusGroups, typeGroups] = await Promise.all([
      this.deps.prisma.job.findMany({
        where,
        include: {
          user: { select: { id: true, email: true, displayName: true } },
          errors: { orderBy: { occurredAt: "desc" }, take: 1 }
        },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      this.deps.prisma.job.groupBy({ by: ["status"], _count: true }),
      this.deps.prisma.job.groupBy({ by: ["type"], _count: true })
    ]);

    return {
      filters: {
        q: filters.q?.trim() ?? "",
        status: isJobStatus(filters.status) ? filters.status : "ALL",
        type: isJobType(filters.type) ? filters.type : "ALL"
      },
      jobStatusOptions: statusGroups.map((item) => item.status).sort(),
      jobTypeOptions: typeGroups.map((item) => item.type).sort(),
      jobs: jobs.map((job) => ({
        id: job.id,
        userId: job.userId,
        userEmail: job.user.email,
        userDisplayName: job.user.displayName,
        type: job.type,
        status: job.status,
        currentStage: job.currentStage,
        progressPercent: job.progressPercent,
        workflowId: job.workflowId,
        workflowRunId: job.workflowRunId,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        latestError: job.errors[0]
          ? {
              code: job.errors[0].code,
              userMessage: job.errors[0].userMessage,
              technicalErrorId: job.errors[0].technicalErrorId
            }
          : null
      }))
    };
  }

  public async getJobDetailPageData(jobId: string) {
    const job = await this.deps.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        attempts: { orderBy: { attemptNumber: "desc" } },
        errors: { orderBy: { occurredAt: "desc" } },
        stages: { orderBy: { createdAt: "asc" } },
        clipCandidates: { orderBy: [{ rank: "asc" }, { createdAt: "asc" }] },
        clipOutputs: { orderBy: { createdAt: "asc" } }
      }
    });
    if (!job) throw new NotFoundError("Job");

    const events = await this.deps.prisma.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { sequence: "desc" },
      take: 50
    });

    const outputSummary =
      job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
        ? (job.outputSummary as Record<string, unknown>)
        : null;

    return {
      job,
      events,
      outputSummary
    };
  }

  public async cancelJob(jobId: string) {
    const job = await this.requireJob(jobId);
    await this.deps.jobService.cancel(job.userId, job.id);
    return job;
  }

  public async retryJob(jobId: string, reason: string, stage?: string) {
    const job = await this.requireJob(jobId);
    return this.deps.jobService.retry({
      userId: job.userId,
      jobId: job.id,
      idempotencyKey: `admin-retry:${randomUUID()}`,
      reason,
      stage
    });
  }

  public async duplicateJob(jobId: string) {
    const job = await this.requireJob(jobId);
    return this.deps.jobService.duplicate(job.userId, job.id, `admin-duplicate:${randomUUID()}`);
  }

  public async queueRender(jobId: string) {
    const job = await this.requireJob(jobId);
    return this.deps.jobService.queueSelectedClipOutputs({ userId: job.userId, jobId: job.id });
  }

  private async requireJob(jobId: string) {
    const job = await this.deps.prisma.job.findFirst({
      where: { id: jobId, deletedAt: null }
    });
    if (!job) throw new NotFoundError("Job");
    return job;
  }
}

function isJobStatus(value: string | undefined): value is JobStatus {
  return typeof value === "string" && value in JobStatus;
}

function isJobType(value: string | undefined): value is JobType {
  return typeof value === "string" && value in JobType;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
