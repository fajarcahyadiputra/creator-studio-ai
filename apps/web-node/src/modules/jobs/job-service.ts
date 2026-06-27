import { randomUUID } from "node:crypto";
import type { JobStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { temporalClient } from "../../infrastructure/temporal/client.js";
import { env } from "../../config/env.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";

const CREATE_AUTO_CLIP_ATTEMPT_OPERATION_KEY = "CREATE_AUTO_CLIP_JOB_ATTEMPT";
const RETRY_JOB_ATTEMPT_OPERATION_KEY = "RETRY_JOB_ATTEMPT";

interface CreateAutoClipInput {
  project_id?: string;
  source: { type: "MEDIA_ASSET" | "EXTERNAL_URL"; media_asset_id?: string; url?: string };
  content: {
    title?: string;
    context?: string;
    topic?: string;
    source_language?: string;
    speaker_count?: number;
    custom_vocabulary: string[];
    rights_confirmed: true;
  };
  strategy: Record<string, unknown>;
  visual: Record<string, unknown>;
  subtitle: Record<string, unknown>;
  ai: Record<string, unknown>;
}

interface UpdateClipCandidateSelectionInput {
  userId: string;
  jobId: string;
  candidateId: string;
  selected: boolean;
}

interface QueueSelectedClipOutputsInput {
  userId: string;
  jobId: string;
}

interface RenderSettingsSource {
  inputSnapshot: unknown;
  candidate: {
    id: string;
    candidateExternalId: string;
    startMs: bigint;
    endMs: bigint;
    durationMs: bigint;
    contentCategory: string;
    metadataSuggestions: unknown;
    analyzerMetadata: unknown;
  };
}

export class JobService {
  public async createAutoClippingJob(params: {
    userId: string;
    idempotencyKey: string;
    input: CreateAutoClipInput;
  }) {
    if (params.input.source.media_asset_id) {
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: params.input.source.media_asset_id,
          userId: params.userId,
          deletedAt: null,
          status: "READY"
        }
      });
      if (!asset) throw new NotFoundError("Ready source media asset");
    }

    const existing = await prisma.job.findUnique({
      where: {
        userId_operationKey_idempotencyKey: {
          userId: params.userId,
          operationKey: "CREATE_AUTO_CLIP_JOB",
          idempotencyKey: params.idempotencyKey
        }
      }
    });
    if (existing) return existing;

    const workflowId = `${randomUUID()}:attempt:1`;
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.job.create({
        data: {
          userId: params.userId,
          projectId: params.input.project_id,
          sourceMediaAssetId: params.input.source.media_asset_id,
          type: "AUTO_CLIPPING",
          status: "QUEUED",
          currentStage: "VALIDATING_SOURCE",
          idempotencyKey: params.idempotencyKey,
          operationKey: "CREATE_AUTO_CLIP_JOB",
          workflowId,
          inputSnapshot: params.input as never,
          attempts: {
            create: {
              attemptNumber: 1,
              status: "CREATED",
              operationKey: CREATE_AUTO_CLIP_ATTEMPT_OPERATION_KEY,
              idempotencyKey: params.idempotencyKey,
              workflowId
            }
          },
          autoClipRequest: {
            create: {
              sourceMediaAssetId: params.input.source.media_asset_id,
              sourceType: params.input.source.type,
              sourceUrl: params.input.source.url,
              sourceLanguage: params.input.content.source_language,
              speakerCount: params.input.content.speaker_count,
              contentTitle: params.input.content.title,
              contentContext: params.input.content.context,
              topic: params.input.content.topic,
              customVocabulary: params.input.content.custom_vocabulary,
              rightsConfirmedAt: new Date(),
              strategyConfig: params.input.strategy as never,
              visualConfig: params.input.visual as never,
              subtitleConfig: params.input.subtitle as never,
              providerConfigSnapshot: params.input.ai as never
            }
          }
        }
      });
      return created;
    });

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start("FoundationAutoClippingWorkflow", {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: "AUTO_CLIPPING",
            input_snapshot: params.input,
            callback_base_url: env.WEB_INTERNAL_BASE_URL,
            attempt_number: 1
          }
        ]
      });
      await prisma.$transaction([
        prisma.job.update({ where: { id: job.id }, data: { workflowRunId: handle.firstExecutionRunId } }),
        prisma.jobAttempt.update({
          where: { jobId_attemptNumber: { jobId: job.id, attemptNumber: 1 } },
          data: { status: "RUNNING", workflowRunId: handle.firstExecutionRunId, startedAt: new Date() }
        })
      ]);
      return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    } catch (error) {
      const technicalErrorId = randomUUID();
      await prisma.$transaction([
        prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } }),
        prisma.jobError.create({
          data: {
            jobId: job.id,
            technicalErrorId,
            code: "TEMPORAL_START_FAILED",
            category: "INFRASTRUCTURE_TEMPORARY",
            retryable: true,
            message: error instanceof Error ? error.message : String(error),
            userMessage: "The workflow could not be started. Retry the job when Temporal is available."
          }
        })
      ]);
      throw new AppError({
        code: "TEMPORAL_START_FAILED",
        message: "The workflow could not be started.",
        statusCode: 503,
        retryable: true,
        details: { technical_error_id: technicalErrorId },
        cause: error
      });
    }
  }

  public async cancel(userId: string, jobId: string): Promise<void> {
    const job = await prisma.job.findFirst({ where: { id: jobId, userId, deletedAt: null } });
    if (!job) throw new NotFoundError("Job");
    if (!["QUEUED", "RUNNING", "PAUSED", "PAUSE_REQUESTED"].includes(job.status)) {
      throw new ConflictError("JOB_NOT_CANCELABLE", `A ${job.status} job cannot be canceled.`);
    }
    if (!job.workflowId) throw new ConflictError("WORKFLOW_NOT_STARTED", "The workflow has not started.");
    await prisma.job.update({
      where: { id: job.id },
      data: { status: "CANCEL_REQUESTED", cancelRequestedAt: new Date() }
    });
    const client = await temporalClient();
    await client.workflow.getHandle(job.workflowId).cancel();
  }

  public async retry(params: {
    userId: string;
    jobId: string;
    reason: string;
    stage?: string;
    idempotencyKey: string;
  }) {
    const job = await prisma.job.findFirst({
      where: { id: params.jobId, userId: params.userId, deletedAt: null },
      include: { attempts: { orderBy: { attemptNumber: "desc" }, take: 1 } }
    });
    if (!job) throw new NotFoundError("Job");

    const existingAttempt = await prisma.jobAttempt.findUnique({
      where: {
        jobId_operationKey_idempotencyKey: {
          jobId: job.id,
          operationKey: RETRY_JOB_ATTEMPT_OPERATION_KEY,
          idempotencyKey: params.idempotencyKey
        }
      }
    });
    if (existingAttempt) {
      return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    }

    if (job.status !== "FAILED") {
      throw new ConflictError("JOB_NOT_RETRYABLE", "Only failed jobs can be retried.");
    }

    const attemptNumber = (job.attempts[0]?.attemptNumber ?? 0) + 1;
    const workflowId = `${job.id}:attempt:${attemptNumber}`;
    await prisma.$transaction([
      prisma.job.update({
        where: { id: job.id },
        data: {
          status: "QUEUED",
          currentStage: params.stage ?? job.currentStage,
          workflowId,
          workflowRunId: null,
          progressPercent: 0,
          completedAt: null,
          version: { increment: 1 }
        }
      }),
      prisma.jobAttempt.create({
        data: {
          jobId: job.id,
          attemptNumber,
          status: "CREATED",
          operationKey: RETRY_JOB_ATTEMPT_OPERATION_KEY,
          idempotencyKey: params.idempotencyKey,
          requestedStage: params.stage,
          reason: params.reason,
          workflowId
        }
      })
    ]);

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start("FoundationAutoClippingWorkflow", {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: job.type,
            input_snapshot: job.inputSnapshot,
            callback_base_url: env.WEB_INTERNAL_BASE_URL,
            attempt_number: attemptNumber,
            resume_from_stage: params.stage
          }
        ]
      });
      await prisma.$transaction([
        prisma.job.update({ where: { id: job.id }, data: { workflowRunId: handle.firstExecutionRunId } }),
        prisma.jobAttempt.update({
          where: { jobId_attemptNumber: { jobId: job.id, attemptNumber } },
          data: { status: "RUNNING", workflowRunId: handle.firstExecutionRunId, startedAt: new Date() }
        })
      ]);
      return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    } catch (error) {
      const technicalErrorId = randomUUID();
      await prisma.$transaction([
        prisma.job.update({ where: { id: job.id }, data: { status: "FAILED" } }),
        prisma.jobAttempt.update({
          where: { jobId_attemptNumber: { jobId: job.id, attemptNumber } },
          data: { status: "FAILED", completedAt: new Date() }
        }),
        prisma.jobError.create({
          data: {
            jobId: job.id,
            technicalErrorId,
            code: "TEMPORAL_RETRY_START_FAILED",
            category: "INFRASTRUCTURE_TEMPORARY",
            retryable: true,
            message: error instanceof Error ? error.message : String(error),
            userMessage: "The retry workflow could not be started. Retry the job again when Temporal is available."
          }
        })
      ]);
      throw new AppError({
        code: "TEMPORAL_RETRY_START_FAILED",
        message: "The retry workflow could not be started.",
        statusCode: 503,
        retryable: true,
        details: { technical_error_id: technicalErrorId },
        cause: error
      });
    }
  }

  public async duplicate(userId: string, jobId: string, idempotencyKey: string) {
    const job = await prisma.job.findFirst({ where: { id: jobId, userId, deletedAt: null } });
    if (!job || job.type !== "AUTO_CLIPPING") throw new NotFoundError("Auto clipping job");
    return this.createAutoClippingJob({
      userId,
      idempotencyKey,
      input: job.inputSnapshot as unknown as CreateAutoClipInput
    });
  }

  public async list(userId: string) {
    return prisma.job.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { errors: { orderBy: { occurredAt: "desc" }, take: 1 } }
    });
  }

  public async get(userId: string, jobId: string) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: {
        stages: { orderBy: { createdAt: "asc" } },
        attempts: { orderBy: { attemptNumber: "desc" } },
        errors: { orderBy: { occurredAt: "desc" } },
        clipCandidates: { orderBy: { rank: "asc" } },
        clipOutputs: true
      }
    });
    if (!job) throw new NotFoundError("Job");
    return job;
  }

  public async updateClipCandidateSelection(params: UpdateClipCandidateSelectionInput) {
    return prisma.$transaction(async (tx) => {
      const candidate = await tx.clipCandidate.findFirst({
        where: {
          id: params.candidateId,
          jobId: params.jobId,
          job: {
            userId: params.userId,
            deletedAt: null
          }
        }
      });
      if (!candidate) throw new NotFoundError("Clip candidate");

      if (params.selected) {
        if (candidate.selected) return candidate;

        const highestSelected = await tx.clipCandidate.findFirst({
          where: { jobId: params.jobId, selected: true },
          orderBy: { rank: "desc" }
        });
        return tx.clipCandidate.update({
          where: { id: candidate.id },
          data: {
            selected: true,
            rank: (highestSelected?.rank ?? 0) + 1
          }
        });
      }

      if (!candidate.selected) {
        return tx.clipCandidate.update({
          where: { id: candidate.id },
          data: { rank: null }
        });
      }

      await tx.clipCandidate.updateMany({
        where: {
          jobId: params.jobId,
          selected: true,
          rank: { gt: candidate.rank ?? 0 }
        },
        data: {
          rank: { decrement: 1 }
        }
      });

      return tx.clipCandidate.update({
        where: { id: candidate.id },
        data: {
          selected: false,
          rank: null
        }
      });
    });
  }

  public async queueSelectedClipOutputs(params: QueueSelectedClipOutputsInput) {
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findFirst({
        where: { id: params.jobId, userId: params.userId, deletedAt: null },
        include: {
          clipCandidates: {
            where: { selected: true },
            orderBy: [{ rank: "asc" }, { createdAt: "asc" }]
          },
          clipOutputs: {
            where: { deletedAt: null },
            orderBy: { createdAt: "asc" }
          }
        }
      });
      if (!job) throw new NotFoundError("Job");

      const existingCandidateIds = new Set(job.clipOutputs.map((output) => output.candidateId));

      let createdCount = 0;
      for (const candidate of job.clipCandidates) {
        if (existingCandidateIds.has(candidate.id)) {
          continue;
        }
        await tx.clipOutput.create({
          data: {
            jobId: job.id,
            candidateId: candidate.id,
            version: 1,
            renderSettings: buildRenderSettings({
              inputSnapshot: job.inputSnapshot,
              candidate
            }) as never
          }
        });
        createdCount += 1;
      }

      const selectedCount = job.clipCandidates.length;
      return {
        jobId: job.id,
        selectedCount,
        createdCount,
        existingCount: selectedCount - createdCount
      };
    });
  }
}

