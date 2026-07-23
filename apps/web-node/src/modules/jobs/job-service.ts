import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client.js";
import type { JobStatus } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { validateExternalSourceUrl } from "../../infrastructure/ingestion/client.js";
import {
  createInternalSignedObjectReadUrl,
  createPublicSignedObjectReadUrl,
  deleteObjectKeys,
  objectExists
} from "../../infrastructure/storage/s3.js";
import { temporalClient } from "../../infrastructure/temporal/client.js";
import { env } from "../../config/env.js";
import { AppError, ConflictError, NotFoundError } from "../../shared/errors/app-error.js";
import {
  AUTO_CLIP_ANALYZER_RUNTIME_KEY,
  AUTO_CLIP_SOURCE_QUALITY_KEY,
  buildAutoClipAnalyzerRuntimeSettingValue,
  buildAutoClipSourceQualitySettingValue
} from "../admin/system-runtime-config.js";

const CREATE_AUTO_CLIP_ATTEMPT_OPERATION_KEY = "CREATE_AUTO_CLIP_JOB_ATTEMPT";
const RETRY_JOB_ATTEMPT_OPERATION_KEY = "RETRY_JOB_ATTEMPT";
const REGENERATE_JOB_ATTEMPT_OPERATION_KEY = "REGENERATE_JOB_ATTEMPT";

