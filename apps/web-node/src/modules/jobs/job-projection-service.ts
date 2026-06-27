import type { Prisma } from "../../generated/prisma/client.js";
import type { JobStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { NotFoundError } from "../../shared/errors/app-error.js";
import type { JobEventBus } from "./job-event-bus.js";
import { z } from "zod";

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
  suggested_hashtags: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  thumbnail_text: z.string().trim().min(1).max(120),
  speaker_ids: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  scene_ids: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
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
  rank: number;
};

export function resolvePersistableCandidates(
  metadata: Record<string, unknown> | undefined
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
        suggested_hashtags: candidate.suggested_hashtags,
        thumbnail_text: candidate.thumbnail_text
      } satisfies Prisma.InputJsonObject,
      speakerIds: candidate.speaker_ids,
      sceneIds: candidate.scene_ids,
      analyzerMetadata: {
        analysis_version: parsed.data.analysis_version,
        ...(parsed.data.analyzer ?? {})
      } satisfies Prisma.InputJsonObject,
      selected: true,
      rank: index + 1
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

export class JobProjectionService {
  public constructor(private readonly eventBus: JobEventBus) {}

  public async record(jobId: string, input: ProgressInput) {
    const event = await prisma.$transaction(async (tx) => {
      const current = await tx.job.findUnique({ where: { id: jobId } });
      if (!current) throw new NotFoundError("Job");
      const existingStages = await tx.jobStage.findMany({
        where: { jobId, stageVersion: 1 }
      });

      const nextSequence = current.eventSequence + 1n;
      const nextStatus = input.status ?? (current.status === "QUEUED" ? "RUNNING" : current.status);
      const outputSummary = resolveOutputSummary(input.metadata);
      const persistedCandidates = resolvePersistableCandidates(input.metadata);
      const serverOverallProgress = computeServerOverallProgress({
        existingStages,
        input
      });
      const updated = await tx.job.update({
        where: { id: jobId },
        data: {
          eventSequence: nextSequence,
          currentStage: input.stage,
          progressPercent: Math.max(current.progressPercent, serverOverallProgress),
          status: nextStatus,
          outputSummary: outputSummary ?? current.outputSummary,
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

      if (persistedCandidates) {
        const activeCandidateIds = persistedCandidates.map((candidate) => candidate.candidateExternalId);

        await tx.clipCandidate.deleteMany({
          where: {
            jobId,
            candidateExternalId: { notIn: activeCandidateIds }
          }
        });

        for (const candidate of persistedCandidates) {
          await tx.clipCandidate.upsert({
            where: {
              jobId_candidateExternalId: {
                jobId,
                candidateExternalId: candidate.candidateExternalId
              }
            },
            update: candidate,
            create: {
              jobId,
              transcriptId: null,
              ...candidate
            }
          });
        }
      }

      return tx.jobEvent.create({
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
    });

    await this.eventBus.publish(jobId, event.sequence);
    return event;
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
