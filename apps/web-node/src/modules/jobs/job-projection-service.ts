import type { Prisma } from "../../generated/prisma/client.js";
import type { JobStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import type { JobEventBus } from "./job-event-bus.js";

export interface ProgressInput {
  stage: string;
  stage_progress: number;
  overall_progress: number;
  event_type: string;
  message: string;
  user_message?: string;
  metadata?: Record<string, unknown>;
  status?: JobStatus;
  occurred_at?: string;
}

export class JobProjectionService {
  public constructor(private readonly eventBus: JobEventBus) {}

  public async record(jobId: string, input: ProgressInput) {
    const event = await prisma.$transaction(async (tx) => {
      const current = await tx.job.findUnique({ where: { id: jobId } });
      if (!current) throw new NotFoundError("Job");

      const nextSequence = current.eventSequence + 1n;
      const nextStatus = input.status ?? (current.status === "QUEUED" ? "RUNNING" : current.status);
      const updated = await tx.job.update({
        where: { id: jobId },
        data: {
          eventSequence: nextSequence,
          currentStage: input.stage,
          progressPercent: Math.max(current.progressPercent, input.overall_progress),
          status: nextStatus,
          startedAt: current.startedAt ?? new Date(),
          completedAt: ["COMPLETED", "FAILED", "CANCELED", "PARTIALLY_COMPLETED", "NEEDS_REVIEW"].includes(nextStatus)
            ? new Date()
            : current.completedAt
        }
      });

      await tx.jobStage.upsert({
        where: { jobId_name_stageVersion: { jobId, name: input.stage, stageVersion: 1 } },
        update: {
          progressPercent: input.stage_progress,
          status: input.stage_progress >= 100 ? "COMPLETED" : "RUNNING",
          startedAt: new Date(),
          completedAt: input.stage_progress >= 100 ? new Date() : null
        },
        create: {
          jobId,
          name: input.stage,
          stageVersion: 1,
          status: input.stage_progress >= 100 ? "COMPLETED" : "RUNNING",
          progressPercent: input.stage_progress,
          progressWeight: 1,
          startedAt: new Date(),
          completedAt: input.stage_progress >= 100 ? new Date() : null
        }
      });

      return tx.jobEvent.create({
        data: {
          jobId,
          sequence: nextSequence,
          stage: input.stage,
          stageProgress: input.stage_progress,
          overallProgress: input.overall_progress,
          eventType: input.event_type,
          message: input.message,
          userMessage: input.user_message,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          occurredAt: input.occurred_at ? new Date(input.occurred_at) : new Date()
        }
      });
    });

    await this.eventBus.publish(jobId, event.sequence);
    return event;
  }
}