interface CreateAutoClipInput {
  project_id?: string;
  source: {
    type: "MEDIA_ASSET" | "EXTERNAL_URL";
    media_asset_id?: string;
    url?: string;
    download_quality?: Record<string, unknown>;
  };
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

interface CreateTtsInput {
  project_id?: string;
  script: string;
  language: string;
  local_model_key?: string;
  voice_identifier?: string;
  speaking_style?: string;
  emotion?: string;
  speaking_speed?: number;
  pitch?: number;
  pause_intensity?: number;
  target_duration_ms?: number;
  pronunciation_dictionary: Record<string, string>;
  output_config: Record<string, unknown>;
  user_preferences: Record<string, unknown>;
  ai: {
    credential_mode: "PLATFORM" | "USER_OWNED";
    provider_id?: string;
    model_id?: string;
  };
}

interface RegenerateAutoClipInput {
  content_title?: string;
  content_context?: string;
  topic?: string;
  source_language?: string;
  speaker_count?: number;
  custom_vocabulary_text: string[];
  target_platform: "TIKTOK" | "INSTAGRAM_REELS" | "FACEBOOK_REELS" | "YOUTUBE_SHORTS" | "CUSTOM";
  objective:
    | "ENGAGEMENT"
    | "EDUCATION"
    | "CONTROVERSY"
    | "STORYTELLING"
    | "PRODUCT_AWARENESS"
    | "LEAD_GENERATION";
  tones_text: string[];
  desired_clip_count?: number;
  candidate_pool_count?: number;
  minimum_duration_seconds?: number;
  maximum_duration_seconds?: number;
  minimum_viral_score?: number;
  preferred_topics_text: string[];
  topics_to_avoid_text: string[];
  sensitive_topics_text: string[];
  clip_style_tags_text: string[];
  virality_priorities_text: string[];
  selection_brief?: string;
  avoidance_brief?: string;
  packaging_brief?: string;
  hook_style?: string;
  cta_preference?: string;
  standalone_priority: "REQUIRED" | "PREFERRED" | "FLEXIBLE";
  require_spoken_audio: boolean;
  profanity_handling: "KEEP" | "MUTE" | "BLEEP" | "SUBTITLE_CENSOR";
  remove_long_silence: boolean;
  remove_filler_words: boolean;
  aspect_ratio: "9:16" | "1:1" | "4:5" | "16:9" | "CUSTOM";
  crop_strategy:
    | "CENTER"
    | "SMART_SPEAKER"
    | "ACTIVE_SPEAKER"
    | "FACE_TRACKING"
    | "AUTO_REFRAME"
    | "SPLIT_SCREEN"
    | "SPEAKER_AND_SCREEN"
    | "BLURRED_BACKGROUND"
    | "MANUAL";
  layout_template: "STANDARD" | "PODCAST_SPOTLIGHT_9X16";
  podcast_source_enabled: boolean;
  podcast_spotlight_style: "EDITORIAL_GOLD" | "VIDEO_FIRST";
  headline_overlay_enabled: boolean;
  headline_overlay_position: "TOP" | "BOTTOM";
  framing_detection_mode: "COMBINED" | "TRANSCRIPT_ONLY" | "FACE_DETECTION_ONLY";
  split_on_multi_face: boolean;
  split_min_face_count?: number;
  subtitle_enabled: boolean;
  subtitle_language: string;
  subtitle_burn_in: boolean;
  subtitle_primary_format: "SRT" | "VTT" | "ASS" | "JSON";
  subtitle_export_formats_text: string[];
  subtitle_style?: string;
  subtitle_font_family?: string;
  subtitle_position?: "TOP" | "CENTER" | "BOTTOM";
  subtitle_text_case: "UPPERCASE" | "LOWERCASE" | "ORIGINAL";
  subtitle_max_lines?: number;
  subtitle_safe_margin_percent?: number;
  subtitle_profanity_censor: boolean;
}

interface RegenerateTtsInput {
  script: string;
  language: string;
  local_model_key?: string;
  voice_identifier?: string;
  speaking_style?: string;
  emotion?: string;
  speaking_speed?: number;
  pitch?: number;
  pause_intensity?: number;
  target_duration_ms?: number;
  preferred_format: "WAV" | "MP3" | "OGG";
  segmentation_mode: "OPENAI" | "LOCAL_HEURISTIC";
  sample_rate?: number;
  channels?: number;
  tone_notes?: string;
  delivery_goal?: string;
  segment_length_preference?: "SHORT" | "BALANCED" | "LONG";
  breathing_style?: "MINIMAL" | "NATURAL" | "DRAMATIC";
}

const SUBTITLE_STYLES_WITH_WORD_HIGHLIGHT = new Set([
  "PODCAST_HIGHLIGHT",
  "NEWS_FLASH"
]);

function normalizeSubtitleStyle(style: string | undefined): string | undefined {
  const normalized = style?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function subtitleStyleUsesWordHighlight(style: string | undefined): boolean | undefined {
  const normalizedStyle = normalizeSubtitleStyle(style);
  if (!normalizedStyle) return undefined;
  return SUBTITLE_STYLES_WITH_WORD_HIGHLIGHT.has(normalizedStyle);
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

interface QueueSelectedClipOutputsResult {
  jobId: string;
  selectedCount: number;
  createdCount: number;
  existingCount: number;
  startedWorkflowCount: number;
}

export type ClipOutputArtifact =
  | "preview"
  | "final"
  | "metadata"
  | "subtitle"
  | "subtitle_srt"
  | "subtitle_ass"
  | "subtitle_vtt"
  | "subtitle_json";

interface RerenderClipOutputInput {
  userId: string;
  jobId: string;
  clipOutputId: string;
}

interface ClipOutputExportIndexItem {
  artifact: ClipOutputArtifact;
  label: string;
  url: string;
}

interface ClipOutputExportIndex {
  clipOutputId: string;
  jobId: string;
  candidateId: string;
  qualityStatus: string;
  artifacts: ClipOutputExportIndexItem[];
}

interface JobOutputsExportIndexItem {
  clipOutputId: string;
  candidateId: string;
  qualityStatus: string;
  artifacts: ClipOutputExportIndexItem[];
}

interface JobOutputsExportIndex {
  jobId: string;
  status: string;
  clipOutputs: JobOutputsExportIndexItem[];
}

function reconcileClipOutputQualityStatus(params: {
  persistedQualityStatus: string;
  qualityReport: unknown;
  hasFinalObject: boolean;
}) {
  const qualityReport =
    params.qualityReport && typeof params.qualityReport === "object" && !Array.isArray(params.qualityReport)
      ? (params.qualityReport as Record<string, unknown>)
      : {};
  const validation =
    qualityReport.validation && typeof qualityReport.validation === "object" && !Array.isArray(qualityReport.validation)
      ? (qualityReport.validation as Record<string, unknown>)
      : {};
  const checks =
    validation.checks && typeof validation.checks === "object" && !Array.isArray(validation.checks)
      ? (validation.checks as Record<string, unknown>)
      : {};
  const validationStatus = typeof validation.status === "string" ? validation.status : null;
  const playable = checks.playable === true;

  if (
    params.persistedQualityStatus === "NEEDS_REVIEW"
    && validationStatus === "passed"
    && params.hasFinalObject
    && playable
  ) {
    return "PASSED";
  }

  return params.persistedQualityStatus;
}

function reconcileJobOutputsStatus(params: {
  persistedJobStatus: string;
  clipOutputStatuses: string[];
}) {
  if (
    params.persistedJobStatus === "NEEDS_REVIEW"
    && params.clipOutputStatuses.length > 0
    && params.clipOutputStatuses.every((status) => status === "PASSED")
  ) {
    return "COMPLETED";
  }

  return params.persistedJobStatus;
}

interface TtsSegmentationExport {
  jobId: string;
  status: string;
  language: string | null;
  localModelKey: string | null;
  voiceIdentifier: string | null;
  speakingStyle: string | null;
  emotion: string | null;
  segmentCount: number;
  totalPauseMs: number;
  metadata: Record<string, unknown>;
  document: Record<string, unknown>;
}

type TtsOutputArtifact = "audio";

interface TtsOutputExportIndexItem {
  artifact: TtsOutputArtifact;
  label: string;
  url: string;
}

interface TtsOutputExportIndex {
  jobId: string;
  status: string;
  artifacts: TtsOutputExportIndexItem[];
  language: string | null;
  localModelKey: string | null;
  voiceIdentifier: string | null;
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
    speakerIds?: unknown;
  };
}

export class JobService {
  public async createTextToSpeechJob(params: {
    userId: string;
    idempotencyKey: string;
    input: CreateTtsInput;
  }) {
    const existing = await prisma.job.findUnique({
      where: {
        userId_operationKey_idempotencyKey: {
          userId: params.userId,
          operationKey: "CREATE_TTS_JOB",
          idempotencyKey: params.idempotencyKey
        }
      }
    });
    if (existing) return existing;

    const normalizedInput = prepareTtsInput(params.input);
    const workflowId = `${randomUUID()}:attempt:1`;
    const job = await prisma.$transaction(async (tx) => {
      return tx.job.create({
        data: {
          userId: params.userId,
          projectId: normalizedInput.project_id,
          type: "TEXT_TO_SPEECH",
          status: "QUEUED",
          currentStage: "VALIDATING_SCRIPT",
          idempotencyKey: params.idempotencyKey,
          operationKey: "CREATE_TTS_JOB",
          workflowId,
          inputSnapshot: normalizedInput as never,
          attempts: {
            create: {
              attemptNumber: 1,
              status: "CREATED",
              operationKey: "CREATE_TTS_JOB_ATTEMPT",
              idempotencyKey: params.idempotencyKey,
              workflowId
            }
          },
          ttsRequest: {
            create: {
              script: normalizedInput.script,
              language: normalizedInput.language,
              providerId: normalizedInput.ai.provider_id ?? null,
              modelId: normalizedInput.ai.model_id ?? null,
              voiceIdentifier: normalizedInput.voice_identifier ?? null,
              speakingStyle: normalizedInput.speaking_style ?? null,
              emotion: normalizedInput.emotion ?? null,
              speakingSpeed:
                typeof normalizedInput.speaking_speed === "number" ? normalizedInput.speaking_speed : null,
              pitch: typeof normalizedInput.pitch === "number" ? normalizedInput.pitch : null,
              pauseIntensity:
                typeof normalizedInput.pause_intensity === "number" ? normalizedInput.pause_intensity : null,
              targetDurationMs:
                typeof normalizedInput.target_duration_ms === "number"
                  ? BigInt(normalizedInput.target_duration_ms)
                  : null,
              pronunciationDictionary: normalizedInput.pronunciation_dictionary as never,
              outputConfig: {
                ...normalizedInput.output_config,
                user_preferences: normalizedInput.user_preferences
              } as never
            }
          }
        }
      });
    });

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start(resolveFoundationWorkflowName("TEXT_TO_SPEECH"), {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: "TEXT_TO_SPEECH",
            input_snapshot: normalizedInput,
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
            userMessage: "The TTS workflow could not be started. Retry the job when Temporal is available."
          }
        })
      ]);
      throw new AppError({
        code: "TEMPORAL_START_FAILED",
        message: "The TTS workflow could not be started.",
        statusCode: 503,
        retryable: true,
        details: { technical_error_id: technicalErrorId },
        cause: error
      });
    }
  }

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

    const normalizedInput = await prepareAutoClippingInput(params.userId, params.input);
    const workflowId = `${randomUUID()}:attempt:1`;
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.job.create({
        data: {
          userId: params.userId,
          projectId: normalizedInput.project_id,
          sourceMediaAssetId: normalizedInput.source.media_asset_id,
          type: "AUTO_CLIPPING",
          status: "QUEUED",
          currentStage: "VALIDATING_SOURCE",
          idempotencyKey: params.idempotencyKey,
          operationKey: "CREATE_AUTO_CLIP_JOB",
          workflowId,
          inputSnapshot: normalizedInput as never,
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
              sourceMediaAssetId: normalizedInput.source.media_asset_id,
              sourceType: normalizedInput.source.type,
              sourceUrl: normalizedInput.source.url,
              sourceLanguage: normalizedInput.content.source_language,
              speakerCount: normalizedInput.content.speaker_count,
              contentTitle: normalizedInput.content.title,
              contentContext: normalizedInput.content.context,
              topic: normalizedInput.content.topic,
              customVocabulary: normalizedInput.content.custom_vocabulary,
              rightsConfirmedAt: new Date(),
              strategyConfig: normalizedInput.strategy as never,
              visualConfig: normalizedInput.visual as never,
              subtitleConfig: normalizedInput.subtitle as never,
              providerConfigSnapshot: normalizedInput.ai as never
            }
          }
        }
      });
      return created;
    });

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start(resolveFoundationWorkflowName("AUTO_CLIPPING"), {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: "AUTO_CLIPPING",
            input_snapshot: normalizedInput,
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
      include: {
        attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
        autoClipRequest: true,
        sourceMediaAsset: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            objectKey: true,
            metadata: true,
          },
        },
      }
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

    if (!["FAILED", "NEEDS_REVIEW"].includes(job.status)) {
      throw new ConflictError(
        "JOB_NOT_RETRYABLE",
        "Only failed or needs-review jobs can be retried."
      );
    }

    const retryInputSnapshot = await resolveRunnableAutoClipSnapshot({
      inputSnapshot: job.inputSnapshot,
      autoClipRequest: job.autoClipRequest,
      sourceMediaAsset: job.sourceMediaAsset,
    });
    assertRunnableAutoClipSource(retryInputSnapshot);
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
          inputSnapshot: retryInputSnapshot as never,
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
      const handle = await client.workflow.start(resolveFoundationWorkflowName(job.type), {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: job.type,
            input_snapshot: retryInputSnapshot,
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
    const job = await prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: {
        autoClipRequest: true,
        sourceMediaAsset: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            objectKey: true,
            metadata: true,
          },
        },
      }
    });
    if (!job || job.type !== "AUTO_CLIPPING") throw new NotFoundError("Auto clipping job");
    return this.createAutoClippingJob({
      userId,
      idempotencyKey,
      input: await resolveRunnableAutoClipSnapshot({
        inputSnapshot: job.inputSnapshot,
        autoClipRequest: job.autoClipRequest,
        sourceMediaAsset: job.sourceMediaAsset,
      }) as unknown as CreateAutoClipInput
    });
  }

  public async regenerateAutoClippingJob(params: {
    userId: string;
    jobId: string;
    idempotencyKey: string;
    input: RegenerateAutoClipInput;
  }) {
    const job = await prisma.job.findFirst({
      where: { id: params.jobId, userId: params.userId, type: "AUTO_CLIPPING", deletedAt: null },
      include: {
        attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
        autoClipRequest: true,
        clipOutputs: {
          include: {
            mediaAsset: true,
            subtitles: true,
          },
        },
        transcripts: true,
        errors: true,
        sourceMediaAsset: {
          include: {
            sourceJobs: {
              select: { id: true },
              take: 2,
            },
          },
        },
      }
    });
    if (!job) throw new NotFoundError("Auto clipping job");
    if (!canRegenerateJob(job.status)) {
      throw new ConflictError("JOB_NOT_REGENERATABLE", `A ${job.status} job cannot be regenerated yet.`);
    }

    const existingAttempt = await prisma.jobAttempt.findUnique({
      where: {
        jobId_operationKey_idempotencyKey: {
          jobId: job.id,
          operationKey: REGENERATE_JOB_ATTEMPT_OPERATION_KEY,
          idempotencyKey: params.idempotencyKey
        }
      }
    });
    if (existingAttempt) {
      return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    }

    const runnableSnapshot = await resolveRunnableAutoClipSnapshot({
      inputSnapshot: job.inputSnapshot,
      autoClipRequest: job.autoClipRequest,
      sourceMediaAsset: job.sourceMediaAsset,
    }) as unknown as CreateAutoClipInput;
    assertRunnableAutoClipSource(runnableSnapshot as unknown as Record<string, unknown>);
    const nextInput = await prepareAutoClippingInput(
      params.userId,
      buildRegeneratedAutoClippingInput(runnableSnapshot, params.input)
    );
    if (nextInput.source.media_asset_id) {
      const asset = await prisma.mediaAsset.findFirst({
        where: {
          id: nextInput.source.media_asset_id,
          userId: params.userId,
          deletedAt: null,
          status: "READY",
        },
      });
      if (!asset) {
        throw new ConflictError(
          "SOURCE_MEDIA_ASSET_UNAVAILABLE",
          "The source media asset is no longer available for regenerate. Use the preserved source URL or upload the source again."
        );
      }
    }
    const attemptNumber = (job.attempts[0]?.attemptNumber ?? 0) + 1;
    const workflowId = `${job.id}:attempt:${attemptNumber}`;
    const cleanup = collectGeneratedArtifactsForJob(job);

    await prisma.$transaction(async (tx) => {
      await resetJobRuntimeStateForRegeneration(tx, job.id);

      if (cleanup.generatedMediaAssetIds.length > 0) {
        await tx.mediaAsset.deleteMany({
          where: {
            id: { in: cleanup.generatedMediaAssetIds },
            userId: params.userId,
          },
        });
      }

      await tx.transcriptSegment.deleteMany({
        where: {
          transcript: {
            jobId: job.id,
          },
        },
      });
      await tx.transcript.deleteMany({
        where: {
          jobId: job.id,
        },
      });
      await tx.clipOutput.deleteMany({
        where: {
          jobId: job.id,
        },
      });
      await tx.clipCandidate.deleteMany({
        where: {
          jobId: job.id,
        },
      });

      if (
        cleanup.deletableSourceMediaAssetId
        && cleanup.deletableSourceMediaAssetId !== nextInput.source.media_asset_id
      ) {
        await tx.mediaAsset.delete({
          where: { id: cleanup.deletableSourceMediaAssetId },
        });
      }

      await tx.job.update({
        where: { id: job.id },
        data: {
          projectId: nextInput.project_id ?? null,
          sourceMediaAssetId: nextInput.source.media_asset_id ?? null,
          status: "QUEUED",
          currentStage: "VALIDATING_SOURCE",
          workflowId,
          workflowRunId: null,
          progressPercent: 0,
          completedAt: null,
          outputSummary: Prisma.JsonNull,
          inputSnapshot: nextInput as never,
          version: { increment: 1 },
          autoClipRequest: {
            update: {
              sourceMediaAssetId: nextInput.source.media_asset_id ?? null,
              sourceType: nextInput.source.type,
              sourceUrl: nextInput.source.url ?? null,
              sourceLanguage: nextInput.content.source_language ?? null,
              speakerCount: nextInput.content.speaker_count ?? null,
              contentTitle: nextInput.content.title ?? null,
              contentContext: nextInput.content.context ?? null,
              topic: nextInput.content.topic ?? null,
              customVocabulary: nextInput.content.custom_vocabulary as never,
              rightsConfirmedAt: new Date(),
              strategyConfig: nextInput.strategy as never,
              visualConfig: nextInput.visual as never,
              subtitleConfig: nextInput.subtitle as never,
              providerConfigSnapshot: nextInput.ai as never,
            }
          },
          attempts: {
            create: {
              attemptNumber,
              status: "CREATED",
              operationKey: REGENERATE_JOB_ATTEMPT_OPERATION_KEY,
              idempotencyKey: params.idempotencyKey,
              reason: "Regenerated from successful job detail",
              workflowId
            }
          }
        }
      });
    });

    if (cleanup.objectKeysToDelete.length > 0) {
      try {
        await deleteObjectKeys(cleanup.objectKeysToDelete);
      } catch (_error) {
        // Storage cleanup should not block regeneration of a successful job.
      }
    }

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start(resolveFoundationWorkflowName("AUTO_CLIPPING"), {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: "AUTO_CLIPPING",
            input_snapshot: nextInput,
            callback_base_url: env.WEB_INTERNAL_BASE_URL,
            attempt_number: attemptNumber
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
            code: "TEMPORAL_REGENERATE_START_FAILED",
            category: "INFRASTRUCTURE_TEMPORARY",
            retryable: true,
            message: error instanceof Error ? error.message : String(error),
            userMessage: "The regenerate workflow could not be started. Try again when Temporal is available."
          }
        })
      ]);
      throw new AppError({
        code: "TEMPORAL_REGENERATE_START_FAILED",
        message: "The regenerate workflow could not be started.",
        statusCode: 503,
        retryable: true,
        details: { technical_error_id: technicalErrorId },
        cause: error
      });
    }
  }

  public async regenerateTextToSpeechJob(params: {
    userId: string;
    jobId: string;
    idempotencyKey: string;
    input: RegenerateTtsInput;
  }) {
    const job = await prisma.job.findFirst({
      where: { id: params.jobId, userId: params.userId, type: "TEXT_TO_SPEECH", deletedAt: null },
      include: {
        attempts: { orderBy: { attemptNumber: "desc" }, take: 1 },
        ttsRequest: {
          include: {
            outputs: {
              include: {
                mediaAsset: true,
              },
            },
          },
        },
        errors: true,
      }
    });
    if (!job || !job.ttsRequest) throw new NotFoundError("TTS job");
    if (!canRegenerateJob(job.status)) {
      throw new ConflictError("JOB_NOT_REGENERATABLE", `A ${job.status} job cannot be regenerated yet.`);
    }

    const existingAttempt = await prisma.jobAttempt.findUnique({
      where: {
        jobId_operationKey_idempotencyKey: {
          jobId: job.id,
          operationKey: REGENERATE_JOB_ATTEMPT_OPERATION_KEY,
          idempotencyKey: params.idempotencyKey
        }
      }
    });
    if (existingAttempt) {
      return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    }

    const currentSnapshot = toTtsSnapshot(job.inputSnapshot);
    const nextInput = prepareTtsInput(buildRegeneratedTtsInput(currentSnapshot, params.input));
    const attemptNumber = (job.attempts[0]?.attemptNumber ?? 0) + 1;
    const workflowId = `${job.id}:attempt:${attemptNumber}`;
    const generatedMediaAssetIds = job.ttsRequest.outputs
      .map((output) => output.mediaAssetId)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const objectKeysToDelete = job.ttsRequest.outputs
      .map((output) => output.mediaAsset?.objectKey ?? null)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    await prisma.$transaction(async (tx) => {
      await resetJobRuntimeStateForRegeneration(tx, job.id);

      if (generatedMediaAssetIds.length > 0) {
        await tx.mediaAsset.deleteMany({
          where: {
            id: { in: generatedMediaAssetIds },
            userId: params.userId,
          },
        });
      }

      await tx.job.update({
        where: { id: job.id },
        data: {
          projectId: nextInput.project_id ?? null,
          status: "QUEUED",
          currentStage: "VALIDATING_SCRIPT",
          workflowId,
          workflowRunId: null,
          progressPercent: 0,
          completedAt: null,
          outputSummary: Prisma.JsonNull,
          inputSnapshot: nextInput as never,
          version: { increment: 1 },
          ttsRequest: {
            update: {
              script: nextInput.script,
              language: nextInput.language,
              providerId: nextInput.ai.provider_id ?? null,
              modelId: nextInput.ai.model_id ?? null,
              voiceIdentifier: nextInput.voice_identifier ?? null,
              speakingStyle: nextInput.speaking_style ?? null,
              emotion: nextInput.emotion ?? null,
              speakingSpeed: typeof nextInput.speaking_speed === "number" ? nextInput.speaking_speed : null,
              pitch: typeof nextInput.pitch === "number" ? nextInput.pitch : null,
              pauseIntensity: typeof nextInput.pause_intensity === "number" ? nextInput.pause_intensity : null,
              targetDurationMs:
                typeof nextInput.target_duration_ms === "number" ? BigInt(nextInput.target_duration_ms) : null,
              pronunciationDictionary: nextInput.pronunciation_dictionary as never,
              outputConfig: {
                ...nextInput.output_config,
                user_preferences: nextInput.user_preferences
              } as never,
            }
          },
          attempts: {
            create: {
              attemptNumber,
              status: "CREATED",
              operationKey: REGENERATE_JOB_ATTEMPT_OPERATION_KEY,
              idempotencyKey: params.idempotencyKey,
              reason: "Regenerated from successful job detail",
              workflowId
            }
          }
        }
      });
    });

    if (objectKeysToDelete.length > 0) {
      try {
        await deleteObjectKeys(objectKeysToDelete);
      } catch (_error) {
        // Storage cleanup should not block regeneration of a successful job.
      }
    }

    try {
      const client = await temporalClient();
      const handle = await client.workflow.start(resolveFoundationWorkflowName("TEXT_TO_SPEECH"), {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [
          {
            job_id: job.id,
            user_id: params.userId,
            job_type: "TEXT_TO_SPEECH",
            input_snapshot: nextInput,
            callback_base_url: env.WEB_INTERNAL_BASE_URL,
            attempt_number: attemptNumber
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
            code: "TEMPORAL_REGENERATE_START_FAILED",
            category: "INFRASTRUCTURE_TEMPORARY",
            retryable: true,
            message: error instanceof Error ? error.message : String(error),
            userMessage: "The regenerate workflow could not be started. Try again when Temporal is available."
          }
        })
      ]);
      throw new AppError({
        code: "TEMPORAL_REGENERATE_START_FAILED",
        message: "The regenerate workflow could not be started.",
        statusCode: 503,
        retryable: true,
        details: { technical_error_id: technicalErrorId },
        cause: error
      });
    }
  }

  public async delete(userId: string, jobId: string) {
    const job = await prisma.job.findFirst({
      where: { id: jobId, userId, deletedAt: null },
      include: {
        autoClipRequest: true,
        clipOutputs: {
          include: {
            mediaAsset: true,
            subtitles: true,
          },
        },
        transcripts: true,
        ttsRequest: {
          include: {
            outputs: {
              include: {
                mediaAsset: true,
              },
            },
          },
        },
        errors: true,
        sourceMediaAsset: {
          include: {
            sourceJobs: {
              select: { id: true },
              take: 2,
            },
          },
        },
      },
    });
    if (!job) throw new NotFoundError("Job");
    if (!canDeleteJob(job.status)) {
      throw new ConflictError("JOB_NOT_DELETABLE", `A ${job.status} job cannot be deleted yet.`);
    }

    const clipOutputMediaAssetIds = job.clipOutputs
      .map((clipOutput) => clipOutput.mediaAssetId)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const subtitleMediaAssetIds = job.clipOutputs
      .flatMap((clipOutput) => clipOutput.subtitles.map((subtitle) => subtitle.mediaAssetId))
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const ttsMediaAssetIds = job.ttsRequest?.outputs
      .map((output) => output.mediaAssetId)
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];

    const generatedMediaAssetIds = [...new Set([...clipOutputMediaAssetIds, ...subtitleMediaAssetIds, ...ttsMediaAssetIds])];

    const objectKeysToDelete = [
      ...job.clipOutputs.flatMap((clipOutput) => [
        clipOutput.previewObjectKey,
        clipOutput.finalObjectKey,
        clipOutput.metadataObjectKey,
        clipOutput.thumbnailObjectKey,
        clipOutput.mediaAsset?.objectKey ?? null,
        ...clipOutput.subtitles.map((subtitle) => subtitle.objectKey),
      ]),
      ...job.transcripts.flatMap((transcript) => [transcript.rawObjectKey, transcript.normalizedObjectKey]),
      ...(job.ttsRequest?.outputs.flatMap((output) => [output.mediaAsset?.objectKey ?? null]) ?? []),
      ...job.errors.map((error) => error.stackObjectKey),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    const deletableSourceMediaAssetId = shouldDeleteJobSourceMediaAsset(job)
      ? job.sourceMediaAssetId
      : null;
    if (deletableSourceMediaAssetId && job.sourceMediaAsset?.objectKey) {
      objectKeysToDelete.push(job.sourceMediaAsset.objectKey);
    }

    await prisma.$transaction(async (tx) => {
      if (generatedMediaAssetIds.length > 0) {
        await tx.mediaAsset.deleteMany({
          where: {
            id: { in: generatedMediaAssetIds },
            userId,
          },
        });
      }

      await tx.transcriptSegment.deleteMany({
        where: {
          transcript: {
            jobId: job.id,
          },
        },
      });
      await tx.transcript.deleteMany({
        where: {
          jobId: job.id,
        },
      });

      if (deletableSourceMediaAssetId) {
        await tx.mediaAsset.delete({
          where: { id: deletableSourceMediaAssetId },
        });
      }

      await tx.job.delete({
        where: { id: job.id },
      });
    });

    await deleteObjectKeys(objectKeysToDelete);

    return {
      jobId: job.id,
      deletedObjectCount: [...new Set(objectKeysToDelete)].length,
      deletedGeneratedMediaAssetCount: generatedMediaAssetIds.length + (deletableSourceMediaAssetId ? 1 : 0),
    };
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
    const result = await prisma.$transaction(async (tx) => {
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
      const createdClipOutputIds: string[] = [];

      let createdCount = 0;
      for (const candidate of job.clipCandidates) {
        if (existingCandidateIds.has(candidate.id)) {
          continue;
        }
        const created = await tx.clipOutput.create({
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
        createdClipOutputIds.push(created.id);
        createdCount += 1;
      }

      const selectedCount = job.clipCandidates.length;
      return {
        jobId: job.id,
        selectedCount,
        createdCount,
        existingCount: selectedCount - createdCount,
        createdClipOutputIds
      };
    });

    let startedWorkflowCount = 0;
    if (result.createdClipOutputIds.length > 0) {
      const client = await temporalClient();
      for (const clipOutputId of result.createdClipOutputIds) {
        await startClipOutputRenderWorkflow(client, clipOutputId, buildClipOutputRenderWorkflowId(clipOutputId));
        startedWorkflowCount += 1;
      }
    }

    return {
      jobId: result.jobId,
      selectedCount: result.selectedCount,
      createdCount: result.createdCount,
      existingCount: result.existingCount,
      startedWorkflowCount
    } satisfies QueueSelectedClipOutputsResult;
  }

  public async rerenderClipOutput(params: RerenderClipOutputInput) {
    const clipOutput = await prisma.clipOutput.findFirst({
      where: {
        id: params.clipOutputId,
        jobId: params.jobId,
        deletedAt: null,
        job: {
          userId: params.userId,
          deletedAt: null
        }
      }
    });
    if (!clipOutput) throw new NotFoundError("Clip output");

    const updated = await prisma.clipOutput.update({
      where: { id: clipOutput.id },
      data: {
        qualityStatus: "PENDING",
        qualityReport: {
          rerender_requested_at: new Date().toISOString(),
          previous_quality_status: clipOutput.qualityStatus
        } as never
      }
    });

    const client = await temporalClient();
    await startClipOutputRenderWorkflow(client, clipOutput.id, buildClipOutputRerenderWorkflowId(clipOutput.id));

    return {
      clipOutputId: updated.id,
      qualityStatus: updated.qualityStatus
    };
  }

  public async createClipOutputArtifactUrl(
    userId: string,
    jobId: string,
    clipOutputId: string,
    artifact: ClipOutputArtifact,
    publicOrigin?: string
  ) {
    const clipOutput = await prisma.clipOutput.findFirst({
      where: {
        id: clipOutputId,
        jobId,
        deletedAt: null,
        job: {
          userId,
          deletedAt: null
        }
      },
      include: {
        subtitles: {
          where: { mediaAsset: { deletedAt: null } },
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (!clipOutput) throw new NotFoundError("Clip output");

    const objectKey = resolveClipOutputArtifactObjectKey(clipOutput, artifact);
    if (!objectKey) {
      throw new ConflictError(
        "CLIP_OUTPUT_ARTIFACT_UNAVAILABLE",
        `${artifactLabel(artifact)} is not available for this clip output yet.`
      );
    }

    return createPublicSignedObjectReadUrl(objectKey, undefined, publicOrigin);
  }

  public async createClipOutputExportIndex(
    userId: string,
    jobId: string,
    clipOutputId: string,
    publicOrigin?: string
  ): Promise<ClipOutputExportIndex> {
    const clipOutput = await prisma.clipOutput.findFirst({
      where: {
        id: clipOutputId,
        jobId,
        deletedAt: null,
        job: {
          userId,
          deletedAt: null
        }
      },
      include: {
        subtitles: {
          where: { mediaAsset: { deletedAt: null } },
          orderBy: { createdAt: "desc" }
        }
      }
    });
    if (!clipOutput) throw new NotFoundError("Clip output");

    const artifacts: ClipOutputExportIndexItem[] = [];
    for (const artifact of [
      "preview",
      "final",
      "metadata",
      "subtitle",
      "subtitle_srt",
      "subtitle_ass",
      "subtitle_vtt",
      "subtitle_json"
    ] as const) {
      const objectKey = resolveClipOutputArtifactObjectKey(clipOutput, artifact);
      if (!objectKey) continue;
      artifacts.push({
        artifact,
        label: artifactLabel(artifact),
        url: await createPublicSignedObjectReadUrl(objectKey, undefined, publicOrigin)
      });
    }

    return {
      clipOutputId: clipOutput.id,
      jobId: clipOutput.jobId,
      candidateId: clipOutput.candidateId,
      qualityStatus: reconcileClipOutputQualityStatus({
        persistedQualityStatus: clipOutput.qualityStatus,
        qualityReport: clipOutput.qualityReport,
        hasFinalObject: Boolean(clipOutput.finalObjectKey)
      }),
      artifacts
    };
  }

  public async createJobOutputsExportIndex(
    userId: string,
    jobId: string,
    publicOrigin?: string
  ): Promise<JobOutputsExportIndex> {
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        userId,
        deletedAt: null
      },
      include: {
        clipOutputs: {
          where: { deletedAt: null },
          include: {
            subtitles: {
              where: { mediaAsset: { deletedAt: null } },
              orderBy: { createdAt: "desc" }
            }
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });
    if (!job) throw new NotFoundError("Job");

    const clipOutputs: JobOutputsExportIndexItem[] = [];
    for (const clipOutput of job.clipOutputs) {
      const artifacts: ClipOutputExportIndexItem[] = [];
      for (const artifact of [
        "preview",
        "final",
        "metadata",
        "subtitle",
        "subtitle_srt",
        "subtitle_ass",
        "subtitle_vtt",
        "subtitle_json"
      ] as const) {
        const objectKey = resolveClipOutputArtifactObjectKey(clipOutput, artifact);
        if (!objectKey) continue;
        artifacts.push({
          artifact,
          label: artifactLabel(artifact),
          url: await createPublicSignedObjectReadUrl(objectKey, undefined, publicOrigin)
        });
      }

      const reconciledQualityStatus = reconcileClipOutputQualityStatus({
        persistedQualityStatus: clipOutput.qualityStatus,
        qualityReport: clipOutput.qualityReport,
        hasFinalObject: Boolean(clipOutput.finalObjectKey)
      });
      clipOutputs.push({
        clipOutputId: clipOutput.id,
        candidateId: clipOutput.candidateId,
        qualityStatus: reconciledQualityStatus,
        artifacts
      });
    }

    return {
      jobId: job.id,
      status: reconcileJobOutputsStatus({
        persistedJobStatus: job.status,
        clipOutputStatuses: clipOutputs.map((clipOutput) => clipOutput.qualityStatus)
      }),
      clipOutputs
    };
  }

  public async createTtsSegmentationExport(
    userId: string,
    jobId: string
  ): Promise<TtsSegmentationExport> {
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        userId,
        type: "TEXT_TO_SPEECH",
        deletedAt: null
      },
      include: {
        ttsRequest: true
      }
    });
    if (!job) throw new NotFoundError("Job");

    const outputSummary =
      job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
        ? (job.outputSummary as Record<string, unknown>)
        : {};
    const ttsSummary =
      outputSummary.tts && typeof outputSummary.tts === "object" && !Array.isArray(outputSummary.tts)
        ? (outputSummary.tts as Record<string, unknown>)
        : {};
    const outputConfig =
      job.ttsRequest?.outputConfig && typeof job.ttsRequest.outputConfig === "object" && !Array.isArray(job.ttsRequest.outputConfig)
        ? (job.ttsRequest.outputConfig as Record<string, unknown>)
        : {};
    const document =
      ttsSummary.document && typeof ttsSummary.document === "object" && !Array.isArray(ttsSummary.document)
        ? (ttsSummary.document as Record<string, unknown>)
        : outputConfig.segmentation_document && typeof outputConfig.segmentation_document === "object" && !Array.isArray(outputConfig.segmentation_document)
          ? (outputConfig.segmentation_document as Record<string, unknown>)
          : {};
    const metadata =
      ttsSummary.metadata && typeof ttsSummary.metadata === "object" && !Array.isArray(ttsSummary.metadata)
        ? (ttsSummary.metadata as Record<string, unknown>)
        : outputConfig.segmentation_metadata && typeof outputConfig.segmentation_metadata === "object" && !Array.isArray(outputConfig.segmentation_metadata)
          ? (outputConfig.segmentation_metadata as Record<string, unknown>)
          : {};
    const inputSnapshot =
      job.inputSnapshot && typeof job.inputSnapshot === "object" && !Array.isArray(job.inputSnapshot)
        ? (job.inputSnapshot as Record<string, unknown>)
        : {};

    return {
      jobId: job.id,
      status: job.status,
      language: job.ttsRequest?.language ?? null,
      localModelKey:
        typeof inputSnapshot.local_model_key === "string" && inputSnapshot.local_model_key.trim().length > 0
          ? inputSnapshot.local_model_key.trim()
          : typeof outputConfig.local_model_key === "string" && outputConfig.local_model_key.trim().length > 0
            ? outputConfig.local_model_key.trim()
            : null,
      voiceIdentifier: job.ttsRequest?.voiceIdentifier ?? null,
      speakingStyle: job.ttsRequest?.speakingStyle ?? null,
      emotion: job.ttsRequest?.emotion ?? null,
      segmentCount:
        typeof ttsSummary.segment_count === "number"
          ? ttsSummary.segment_count
          : Array.isArray(document.segments)
            ? document.segments.length
            : 0,
      totalPauseMs: typeof ttsSummary.total_pause_ms === "number" ? ttsSummary.total_pause_ms : 0,
      metadata,
      document
    };
  }

  public async createTtsAudioArtifactUrl(
    userId: string,
    jobId: string,
    artifact: TtsOutputArtifact,
    publicOrigin?: string,
  ) {
    const ttsOutput = await prisma.ttsOutput.findFirst({
      where: {
        ttsRequest: {
          job: {
            id: jobId,
            userId,
            type: "TEXT_TO_SPEECH",
            deletedAt: null,
          },
        },
        mediaAsset: {
          deletedAt: null,
        },
      },
      include: {
        mediaAsset: true,
        ttsRequest: {
          include: {
            job: true,
          },
        },
      },
      orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    });
    if (!ttsOutput) throw new NotFoundError("TTS output");

    const objectKey = resolveTtsOutputArtifactObjectKey(ttsOutput, artifact);
    if (!objectKey) {
      throw new ConflictError(
        "TTS_OUTPUT_ARTIFACT_UNAVAILABLE",
        `${ttsOutputArtifactLabel(artifact)} is not available for this TTS job yet.`,
      );
    }

    return createPublicSignedObjectReadUrl(objectKey, undefined, publicOrigin);
  }

  public async createTtsOutputExportIndex(
    userId: string,
    jobId: string,
    publicOrigin?: string,
  ): Promise<TtsOutputExportIndex> {
    const job = await prisma.job.findFirst({
      where: {
        id: jobId,
        userId,
        type: "TEXT_TO_SPEECH",
        deletedAt: null,
      },
      include: {
        ttsRequest: {
          include: {
            outputs: {
              where: {
                mediaAsset: {
                  deletedAt: null,
                },
              },
              include: {
                mediaAsset: true,
              },
              orderBy: [{ version: "desc" }, { createdAt: "desc" }],
            },
          },
        },
      },
    });
    if (!job || !job.ttsRequest) throw new NotFoundError("TTS job");

    const latestOutput = job.ttsRequest.outputs[0] ?? null;
    const outputConfig =
      job.ttsRequest.outputConfig && typeof job.ttsRequest.outputConfig === "object" && !Array.isArray(job.ttsRequest.outputConfig)
        ? (job.ttsRequest.outputConfig as Record<string, unknown>)
        : {};
    const inputSnapshot =
      job.inputSnapshot && typeof job.inputSnapshot === "object" && !Array.isArray(job.inputSnapshot)
        ? (job.inputSnapshot as Record<string, unknown>)
        : {};

    const artifacts: TtsOutputExportIndexItem[] = [];
    if (latestOutput) {
      const objectKey = resolveTtsOutputArtifactObjectKey(latestOutput, "audio");
      if (objectKey) {
        artifacts.push({
          artifact: "audio",
          label: ttsOutputArtifactLabel("audio"),
          url: await createPublicSignedObjectReadUrl(objectKey, undefined, publicOrigin),
        });
      }
    }

    return {
      jobId: job.id,
      status: job.status,
      artifacts,
      language: job.ttsRequest.language,
      localModelKey:
        typeof inputSnapshot.local_model_key === "string" && inputSnapshot.local_model_key.trim().length > 0
          ? inputSnapshot.local_model_key.trim()
          : typeof outputConfig.local_model_key === "string" && outputConfig.local_model_key.trim().length > 0
            ? outputConfig.local_model_key.trim()
            : null,
      voiceIdentifier: job.ttsRequest.voiceIdentifier ?? null,
    };
  }
}

function prepareTtsInput(input: CreateTtsInput): CreateTtsInput {
  return {
    project_id: input.project_id,
    script: input.script.trim(),
    language: input.language.trim() || "id",
    local_model_key: input.local_model_key?.trim() || undefined,
    voice_identifier: input.voice_identifier?.trim() || undefined,
    speaking_style: input.speaking_style?.trim() || undefined,
    emotion: input.emotion?.trim() || undefined,
    speaking_speed: input.speaking_speed,
    pitch: input.pitch,
    pause_intensity: input.pause_intensity,
    target_duration_ms: input.target_duration_ms,
    pronunciation_dictionary: input.pronunciation_dictionary ?? {},
    output_config: input.output_config ?? {},
    user_preferences: input.user_preferences ?? {},
    ai: {
      credential_mode: input.ai.credential_mode,
      provider_id: input.ai.provider_id,
      model_id: input.ai.model_id
    }
  };
}

function buildRegeneratedAutoClippingInput(
  currentSnapshot: CreateAutoClipInput,
  input: RegenerateAutoClipInput
): CreateAutoClipInput {
  const currentStrategy =
    currentSnapshot.strategy && typeof currentSnapshot.strategy === "object" ? currentSnapshot.strategy : {};
  const currentVisual =
    currentSnapshot.visual && typeof currentSnapshot.visual === "object" ? currentSnapshot.visual : {};
  const currentVisualSettings =
    currentVisual.settings && typeof currentVisual.settings === "object" && !Array.isArray(currentVisual.settings)
      ? (currentVisual.settings as Record<string, unknown>)
      : {};
  const currentSubtitle =
    currentSnapshot.subtitle && typeof currentSnapshot.subtitle === "object" ? currentSnapshot.subtitle : {};
  const currentSubtitleSettings =
    currentSubtitle.settings && typeof currentSubtitle.settings === "object" && !Array.isArray(currentSubtitle.settings)
      ? (currentSubtitle.settings as Record<string, unknown>)
      : {};

  const subtitleExportFormats = normalizeSubtitleExportFormatList(
    input.subtitle_export_formats_text,
    input.subtitle_primary_format
  );

  return {
    project_id: currentSnapshot.project_id,
    source:
      currentSnapshot.source.type === "EXTERNAL_URL"
        ? {
            type: "EXTERNAL_URL",
            url: currentSnapshot.source.url
          }
        : currentSnapshot.source,
    content: {
      title: input.content_title,
      context: input.content_context,
      topic: input.topic,
      source_language: input.source_language,
      speaker_count: input.speaker_count,
      custom_vocabulary: input.custom_vocabulary_text,
      rights_confirmed: true
    },
    strategy: {
      ...currentStrategy,
      target_platform: input.target_platform,
      objective: input.objective,
      tones: input.tones_text.length > 0 ? input.tones_text : ["educational"],
      desired_clip_count: input.desired_clip_count ?? 3,
      candidate_pool_count: input.candidate_pool_count ?? Math.max(input.desired_clip_count ?? 3, 6),
      minimum_duration_seconds: input.minimum_duration_seconds ?? 20,
      maximum_duration_seconds: input.maximum_duration_seconds ?? 45,
      minimum_viral_score: input.minimum_viral_score ?? 7,
      preferred_topics: input.preferred_topics_text,
      topics_to_avoid: input.topics_to_avoid_text,
      sensitive_topics: input.sensitive_topics_text,
      clip_style_tags: input.clip_style_tags_text,
      virality_priorities: input.virality_priorities_text,
      selection_brief: input.selection_brief,
      avoidance_brief: input.avoidance_brief,
      packaging_brief: input.packaging_brief,
      hook_style: input.hook_style,
      cta_preference: input.cta_preference,
      standalone_priority: input.standalone_priority,
      require_spoken_audio: input.require_spoken_audio,
      profanity_handling: input.profanity_handling,
      remove_long_silence: input.remove_long_silence,
      remove_filler_words: input.remove_filler_words
    },
    visual: {
      ...currentVisual,
      aspect_ratio: input.aspect_ratio,
      crop_strategy: input.crop_strategy,
      settings: compactRecord({
        ...currentVisualSettings,
        layout_template: input.layout_template,
        podcast_source_enabled: input.podcast_source_enabled,
        podcast_spotlight_style: input.podcast_spotlight_style,
        headline_overlay_enabled: input.headline_overlay_enabled,
        headline_overlay_position: input.headline_overlay_position,
        framing_detection_mode: input.framing_detection_mode,
        split_on_multi_face: input.split_on_multi_face,
        split_min_face_count: input.split_min_face_count
      })
    },
    subtitle: {
      ...currentSubtitle,
      enabled: input.subtitle_enabled,
      language: input.subtitle_language,
      burn_in: input.subtitle_burn_in,
      format: input.subtitle_primary_format,
      export_formats: subtitleExportFormats,
      settings: compactRecord({
        ...currentSubtitleSettings,
        style: normalizeSubtitleStyle(input.subtitle_style),
        font_family: input.subtitle_font_family,
        position: input.subtitle_position,
        text_case: input.subtitle_text_case,
        max_lines: input.subtitle_max_lines,
        safe_margin_percent: input.subtitle_safe_margin_percent,
        word_highlight: subtitleStyleUsesWordHighlight(input.subtitle_style),
        profanity_censor: input.subtitle_profanity_censor
      })
    },
    ai:
      currentSnapshot.ai && typeof currentSnapshot.ai === "object" && !Array.isArray(currentSnapshot.ai)
        ? currentSnapshot.ai
        : { credential_mode: "PLATFORM" }
  };
}

function buildRegeneratedTtsInput(currentSnapshot: CreateTtsInput, input: RegenerateTtsInput): CreateTtsInput {
  return {
    project_id: currentSnapshot.project_id,
    script: input.script,
    language: input.language,
    local_model_key: input.local_model_key,
    voice_identifier: input.voice_identifier,
    speaking_style: input.speaking_style,
    emotion: input.emotion,
    speaking_speed: input.speaking_speed,
    pitch: input.pitch,
    pause_intensity: input.pause_intensity,
    target_duration_ms: input.target_duration_ms,
    pronunciation_dictionary: currentSnapshot.pronunciation_dictionary ?? {},
    output_config: compactRecord({
      ...(currentSnapshot.output_config ?? {}),
      preferred_format: input.preferred_format,
      segmentation_mode: input.segmentation_mode,
      sample_rate: input.sample_rate,
      channels: input.channels
    }),
    user_preferences: compactRecord({
      ...(currentSnapshot.user_preferences ?? {}),
      tone_notes: input.tone_notes,
      delivery_goal: input.delivery_goal,
      segment_length_preference: input.segment_length_preference,
      breathing_style: input.breathing_style
    }),
    ai:
      currentSnapshot.ai && typeof currentSnapshot.ai === "object" && !Array.isArray(currentSnapshot.ai)
        ? currentSnapshot.ai
        : { credential_mode: "PLATFORM" }
  };
}

function toTtsSnapshot(inputSnapshot: unknown): CreateTtsInput {
  const snapshot =
    inputSnapshot && typeof inputSnapshot === "object" && !Array.isArray(inputSnapshot)
      ? (inputSnapshot as Record<string, unknown>)
      : {};
  return {
    project_id: typeof snapshot.project_id === "string" ? snapshot.project_id : undefined,
    script: typeof snapshot.script === "string" ? snapshot.script : "",
    language: typeof snapshot.language === "string" ? snapshot.language : "id",
    local_model_key: typeof snapshot.local_model_key === "string" ? snapshot.local_model_key : undefined,
    voice_identifier: typeof snapshot.voice_identifier === "string" ? snapshot.voice_identifier : undefined,
    speaking_style: typeof snapshot.speaking_style === "string" ? snapshot.speaking_style : undefined,
    emotion: typeof snapshot.emotion === "string" ? snapshot.emotion : undefined,
    speaking_speed: typeof snapshot.speaking_speed === "number" ? snapshot.speaking_speed : undefined,
    pitch: typeof snapshot.pitch === "number" ? snapshot.pitch : undefined,
    pause_intensity: typeof snapshot.pause_intensity === "number" ? snapshot.pause_intensity : undefined,
    target_duration_ms: typeof snapshot.target_duration_ms === "number" ? snapshot.target_duration_ms : undefined,
    pronunciation_dictionary:
      snapshot.pronunciation_dictionary && typeof snapshot.pronunciation_dictionary === "object" && !Array.isArray(snapshot.pronunciation_dictionary)
        ? (snapshot.pronunciation_dictionary as Record<string, string>)
        : {},
    output_config:
      snapshot.output_config && typeof snapshot.output_config === "object" && !Array.isArray(snapshot.output_config)
        ? (snapshot.output_config as Record<string, unknown>)
        : {},
    user_preferences:
      snapshot.user_preferences && typeof snapshot.user_preferences === "object" && !Array.isArray(snapshot.user_preferences)
        ? (snapshot.user_preferences as Record<string, unknown>)
        : {},
    ai:
      snapshot.ai && typeof snapshot.ai === "object" && !Array.isArray(snapshot.ai)
        ? (snapshot.ai as { credential_mode: "PLATFORM" | "USER_OWNED"; provider_id?: string; model_id?: string })
        : { credential_mode: "PLATFORM" }
  };
}

async function resetJobRuntimeStateForRegeneration(tx: Prisma.TransactionClient, jobId: string) {
  await tx.jobStage.deleteMany({ where: { jobId } });
  await tx.jobEvent.deleteMany({ where: { jobId } });
  await tx.jobError.deleteMany({ where: { jobId } });
}

function normalizeSubtitleExportFormatList(
  values: string[],
  primaryFormat: "SRT" | "VTT" | "ASS" | "JSON"
): Array<"SRT" | "VTT" | "ASS" | "JSON"> {
  const normalized = values
    .map((value) => String(value).trim().toUpperCase())
    .filter((value): value is "SRT" | "VTT" | "ASS" | "JSON" => ["SRT", "VTT", "ASS", "JSON"].includes(value));
  return [...new Set([primaryFormat, ...normalized])];
}

function collectGeneratedArtifactsForJob(job: {
  id: string;
  sourceMediaAssetId: string | null;
  autoClipRequest: { sourceType: string } | null;
  clipOutputs: Array<{
    mediaAssetId: string | null;
    previewObjectKey: string | null;
    finalObjectKey: string | null;
    metadataObjectKey: string | null;
    thumbnailObjectKey: string | null;
    mediaAsset: { objectKey: string } | null;
    subtitles: Array<{ mediaAssetId: string; objectKey: string }>;
  }>;
  transcripts: Array<{ rawObjectKey: string | null; normalizedObjectKey: string | null }>;
  errors: Array<{ stackObjectKey: string | null }>;
  sourceMediaAsset: { objectKey: string; sourceJobs: Array<{ id: string }> } | null;
}) {
  const clipOutputMediaAssetIds = job.clipOutputs
    .map((clipOutput) => clipOutput.mediaAssetId)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const subtitleMediaAssetIds = job.clipOutputs
    .flatMap((clipOutput) => clipOutput.subtitles.map((subtitle) => subtitle.mediaAssetId))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const generatedMediaAssetIds = [...new Set([...clipOutputMediaAssetIds, ...subtitleMediaAssetIds])];

  const objectKeysToDelete = [
    ...job.clipOutputs.flatMap((clipOutput) => [
      clipOutput.previewObjectKey,
      clipOutput.finalObjectKey,
      clipOutput.metadataObjectKey,
      clipOutput.thumbnailObjectKey,
      clipOutput.mediaAsset?.objectKey ?? null,
      ...clipOutput.subtitles.map((subtitle) => subtitle.objectKey),
    ]),
    ...job.transcripts.flatMap((transcript) => [transcript.rawObjectKey, transcript.normalizedObjectKey]),
    ...job.errors.map((error) => error.stackObjectKey),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const deletableSourceMediaAssetId = shouldDeleteJobSourceMediaAsset(job)
    ? job.sourceMediaAssetId
    : null;
  if (deletableSourceMediaAssetId && job.sourceMediaAsset?.objectKey) {
    objectKeysToDelete.push(job.sourceMediaAsset.objectKey);
  }

  return {
    generatedMediaAssetIds,
    objectKeysToDelete: [...new Set(objectKeysToDelete)],
    deletableSourceMediaAssetId,
  };
}

function resolveFoundationWorkflowName(jobType: string): string {
  if (jobType === "TEXT_TO_SPEECH") return "FoundationTextToSpeechWorkflow";
  return "FoundationAutoClippingWorkflow";
}

function canDeleteJob(status: string) {
  return ["DRAFT", "FAILED", "COMPLETED", "PARTIALLY_COMPLETED", "CANCELED", "NEEDS_REVIEW"].includes(status);
}

function canRegenerateJob(status: string) {
  return ["COMPLETED", "PARTIALLY_COMPLETED"].includes(status);
}

function shouldDeleteJobSourceMediaAsset(job: {
  id: string;
  sourceMediaAssetId: string | null;
  sourceMediaAsset: { objectKey: string; sourceJobs: Array<{ id: string }> } | null;
}) {
  if (!job.sourceMediaAssetId || !job.sourceMediaAsset) return false;
  if (job.sourceMediaAsset.sourceJobs.length > 1) return false;
  return true;
}

function normalizeLayoutTemplate(layoutTemplate: string | undefined, aspectRatio: string | undefined): string {
  if (aspectRatio !== "9:16") {
    return "STANDARD";
  }
  return layoutTemplate === "PODCAST_SPOTLIGHT_9X16" ? "PODCAST_SPOTLIGHT_9X16" : "STANDARD";
}

async function resolveAutoClipBrandingContext(userId: string, visualSettings: Record<string, unknown>) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      displayName: true,
      setting: {
        select: {
          preferences: true
        }
      }
    }
  });
  const preferences =
    user?.setting?.preferences && typeof user.setting.preferences === "object" && !Array.isArray(user.setting.preferences)
      ? (user.setting.preferences as Record<string, unknown>)
      : {};
  const preferredBrandKitId =
    typeof preferences.preferred_brand_kit_id === "string" ? preferences.preferred_brand_kit_id.trim() : "";
  const requestedBrandKitId =
    typeof visualSettings.brand_kit_id === "string" ? visualSettings.brand_kit_id.trim() : "";
  const brandKitId = requestedBrandKitId || preferredBrandKitId;
  const brandKit = brandKitId
    ? await prisma.brandKit.findFirst({
        where: { id: brandKitId, userId, deletedAt: null },
        select: { id: true, name: true, logoObjectKey: true }
      })
    : await prisma.brandKit.findFirst({
        where: { userId, deletedAt: null, isDefault: true },
        select: { id: true, name: true, logoObjectKey: true }
      });
  const channelName =
    typeof preferences.channel_name === "string" && preferences.channel_name.trim().length > 0
      ? preferences.channel_name.trim()
      : user?.displayName ?? "Creator";
  const channelTagline =
    typeof preferences.channel_tagline === "string" && preferences.channel_tagline.trim().length > 0
      ? preferences.channel_tagline.trim()
      : null;
  const directLogoObjectKey =
    typeof preferences.channel_logo_object_key === "string" && preferences.channel_logo_object_key.trim().length > 0
      ? preferences.channel_logo_object_key.trim()
      : null;
  const directLogoUrl = directLogoObjectKey ? await createPublicSignedObjectReadUrl(directLogoObjectKey) : null;
  const directLogoInternalUrl = directLogoObjectKey ? await createInternalSignedObjectReadUrl(directLogoObjectKey) : null;
  const brandKitLogoUrl = brandKit?.logoObjectKey ? await createPublicSignedObjectReadUrl(brandKit.logoObjectKey) : null;
  const brandKitLogoInternalUrl = brandKit?.logoObjectKey
    ? await createInternalSignedObjectReadUrl(brandKit.logoObjectKey)
    : null;

  return compactRecord({
    channel_name: channelName,
    channel_tagline: channelTagline,
    brand_kit_id: brandKit?.id ?? null,
    brand_kit_name: brandKit?.name ?? null,
    logo_object_key: directLogoObjectKey ?? brandKit?.logoObjectKey ?? null,
    logo_url: directLogoUrl ?? brandKitLogoUrl,
    logo_internal_url: directLogoInternalUrl ?? brandKitLogoInternalUrl
  });
}

