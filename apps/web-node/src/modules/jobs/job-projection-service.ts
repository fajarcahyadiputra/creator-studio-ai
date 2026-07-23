import type { Prisma } from "../../generated/prisma/client.js";
import type { JobStatus } from "../../generated/prisma/enums.js";
import { env } from "../../config/env.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { temporalClient } from "../../infrastructure/temporal/client.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import type { JobEventBus } from "./job-event-bus.js";
import { z } from "zod";
import { buildClipOutputRenderWorkflowId, buildRenderSettings } from "./job-service.js";

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

export function resolveStageWeight(metadata: Record<string, unknown> | undefined): number {
  const value = metadata?.stage_weight;
  if (isPositiveNumber(value)) {
    return value;
  }
  return 1;
}

export function resolveTotalStageWeight(metadata: Record<string, unknown> | undefined): number | undefined {
  const value = metadata?.total_stage_weight;
  if (isPositiveNumber(value)) {
    return value;
  }
  return undefined;
}

export function resolveOutputSummary(metadata: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  const value = metadata?.output_summary;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Prisma.InputJsonValue;
  }
  return undefined;
}

const candidateOutputSchema = z.object({
  candidate_id: z.string().trim().min(1).max(100),
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0),
  duration_seconds: z.number().gt(0),
  title: z.string().trim().min(1).max(255),
  hook_text: z.string().trim().min(1).max(500),
  ending_text: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2000),
  why_it_works: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  content_category: z.enum(["debate", "insight", "story", "reaction", "humor", "other"]),
  context_complete: z.boolean(),
  safety_notes: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  suggested_caption: z.string().trim().min(1).max(1000),
  suggested_cta: z.string().trim().min(1).max(255),
  related_hashtags: z.array(z.string().trim().min(2).max(100)).max(7).default([]),
  viral_hashtags: z.array(z.string().trim().min(2).max(100)).max(5).default([]),
  suggested_hashtags: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  thumbnail_text: z.string().trim().min(1).max(120),
  speaker_ids: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  scene_ids: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  hook_second: z.number().min(0),
  main_point_second: z.number().min(0),
  punchline_second: z.number().min(0),
  retention_level: z.enum(["very_high", "high", "medium", "low"]),
  requires_context: z.boolean(),
  can_standalone: z.boolean(),
  scores: z.record(z.string(), z.unknown())
}).refine((value) => value.end_seconds > value.start_seconds, {
  message: "Candidate end must be greater than start."
});

const outputSummarySchema = z.object({
  analysis_version: z.string().trim().min(1).max(40),
  candidate_count: z.number().int().min(0).max(500),
  analyzer: z.record(z.string(), z.unknown()).optional(),
  candidates: z.array(candidateOutputSchema).max(500)
});

type PersistableCandidate = {
  candidateExternalId: string;
  startMs: bigint;
  endMs: bigint;
  durationMs: bigint;
  title: string;
  hookText: string;
  endingText: string;
  summary: string;
  whyItWorks: Prisma.InputJsonValue;
  contentCategory: string;
  scoreBreakdown: Prisma.InputJsonValue;
  baseViralScore: string;
  finalViralScore: string;
  contextComplete: boolean;
  safetyNotes: Prisma.InputJsonValue;
  metadataSuggestions: Prisma.InputJsonValue;
  speakerIds: Prisma.InputJsonValue;
  sceneIds: Prisma.InputJsonValue;
  analyzerMetadata: Prisma.InputJsonValue;
  selected: boolean;
  rank: number | null;
};

type PersistedClipCandidate = {
  id: string;
  candidateExternalId: string;
  startMs: bigint;
  endMs: bigint;
  durationMs: bigint;
  contentCategory: string;
  metadataSuggestions: Prisma.JsonValue;
  analyzerMetadata: Prisma.JsonValue;
  selected: boolean;
};

type RenderQueueCandidate = {
  id: string;
  candidateExternalId: string;
  startMs: bigint;
  endMs: bigint;
  durationMs: bigint;
  contentCategory: string;
  metadataSuggestions: Prisma.JsonValue;
  analyzerMetadata: Prisma.JsonValue;
  selected: boolean;
};