export function assertIdempotencyKey(value: string | undefined): string {
  if (!value || value.length < 8 || value.length > 160) {
    throw new AppError({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid Idempotency-Key header is required.",
      statusCode: 400
    });
  }
  return value;
}

export function serializeJob<T extends { eventSequence?: bigint }>(job: T): Record<string, unknown> {
  return { ...job, eventSequence: job.eventSequence?.toString() };
}

export function buildRenderSettings(source: RenderSettingsSource): Record<string, unknown> {
  const snapshot =
    source.inputSnapshot && typeof source.inputSnapshot === "object" && !Array.isArray(source.inputSnapshot)
      ? (source.inputSnapshot as Record<string, unknown>)
      : {};
  const visual =
    snapshot.visual && typeof snapshot.visual === "object" && !Array.isArray(snapshot.visual)
      ? (snapshot.visual as Record<string, unknown>)
      : {};
  const subtitle =
    snapshot.subtitle && typeof snapshot.subtitle === "object" && !Array.isArray(snapshot.subtitle)
      ? (snapshot.subtitle as Record<string, unknown>)
      : {};
  const strategy =
    snapshot.strategy && typeof snapshot.strategy === "object" && !Array.isArray(snapshot.strategy)
      ? (snapshot.strategy as Record<string, unknown>)
      : {};
  const metadataSuggestions =
    source.candidate.metadataSuggestions &&
    typeof source.candidate.metadataSuggestions === "object" &&
    !Array.isArray(source.candidate.metadataSuggestions)
      ? (source.candidate.metadataSuggestions as Record<string, unknown>)
      : {};
  const analyzerMetadata =
    source.candidate.analyzerMetadata &&
    typeof source.candidate.analyzerMetadata === "object" &&
    !Array.isArray(source.candidate.analyzerMetadata)
      ? (source.candidate.analyzerMetadata as Record<string, unknown>)
      : {};

  return {
    visual,
    subtitle,
    strategy: {
      target_platform: strategy.target_platform ?? null,
      objective: strategy.objective ?? null
    },
    candidate: {
      candidate_id: source.candidate.candidateExternalId,
      clip_candidate_id: source.candidate.id,
      start_ms: source.candidate.startMs.toString(),
      end_ms: source.candidate.endMs.toString(),
      duration_ms: source.candidate.durationMs.toString(),
      content_category: source.candidate.contentCategory
    },
    metadata: {
      suggested_caption:
        typeof metadataSuggestions.suggested_caption === "string" ? metadataSuggestions.suggested_caption : null,
      suggested_cta: typeof metadataSuggestions.suggested_cta === "string" ? metadataSuggestions.suggested_cta : null,
      suggested_hashtags: Array.isArray(metadataSuggestions.suggested_hashtags)
        ? metadataSuggestions.suggested_hashtags.filter((value): value is string => typeof value === "string")
        : [],
      thumbnail_text: typeof metadataSuggestions.thumbnail_text === "string" ? metadataSuggestions.thumbnail_text : null
    },
    analyzer: {
      analysis_version: typeof analyzerMetadata.analysis_version === "string" ? analyzerMetadata.analysis_version : null,
      analysis_mode: typeof analyzerMetadata.analysis_mode === "string" ? analyzerMetadata.analysis_mode : null,
      prompt_version: typeof analyzerMetadata.prompt_version === "string" ? analyzerMetadata.prompt_version : null,
      provider: typeof analyzerMetadata.provider === "string" ? analyzerMetadata.provider : null,
      model: typeof analyzerMetadata.model === "string" ? analyzerMetadata.model : null
    }
  };
}