function compactRecord(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export async function prepareAutoClippingInput(userId: string, input: CreateAutoClipInput): Promise<CreateAutoClipInput> {
  const normalizedSource =
    input.source.type === "EXTERNAL_URL" && input.source.url
      ? {
          ...input.source,
          url: await validateExternalSourceUrl(input.source.url)
        }
      : input.source;

  const visual =
    input.visual && typeof input.visual === "object" && !Array.isArray(input.visual)
      ? { ...input.visual }
      : {};
  const visualSettings =
    visual.settings && typeof visual.settings === "object" && !Array.isArray(visual.settings)
      ? { ...(visual.settings as Record<string, unknown>) }
      : {};
  const layoutTemplate = normalizeLayoutTemplate(
    typeof visualSettings.layout_template === "string" ? visualSettings.layout_template : undefined,
    typeof visual.aspect_ratio === "string" ? visual.aspect_ratio : undefined
  );
  const headlineOverlayEnabled =
    visual.aspect_ratio === "9:16"
    && layoutTemplate === "STANDARD"
    && visualSettings.headline_overlay_enabled !== false;
  const headlineOverlayPosition = visualSettings.headline_overlay_position === "TOP" ? "TOP" : "BOTTOM";
  const podcastSourceEnabled = visualSettings.podcast_source_enabled !== false;
  const podcastSpotlightStyle =
    visualSettings.podcast_spotlight_style === "VIDEO_FIRST" ? "VIDEO_FIRST" : "EDITORIAL_GOLD";
  const cropStrategy = layoutTemplate === "PODCAST_SPOTLIGHT_9X16" ? "SMART_SPEAKER" : visual.crop_strategy;
  const branding = await resolveAutoClipBrandingContext(userId, visualSettings);
  const analyzerRuntime = await resolveAutoClipAnalyzerRuntimeSnapshot();
  const sourceQuality = await resolveAutoClipSourceQualitySnapshot();
  const ai =
    input.ai && typeof input.ai === "object" && !Array.isArray(input.ai)
      ? { ...input.ai }
      : {};

  return {
    ...input,
    source: {
      ...normalizedSource,
      download_quality: sourceQuality
    },
    visual: {
      ...visual,
      crop_strategy: cropStrategy,
      settings: compactRecord({
        ...visualSettings,
        layout_template: layoutTemplate,
        podcast_source_enabled: podcastSourceEnabled,
        podcast_spotlight_style: podcastSpotlightStyle,
        headline_overlay_enabled: headlineOverlayEnabled,
        headline_overlay_position: headlineOverlayPosition,
        branding
      })
    },
    ai: compactRecord({
      ...ai,
      analyzer_runtime: analyzerRuntime
    })
  } as CreateAutoClipInput;
}

async function resolveAutoClipAnalyzerRuntimeSnapshot() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: AUTO_CLIP_ANALYZER_RUNTIME_KEY },
    select: { value: true }
  });

  return buildAutoClipAnalyzerRuntimeSettingValue(setting?.value as Prisma.JsonValue | undefined);
}