type TranscriptLinkSource = {
  sourceMediaAssetId: string | null;
};

type TranscriptLinkTarget = {
  id: string;
  mediaAssetId: string;
};

export function resolvePersistableCandidates(
  metadata: Record<string, unknown> | undefined,
  desiredClipCount = 0
): PersistableCandidate[] | undefined {
  const outputSummary = resolveOutputSummary(metadata);
  const parsed = outputSummarySchema.safeParse(outputSummary);
  if (!parsed.success) return undefined;

  return parsed.data.candidates.map((candidate, index) => {
    const scoreBreakdown = candidate.scores as Record<string, unknown>;
    const baseViralScore = resolveScore(scoreBreakdown.base_viral_score);
    const finalViralScore = resolveScore(scoreBreakdown.final_viral_score);

    return {
      candidateExternalId: candidate.candidate_id,
      startMs: secondsToMilliseconds(candidate.start_seconds),
      endMs: secondsToMilliseconds(candidate.end_seconds),
      durationMs: secondsToMilliseconds(candidate.duration_seconds),
      title: candidate.title,
      hookText: candidate.hook_text,
      endingText: candidate.ending_text,
      summary: candidate.summary,
      whyItWorks: candidate.why_it_works,
      contentCategory: candidate.content_category,
      scoreBreakdown: candidate.scores as Prisma.InputJsonValue,
      baseViralScore,
      finalViralScore,
      contextComplete: candidate.context_complete,
      safetyNotes: candidate.safety_notes,
      metadataSuggestions: {
        suggested_caption: candidate.suggested_caption,
        suggested_cta: candidate.suggested_cta,
        related_hashtags: candidate.related_hashtags,
        viral_hashtags: candidate.viral_hashtags,
        suggested_hashtags: candidate.suggested_hashtags,
        thumbnail_text: candidate.thumbnail_text,
        hook_second: candidate.hook_second,
        main_point_second: candidate.main_point_second,
        punchline_second: candidate.punchline_second,
        retention_level: candidate.retention_level,
        requires_context: candidate.requires_context,
        can_standalone: candidate.can_standalone
      } satisfies Prisma.InputJsonObject,
      speakerIds: candidate.speaker_ids,
      sceneIds: candidate.scene_ids,
      analyzerMetadata: {
        analysis_version: parsed.data.analysis_version,
        ...(parsed.data.analyzer ?? {})
      } satisfies Prisma.InputJsonObject,
      selected: desiredClipCount <= 0 ? true : index < desiredClipCount,
      rank: desiredClipCount <= 0 || index < desiredClipCount ? index + 1 : null
    };
  });
}

export function computeServerOverallProgress(params: {
  existingStages: Array<{ name: string; progressPercent: number; progressWeight: unknown }>;
  input: Pick<ProgressInput, "stage" | "stage_progress" | "metadata" | "overall_progress">;
}): number {
  const totalStageWeight = resolveTotalStageWeight(params.input.metadata);
  if (!totalStageWeight) return params.input.overall_progress;

  const stageWeights = new Map<string, number>();
  const stageProgress = new Map<string, number>();

  for (const stage of params.existingStages) {
    stageWeights.set(stage.name, coercePositiveNumber(stage.progressWeight) ?? 1);
    stageProgress.set(stage.name, stage.progressPercent);
  }

  stageWeights.set(params.input.stage, resolveStageWeight(params.input.metadata));
  stageProgress.set(params.input.stage, params.input.stage_progress);

  let weightedProgress = 0;
  for (const [stageName, weight] of stageWeights.entries()) {
    const progressPercent = stageProgress.get(stageName) ?? 0;
    weightedProgress += weight * Math.max(0, Math.min(100, progressPercent)) / 100;
  }

  return Math.max(0, Math.min(100, Math.round(weightedProgress / totalStageWeight * 100)));
}

export function resolveCandidateTranscriptId(
  job: TranscriptLinkSource,
  transcript: TranscriptLinkTarget | null | undefined
): string | null {
  if (!job.sourceMediaAssetId || !transcript) return null;
  return transcript.mediaAssetId === job.sourceMediaAssetId ? transcript.id : null;
}