async function resolveAutoClipSourceQualitySnapshot() {
  const setting = await prisma.systemSetting.findUnique({
    where: { key: AUTO_CLIP_SOURCE_QUALITY_KEY },
    select: { value: true }
  });

  return buildAutoClipSourceQualitySettingValue(setting?.value as Prisma.JsonValue | undefined);
}

function restoreExternalSourceSnapshot(
  inputSnapshot: unknown,
  autoClipRequest:
    | {
        sourceType: string;
        sourceUrl: string | null;
      }
    | null
    | undefined,
  sourceMediaAssetMetadata?: unknown,
): Record<string, unknown> {
  const snapshot =
    inputSnapshot && typeof inputSnapshot === "object" && !Array.isArray(inputSnapshot)
      ? { ...(inputSnapshot as Record<string, unknown>) }
      : {};
  const source =
    snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
      ? { ...(snapshot.source as Record<string, unknown>) }
      : {};

  const snapshotUrl = typeof source.url === "string" && source.url.trim().length > 0
    ? source.url.trim()
    : null;
  const requestUrl = autoClipRequest?.sourceType === "EXTERNAL_URL" && autoClipRequest.sourceUrl
    ? autoClipRequest.sourceUrl.trim()
    : null;
  const metadataUrl = extractExternalSourceUrlFromMetadata(sourceMediaAssetMetadata);
  const sourceUrl = requestUrl || snapshotUrl || metadataUrl;

  if (!sourceUrl) {
    return snapshot;
  }

  return {
    ...snapshot,
    source: {
      ...source,
      type: "EXTERNAL_URL",
      url: sourceUrl,
      media_asset_id:
        typeof source.media_asset_id === "string" && source.media_asset_id.trim().length > 0
          ? source.media_asset_id
          : undefined
    }
  };
}

function restoreRunnableAutoClipSnapshot(params: {
  inputSnapshot: unknown;
  autoClipRequest:
    | {
        sourceType: string;
        sourceUrl: string | null;
      }
    | null
    | undefined;
  sourceMediaAsset:
    | {
        id: string;
        status: string;
        deletedAt: Date | null;
        objectKey: string;
        metadata: unknown;
      }
    | null
    | undefined;
  sourceObjectAvailable?: boolean;
}) {
  const snapshot = restoreExternalSourceSnapshot(
    params.inputSnapshot,
    params.autoClipRequest,
    params.sourceMediaAsset?.metadata,
  );
  const source =
    snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
      ? { ...(snapshot.source as Record<string, unknown>) }
      : {};
  const reusableMediaAssetId =
    params.sourceMediaAsset
    && params.sourceMediaAsset.deletedAt === null
    && params.sourceMediaAsset.status === "READY"
    && params.sourceObjectAvailable !== false
      ? params.sourceMediaAsset.id
      : null;
  const externalSourceUrl =
    typeof source.url === "string" && source.url.trim().length > 0
      ? source.url.trim()
      : null;

  if (externalSourceUrl) {
    return {
      ...snapshot,
      source: {
        ...source,
        type: "EXTERNAL_URL",
        url: externalSourceUrl,
        media_asset_id: reusableMediaAssetId ?? undefined,
      },
    };
  }

  if (!reusableMediaAssetId) {
    return {
      ...snapshot,
      source: {
        ...source,
        media_asset_id: undefined,
      },
    };
  }

  return {
    ...snapshot,
    source: {
      ...source,
      type: "MEDIA_ASSET",
      media_asset_id: reusableMediaAssetId,
      url: undefined,
    },
  };
}