const TERMINAL_JOB_STAGES = [
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "PARTIALLY_COMPLETED",
  "NEEDS_REVIEW"
] as const;

export function resolveRecordedJobProgress(params: {
  currentProgressPercent: number;
  computedProgressPercent: number;
  nextStatus: string;
}) {
  if (params.nextStatus === "COMPLETED" || params.nextStatus === "PARTIALLY_COMPLETED") {
    return 100;
  }

  if (params.nextStatus === "FAILED" || params.nextStatus === "CANCELED" || params.nextStatus === "NEEDS_REVIEW") {
    return Math.min(99, Math.max(params.currentProgressPercent, params.computedProgressPercent));
  }

  return Math.max(params.currentProgressPercent, params.computedProgressPercent);
}

export function resolveRecordedJobStage(stage: string, nextStatus: string) {
  return TERMINAL_JOB_STAGES.includes(nextStatus as (typeof TERMINAL_JOB_STAGES)[number])
    ? nextStatus
    : stage;
}

export class JobProjectionService {
  public constructor(private readonly eventBus: JobEventBus) {}

  public async record(jobId: string, input: ProgressInput) {
    const recordResult = await prisma.$transaction(async (tx) => {
      const current = await tx.job.findUnique({ where: { id: jobId } });
      if (!current) throw new NotFoundError("Job");
      const existingStages = await tx.jobStage.findMany({
        where: { jobId, stageVersion: 1 }
      });

      const nextSequence = current.eventSequence + 1n;
      const nextStatus = input.status ?? (current.status === "QUEUED" ? "RUNNING" : current.status);
      const outputSummary = resolveOutputSummary(input.metadata);
      const inputSnapshot =
        current.inputSnapshot && typeof current.inputSnapshot === "object" && !Array.isArray(current.inputSnapshot)
          ? (current.inputSnapshot as Record<string, unknown>)
          : {};
      const strategySnapshot =
        inputSnapshot.strategy && typeof inputSnapshot.strategy === "object" && !Array.isArray(inputSnapshot.strategy)
          ? (inputSnapshot.strategy as Record<string, unknown>)
          : {};
      const desiredClipCount =
        typeof strategySnapshot.desired_clip_count === "number" && Number.isFinite(strategySnapshot.desired_clip_count)
          ? strategySnapshot.desired_clip_count
          : 0;
      const persistedCandidates = resolvePersistableCandidates(input.metadata, desiredClipCount);
      const serverOverallProgress = computeServerOverallProgress({
        existingStages,
        input
      });
      const recordedProgressPercent = resolveRecordedJobProgress({
        currentProgressPercent: current.progressPercent,
        computedProgressPercent: serverOverallProgress,
        nextStatus
      });
      const recordedStage = resolveRecordedJobStage(input.stage, nextStatus);
      const updated = await tx.job.update({
        where: { id: jobId },
        data: {
          eventSequence: nextSequence,
          currentStage: recordedStage,
          progressPercent: recordedProgressPercent,
          status: nextStatus,
          outputSummary:
            outputSummary
            ?? (current.outputSummary === null ? undefined : (current.outputSummary as Prisma.InputJsonValue)),
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
          progressWeight: resolveStageWeight(input.metadata),
          startedAt: new Date(),
          completedAt: input.stage_progress >= 100 ? new Date() : null
        },
        create: {
          jobId,
          name: input.stage,
          stageVersion: 1,
          status: input.stage_progress >= 100 ? "COMPLETED" : "RUNNING",
          progressPercent: input.stage_progress,
          progressWeight: resolveStageWeight(input.metadata),
          startedAt: new Date(),
          completedAt: input.stage_progress >= 100 ? new Date() : null
        }
      });

      const queuedClipOutputIds: string[] = [];
      let renderQueueCandidates: RenderQueueCandidate[] = [];
      if (persistedCandidates) {
        const linkedTranscript = current.sourceMediaAssetId
          ? await tx.transcript.findFirst({
              where: {
                mediaAssetId: current.sourceMediaAssetId,
                status: "READY"
              },
              orderBy: { version: "desc" },
              select: { id: true, mediaAssetId: true }
            })
          : null;
        const transcriptId = resolveCandidateTranscriptId(current, linkedTranscript);
        const activeCandidateIds = persistedCandidates.map((candidate) => candidate.candidateExternalId);

        await tx.clipCandidate.deleteMany({
          where: {
            jobId,
            candidateExternalId: { notIn: activeCandidateIds }
          }
        });

        const persistedClipCandidates: PersistedClipCandidate[] = [];
        for (const candidate of persistedCandidates) {
          const persistedClipCandidate = await tx.clipCandidate.upsert({
            where: {
              jobId_candidateExternalId: {
                jobId,
                candidateExternalId: candidate.candidateExternalId
              }
            },
            update: candidate,
            create: {
              jobId,
              transcriptId,
              ...candidate
            }
          });
          persistedClipCandidates.push(persistedClipCandidate);
        }
        renderQueueCandidates = persistedClipCandidates;
      }

      if (nextStatus === "COMPLETED") {
        if (renderQueueCandidates.length === 0) {
          renderQueueCandidates = await tx.clipCandidate.findMany({
            where: {
              jobId,
              selected: true
            },
            select: {
              id: true,
              candidateExternalId: true,
              startMs: true,
              endMs: true,
              durationMs: true,
              contentCategory: true,
              metadataSuggestions: true,
              analyzerMetadata: true,
              selected: true
            }
          });
        }

        if (renderQueueCandidates.length > 0) {
          const existingClipOutputs = await tx.clipOutput.findMany({
            where: {
              jobId,
              deletedAt: null
            },
            select: {
              candidateId: true
            }
          });
          const existingCandidateIds = new Set(existingClipOutputs.map((output) => output.candidateId));

          for (const candidate of renderQueueCandidates) {
            if (!candidate.selected || existingCandidateIds.has(candidate.id)) {
              continue;
            }

            const clipOutput = await tx.clipOutput.create({
              data: {
                jobId,
                candidateId: candidate.id,
                version: 1,
                renderSettings: buildRenderSettings({
                  inputSnapshot: current.inputSnapshot,
                  candidate: {
                    id: candidate.id,
                    candidateExternalId: candidate.candidateExternalId,
                    startMs: candidate.startMs,
                    endMs: candidate.endMs,
                    durationMs: candidate.durationMs,
                    contentCategory: candidate.contentCategory,
                    metadataSuggestions: candidate.metadataSuggestions,
                    analyzerMetadata: candidate.analyzerMetadata
                  }
                }) as never
              }
            });
            queuedClipOutputIds.push(clipOutput.id);
          }
        }
      }

      const event = await tx.jobEvent.create({
        data: {
          jobId,
          sequence: nextSequence,
          stage: input.stage,
          stageProgress: input.stage_progress,
          overallProgress: serverOverallProgress,
          eventType: input.event_type,
          message: input.message,
          userMessage: input.user_message,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
          occurredAt: input.occurred_at ? new Date(input.occurred_at) : new Date()
        }
      });

      return {
        event,
        queuedClipOutputIds
      };
    });

    if (recordResult.queuedClipOutputIds.length > 0) {
      const client = await temporalClient();
      for (const clipOutputId of recordResult.queuedClipOutputIds) {
        await client.workflow.start("ClipOutputRenderWorkflow", {
          taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
          workflowId: buildClipOutputRenderWorkflowId(clipOutputId),
          args: [{ clip_output_id: clipOutputId }]
        });
      }
    }

    await this.eventBus.publish(jobId, recordResult.event.sequence);
    return recordResult.event;
  }
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function coercePositiveNumber(value: unknown): number | undefined {
  if (isPositiveNumber(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof value === "object" && value && "toString" in value && typeof value.toString === "function") {
    const parsed = Number(value.toString());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function secondsToMilliseconds(value: number): bigint {
  return BigInt(Math.max(0, Math.round(value * 1000)));
}

function resolveScore(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toFixed(2);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed.toFixed(2);
    }
  }
  return "0.00";
}