async function resolveRunnableAutoClipSnapshot(
  params: Omit<Parameters<typeof restoreRunnableAutoClipSnapshot>[0], "sourceObjectAvailable">
) {
  const sourceObjectAvailable = params.sourceMediaAsset
    && params.sourceMediaAsset.deletedAt === null
    && params.sourceMediaAsset.status === "READY"
      ? await objectExists(params.sourceMediaAsset.objectKey)
      : false;

  return restoreRunnableAutoClipSnapshot({
    ...params,
    sourceObjectAvailable,
  });
}

function extractExternalSourceUrlFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const sourceUrl = (metadata as Record<string, unknown>).source_url;
  return typeof sourceUrl === "string" && sourceUrl.trim().length > 0 ? sourceUrl.trim() : null;
}

function assertRunnableAutoClipSource(snapshot: Record<string, unknown>) {
  const source =
    snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
      ? (snapshot.source as Record<string, unknown>)
      : {};
  const hasMediaAsset = typeof source.media_asset_id === "string" && source.media_asset_id.trim().length > 0;
  const hasExternalUrl =
    source.type === "EXTERNAL_URL"
    && typeof source.url === "string"
    && source.url.trim().length > 0;
  if (hasMediaAsset || hasExternalUrl) return;

  throw new ConflictError(
    "SOURCE_MEDIA_OBJECT_MISSING",
    "The original uploaded source is no longer stored. Upload the source video again before retrying this job."
  );
}

interface ClipOutputArtifactSource {
  previewObjectKey: string | null;
  finalObjectKey: string | null;
  metadataObjectKey: string | null;
  thumbnailObjectKey: string | null;
  subtitles: Array<{ format: string; objectKey: string }>;
}

interface TtsOutputArtifactSource {
  mediaAsset: { objectKey: string } | null;
}

const SUPPORTED_SUBTITLE_FORMATS = new Set(["srt", "ass", "vtt", "json"]);

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
  const base = { ...job, eventSequence: job.eventSequence?.toString() } as Record<string, unknown>;
  const outputSummary =
    base.outputSummary && typeof base.outputSummary === "object" && !Array.isArray(base.outputSummary)
      ? (base.outputSummary as Record<string, unknown>)
      : null;
  const analyzer =
    outputSummary &&
    outputSummary.analyzer &&
    typeof outputSummary.analyzer === "object" &&
    !Array.isArray(outputSummary.analyzer)
      ? (outputSummary.analyzer as Record<string, unknown>)
      : null;

  if (!outputSummary || !analyzer) {
    return base;
  }

  const analysisMode = typeof analyzer.analysis_mode === "string" ? analyzer.analysis_mode : null;
  const provider = typeof analyzer.provider === "string" ? analyzer.provider : null;
  const model = typeof analyzer.model === "string" ? analyzer.model : null;
  const attemptedProvider = typeof analyzer.attempted_provider === "string" ? analyzer.attempted_provider : null;
  const attemptedModel = typeof analyzer.attempted_model === "string" ? analyzer.attempted_model : null;

  return {
    ...base,
    outputSummary: {
      ...outputSummary,
      analyzer: {
        ...analyzer,
        analysis_mode_label: normalizeAnalyzerModeLabel(analysisMode),
        provider_label: normalizeAnalyzerProviderLabel(provider, analysisMode),
        model_label: normalizeAnalyzerModelLabel(model, analysisMode),
        attempted_provider_label: normalizeAnalyzerProviderLabel(attemptedProvider, null),
        attempted_model_label: normalizeAnalyzerModelLabel(attemptedModel, null)
      }
    }
  };
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
  const content =
    snapshot.content && typeof snapshot.content === "object" && !Array.isArray(snapshot.content)
      ? (snapshot.content as Record<string, unknown>)
      : {};
  const normalizedSubtitle = normalizeSubtitleRenderSettings(subtitle);

  return {
    visual,
    subtitle: normalizedSubtitle,
    strategy: {
      target_platform: strategy.target_platform ?? null,
      objective: strategy.objective ?? null
    },
    content: {
      speaker_count:
        typeof content.speaker_count === "number"
          ? content.speaker_count
          : typeof content.speaker_count === "string" && content.speaker_count.trim().length > 0
            ? Number(content.speaker_count)
            : null
    },
    candidate: {
      candidate_id: source.candidate.candidateExternalId,
      clip_candidate_id: source.candidate.id,
      start_ms: source.candidate.startMs.toString(),
      end_ms: source.candidate.endMs.toString(),
      duration_ms: source.candidate.durationMs.toString(),
      content_category: source.candidate.contentCategory,
      speaker_ids: Array.isArray(source.candidate.speakerIds)
        ? source.candidate.speakerIds.filter((value): value is string => typeof value === "string")
        : []
    },
    metadata: {
      suggested_caption:
        typeof metadataSuggestions.suggested_caption === "string" ? metadataSuggestions.suggested_caption : null,
      suggested_cta: typeof metadataSuggestions.suggested_cta === "string" ? metadataSuggestions.suggested_cta : null,
      related_hashtags: Array.isArray(metadataSuggestions.related_hashtags)
        ? metadataSuggestions.related_hashtags.filter((value): value is string => typeof value === "string")
        : [],
      viral_hashtags: Array.isArray(metadataSuggestions.viral_hashtags)
        ? metadataSuggestions.viral_hashtags.filter((value): value is string => typeof value === "string")
        : [],
      suggested_hashtags: Array.isArray(metadataSuggestions.suggested_hashtags)
        ? metadataSuggestions.suggested_hashtags.filter((value): value is string => typeof value === "string")
        : [],
      thumbnail_text: typeof metadataSuggestions.thumbnail_text === "string" ? metadataSuggestions.thumbnail_text : null,
      hook_second: typeof metadataSuggestions.hook_second === "number" ? metadataSuggestions.hook_second : null,
      main_point_second: typeof metadataSuggestions.main_point_second === "number" ? metadataSuggestions.main_point_second : null,
      punchline_second: typeof metadataSuggestions.punchline_second === "number" ? metadataSuggestions.punchline_second : null,
      retention_level:
        typeof metadataSuggestions.retention_level === "string" ? metadataSuggestions.retention_level : null,
      requires_context:
        typeof metadataSuggestions.requires_context === "boolean" ? metadataSuggestions.requires_context : null,
      can_standalone:
        typeof metadataSuggestions.can_standalone === "boolean" ? metadataSuggestions.can_standalone : null
    },
    analyzer: {
      analysis_version: typeof analyzerMetadata.analysis_version === "string" ? analyzerMetadata.analysis_version : null,
      analysis_mode: typeof analyzerMetadata.analysis_mode === "string" ? analyzerMetadata.analysis_mode : null,
      prompt_version: typeof analyzerMetadata.prompt_version === "string" ? analyzerMetadata.prompt_version : null,
      provider: typeof analyzerMetadata.provider === "string" ? analyzerMetadata.provider : null,
      model: typeof analyzerMetadata.model === "string" ? analyzerMetadata.model : null,
      attempted_provider:
        typeof analyzerMetadata.attempted_provider === "string" ? analyzerMetadata.attempted_provider : null,
      attempted_model: typeof analyzerMetadata.attempted_model === "string" ? analyzerMetadata.attempted_model : null
    }
  };
}

function normalizeAnalyzerModeLabel(mode: string | null) {
  if (!mode) return null;
  if (mode === "heuristic") return "Heuristic only (Python local)";
  if (mode === "hybrid") return "Hybrid (OpenAI + Python heuristic)";
  if (mode === "heuristic_then_openai") return "Heuristic + OpenAI";
  if (mode === "openai_then_heuristic") return "OpenAI + heuristic";
  return mode;
}

function normalizeAnalyzerProviderLabel(provider: string | null, mode: string | null) {
  if (mode === "heuristic") return "Python local";
  if (!provider) return null;
  if (provider === "openai") return "OpenAI";
  if (provider === "python-local") return "Python local";
  return provider;
}

function normalizeAnalyzerModelLabel(model: string | null, mode: string | null) {
  if (mode === "heuristic") return "Heuristic scorer";
  if (!model) return null;
  if (model === "heuristic-local") return "Heuristic scorer";
  return model;
}

function normalizeSubtitleRenderSettings(subtitle: Record<string, unknown>) {
  const requestedFormat =
    typeof subtitle.format === "string" && SUPPORTED_SUBTITLE_FORMATS.has(subtitle.format.trim().toLowerCase())
      ? subtitle.format.trim().toLowerCase()
      : null;
  const exportFormats = Array.isArray(subtitle.export_formats)
    ? subtitle.export_formats
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toUpperCase())
        .filter((value) => SUPPORTED_SUBTITLE_FORMATS.has(value.toLowerCase()))
    : [];
  const primaryFormat = requestedFormat ?? exportFormats[0]?.toLowerCase() ?? "srt";
  const burnedIn =
    typeof subtitle.burned_in === "boolean"
      ? subtitle.burned_in
      : typeof subtitle.burn_in === "boolean"
        ? subtitle.burn_in
        : false;

  return {
    ...subtitle,
    format: primaryFormat,
    burn_in: burnedIn,
    burned_in: burnedIn,
    export_formats: exportFormats.length > 0 ? exportFormats : ["SRT"]
  };
}

export function buildClipOutputRenderWorkflowId(clipOutputId: string): string {
  return `clip-output-render:${clipOutputId}`;
}

export function buildClipOutputRerenderWorkflowId(clipOutputId: string): string {
  return `clip-output-rerender:${clipOutputId}:${randomUUID()}`;
}

async function startClipOutputRenderWorkflow(
  client: Awaited<ReturnType<typeof temporalClient>>,
  clipOutputId: string,
  workflowId: string
) {
  await client.workflow.start("ClipOutputRenderWorkflow", {
    taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
    workflowId,
    workflowTaskTimeout: "30s",
    args: [{ clip_output_id: clipOutputId }]
  });
}

function resolveClipOutputArtifactObjectKey(
  clipOutput: ClipOutputArtifactSource,
  artifact: ClipOutputArtifact
) {
  switch (artifact) {
    case "preview":
      return clipOutput.previewObjectKey;
    case "final":
      return clipOutput.finalObjectKey;
    case "metadata":
      return clipOutput.metadataObjectKey;
    case "subtitle":
      return clipOutput.subtitles[0]?.objectKey ?? null;
    case "subtitle_srt":
      return findSubtitleObjectKey(clipOutput.subtitles, "srt");
    case "subtitle_ass":
      return findSubtitleObjectKey(clipOutput.subtitles, "ass");
    case "subtitle_vtt":
      return findSubtitleObjectKey(clipOutput.subtitles, "vtt");
    case "subtitle_json":
      return findSubtitleObjectKey(clipOutput.subtitles, "json");
  }
}

function artifactLabel(artifact: ClipOutputArtifact) {
  switch (artifact) {
    case "preview":
      return "Preview video";
    case "final":
      return "Final video";
    case "metadata":
      return "Metadata file";
    case "subtitle":
      return "Subtitle file";
    case "subtitle_srt":
      return "Subtitle SRT";
    case "subtitle_ass":
      return "Subtitle ASS";
    case "subtitle_vtt":
      return "Subtitle VTT";
    case "subtitle_json":
      return "Subtitle JSON";
  }
}

function findSubtitleObjectKey(
  subtitles: Array<{ format: string; objectKey: string }>,
  format: string
) {
  return subtitles.find((subtitle) => subtitle.format.toLowerCase() === format.toLowerCase())?.objectKey ?? null;
}

function resolveTtsOutputArtifactObjectKey(
  ttsOutput: TtsOutputArtifactSource,
  artifact: TtsOutputArtifact,
) {
  switch (artifact) {
    case "audio":
      return ttsOutput.mediaAsset?.objectKey ?? null;
  }
}

function ttsOutputArtifactLabel(artifact: TtsOutputArtifact) {
  switch (artifact) {
    case "audio":
      return "Narration audio";
  }
}
