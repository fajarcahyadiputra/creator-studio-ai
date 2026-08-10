import { Router } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { routeParam } from "../../shared/http/route-param.js";
import { requireAuth } from "../auth/identity-middleware.js";
import { writeAudit } from "../audit/audit-service.js";
import {
  autoClipJobSchema,
  clipCandidateSelectionSchema,
  regenerateAutoClipJobSchema,
  regenerateTtsJobSchema,
  retryJobSchema,
  ttsJobSchema
} from "./schemas.js";
import { AppError, ValidationError } from "../../shared/errors/app-error.js";
import { findLocalTtsModel } from "../tts/local-tts-model-registry.js";
import { assertIdempotencyKey, type ClipOutputArtifact, JobService, serializeJob } from "./job-service.js";
import type { JobEventBus } from "./job-event-bus.js";

function resolveRequestOrigin(request: { protocol: string; get(name: string): string | undefined }) {
  const host = request.get("host");
  return host ? `${request.protocol}://${host}` : undefined;
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

function reconcileClipOutputQualityStatus(params: {
  persistedQualityStatus: string;
  qualityReport: Record<string, unknown>;
  hasFinalObject: boolean;
}) {
  const validation =
    params.qualityReport.validation &&
    typeof params.qualityReport.validation === "object" &&
    !Array.isArray(params.qualityReport.validation)
      ? (params.qualityReport.validation as Record<string, unknown>)
      : {};
  const checks =
    validation.checks &&
    typeof validation.checks === "object" &&
    !Array.isArray(validation.checks)
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

function serializeClipOutput(output: {
  id: string;
  candidateId: string;
  mediaAssetId: string | null;
  version: number;
  qualityStatus: string;
  previewObjectKey: string | null;
  finalObjectKey: string | null;
  metadataObjectKey: string | null;
  thumbnailObjectKey: string | null;
  renderSettings: unknown;
  qualityReport: unknown;
  durationMs: bigint | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
  updatedAt: Date;
  subtitles?: Array<{
    id: string;
    format: string;
    language: string;
    objectKey: string;
    isBurnedIn: boolean;
    createdAt: Date;
  }>;
}) {
  const renderSettings =
    output.renderSettings && typeof output.renderSettings === "object" && !Array.isArray(output.renderSettings)
      ? (output.renderSettings as Record<string, unknown>)
      : {};
  const qualityReport =
    output.qualityReport && typeof output.qualityReport === "object" && !Array.isArray(output.qualityReport)
      ? (output.qualityReport as Record<string, unknown>)
      : {};
  const visual =
    renderSettings.visual && typeof renderSettings.visual === "object" && !Array.isArray(renderSettings.visual)
      ? (renderSettings.visual as Record<string, unknown>)
      : {};
  const strategy =
    renderSettings.strategy && typeof renderSettings.strategy === "object" && !Array.isArray(renderSettings.strategy)
      ? (renderSettings.strategy as Record<string, unknown>)
      : {};
  const subtitle =
    qualityReport.subtitle && typeof qualityReport.subtitle === "object" && !Array.isArray(qualityReport.subtitle)
      ? (qualityReport.subtitle as Record<string, unknown>)
      : {};
  const candidate =
    qualityReport.candidate && typeof qualityReport.candidate === "object" && !Array.isArray(qualityReport.candidate)
      ? (qualityReport.candidate as Record<string, unknown>)
      : {};
  const metadata =
    qualityReport.metadata && typeof qualityReport.metadata === "object" && !Array.isArray(qualityReport.metadata)
      ? (qualityReport.metadata as Record<string, unknown>)
      : {};
  const validation =
    qualityReport.validation && typeof qualityReport.validation === "object" && !Array.isArray(qualityReport.validation)
      ? (qualityReport.validation as Record<string, unknown>)
      : {};
  const validationChecks =
    validation.checks && typeof validation.checks === "object" && !Array.isArray(validation.checks)
      ? (validation.checks as Record<string, unknown>)
      : {};
  const validationObserved =
    validation.observed && typeof validation.observed === "object" && !Array.isArray(validation.observed)
      ? (validation.observed as Record<string, unknown>)
      : {};
  const validationObservedFinal =
    validationObserved.final && typeof validationObserved.final === "object" && !Array.isArray(validationObserved.final)
      ? (validationObserved.final as Record<string, unknown>)
      : {};
  const validationObservedPreview =
    validationObserved.preview && typeof validationObserved.preview === "object" && !Array.isArray(validationObserved.preview)
      ? (validationObserved.preview as Record<string, unknown>)
      : {};
  const validationWarnings = Array.isArray(validation.warnings)
    ? validation.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
    : [];
  const effectiveQualityStatus = reconcileClipOutputQualityStatus({
    persistedQualityStatus: output.qualityStatus,
    qualityReport,
    hasFinalObject: Boolean(output.finalObjectKey)
  });

  return {
    id: output.id,
    candidate_id: output.candidateId,
    media_asset_id: output.mediaAssetId,
    version: output.version,
    quality_status: effectiveQualityStatus,
    preview_object_key: output.previewObjectKey,
    final_object_key: output.finalObjectKey,
    metadata_object_key: output.metadataObjectKey,
    thumbnail_object_key: output.thumbnailObjectKey,
    render_settings: output.renderSettings,
    quality_report: output.qualityReport,
    duration_ms: output.durationMs?.toString() ?? null,
    width: output.width,
    height: output.height,
    output_summary: {
      aspect_ratio: typeof visual.aspect_ratio === "string" ? visual.aspect_ratio : null,
      target_platform: typeof strategy.target_platform === "string" ? strategy.target_platform : null,
      objective: typeof strategy.objective === "string" ? strategy.objective : null,
      renderer: typeof qualityReport.renderer === "string" ? qualityReport.renderer : null,
      render_status: typeof qualityReport.status === "string" ? qualityReport.status : null,
      candidate_title: typeof candidate.title === "string" ? candidate.title : null,
      clip_start_ms: typeof candidate.start_ms === "string" ? candidate.start_ms : null,
      clip_end_ms: typeof candidate.end_ms === "string" ? candidate.end_ms : null,
      suggested_caption: typeof metadata.suggested_caption === "string" ? metadata.suggested_caption : null,
      suggested_hashtags: Array.isArray(metadata.suggested_hashtags)
        ? metadata.suggested_hashtags.filter((value): value is string => typeof value === "string")
        : [],
      final_viral_score:
        typeof candidate.final_viral_score === "number"
          ? candidate.final_viral_score
          : typeof candidate.final_viral_score === "string"
            ? Number(candidate.final_viral_score)
            : null,
      retention_level: typeof metadata.retention_level === "string" ? metadata.retention_level : null,
      validation_status: typeof validation.status === "string" ? validation.status : null,
      output_playable: typeof validationChecks.playable === "boolean" ? validationChecks.playable : null,
      resolution_matches_target:
        typeof validationChecks.resolution_matches_target === "boolean"
          ? validationChecks.resolution_matches_target
          : null,
      audio_present: typeof validationChecks.audio_present === "boolean" ? validationChecks.audio_present : null,
      preview_playable:
        output.previewObjectKey && typeof validationChecks.preview_playable === "boolean"
          ? validationChecks.preview_playable
          : null,
      video_codec_matches_target:
        typeof validationChecks.video_codec_matches_target === "boolean"
          ? validationChecks.video_codec_matches_target
          : null,
      audio_codec_matches_target:
        typeof validationChecks.audio_codec_matches_target === "boolean"
          ? validationChecks.audio_codec_matches_target
          : null,
      duration_within_tolerance:
        typeof validationChecks.duration_within_tolerance === "boolean"
          ? validationChecks.duration_within_tolerance
          : null,
      subtitle_export_ready:
        typeof validationChecks.subtitle_export_ready === "boolean"
          ? validationChecks.subtitle_export_ready
          : null,
      subtitle_cue_count:
        typeof validationObserved.subtitle_cue_count === "number" ? validationObserved.subtitle_cue_count : null,
      final_duration_ms:
        typeof validationObservedFinal.duration_ms === "number" ? validationObservedFinal.duration_ms : null,
      final_video_codec:
        typeof validationObservedFinal.codec_name === "string" ? validationObservedFinal.codec_name : null,
      final_audio_codec:
        typeof validationObservedFinal.audio_codec_name === "string" ? validationObservedFinal.audio_codec_name : null,
      preview_duration_ms:
        typeof validationObservedPreview.duration_ms === "number" ? validationObservedPreview.duration_ms : null,
      subtitle_format: typeof subtitle.format === "string" ? subtitle.format : null,
      subtitle_language: typeof subtitle.language === "string" ? subtitle.language : null,
      subtitle_burned_in: typeof subtitle.burned_in === "boolean" ? subtitle.burned_in : null,
      validation_warnings: validationWarnings
    },
    subtitles: Array.isArray(output.subtitles)
      ? output.subtitles.map((subtitleAsset) => ({
          id: subtitleAsset.id,
          format: subtitleAsset.format,
          language: subtitleAsset.language,
          object_key: subtitleAsset.objectKey,
          is_burned_in: subtitleAsset.isBurnedIn,
          artifact: `subtitle_${subtitleAsset.format.toLowerCase()}`,
          created_at: subtitleAsset.createdAt.toISOString()
        }))
      : [],
    created_at: output.createdAt.toISOString(),
    updated_at: output.updatedAt.toISOString()
  };
}

function serializeClipCandidate(candidate: {
  id: string;
  transcriptId: string | null;
  candidateExternalId: string;
  startMs: bigint;
  endMs: bigint;
  durationMs: bigint;
  title: string;
  hookText: string;
  endingText: string;
  summary: string;
  whyItWorks: unknown;
  contentCategory: string;
  scoreBreakdown: unknown;
  baseViralScore: unknown;
  finalViralScore: unknown;
  contextComplete: boolean;
  safetyNotes: unknown;
  metadataSuggestions: unknown;
  speakerIds: unknown;
  sceneIds: unknown;
  analyzerMetadata: unknown;
  selected: boolean;
  rank: number | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const analyzerMetadata =
    candidate.analyzerMetadata && typeof candidate.analyzerMetadata === "object" && !Array.isArray(candidate.analyzerMetadata)
      ? (candidate.analyzerMetadata as Record<string, unknown>)
      : {};
  const analysisMode = typeof analyzerMetadata.analysis_mode === "string" ? analyzerMetadata.analysis_mode : null;
  const provider = typeof analyzerMetadata.provider === "string" ? analyzerMetadata.provider : null;
  const model = typeof analyzerMetadata.model === "string" ? analyzerMetadata.model : null;
  const attemptedProvider =
    typeof analyzerMetadata.attempted_provider === "string" ? analyzerMetadata.attempted_provider : null;
  const attemptedModel = typeof analyzerMetadata.attempted_model === "string" ? analyzerMetadata.attempted_model : null;

  return {
    id: candidate.id,
    transcript_id: candidate.transcriptId,
    candidate_id: candidate.candidateExternalId,
    start_ms: candidate.startMs.toString(),
    end_ms: candidate.endMs.toString(),
    duration_ms: candidate.durationMs.toString(),
    title: candidate.title,
    hook_text: candidate.hookText,
    ending_text: candidate.endingText,
    summary: candidate.summary,
    why_it_works: candidate.whyItWorks,
    content_category: candidate.contentCategory,
    score_breakdown: candidate.scoreBreakdown,
    base_viral_score: candidate.baseViralScore,
    final_viral_score: candidate.finalViralScore,
    context_complete: candidate.contextComplete,
    safety_notes: candidate.safetyNotes,
    metadata_suggestions: candidate.metadataSuggestions,
    speaker_ids: candidate.speakerIds,
    scene_ids: candidate.sceneIds,
    analyzer_metadata: {
      ...analyzerMetadata,
      analysis_mode_label: normalizeAnalyzerModeLabel(analysisMode),
      provider_label: normalizeAnalyzerProviderLabel(provider, analysisMode),
      model_label: normalizeAnalyzerModelLabel(model, analysisMode),
      attempted_provider_label: normalizeAnalyzerProviderLabel(attemptedProvider, null),
      attempted_model_label: normalizeAnalyzerModelLabel(attemptedModel, null)
    },
    selected: candidate.selected,
    rank: candidate.rank,
    created_at: candidate.createdAt.toISOString(),
    updated_at: candidate.updatedAt.toISOString()
  };
}

function serializeJobOutputs(job: Awaited<ReturnType<JobService["get"]>>) {
  const outputSummary =
    job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
      ? (job.outputSummary as Record<string, unknown>)
      : null;

  const candidateCount =
    outputSummary &&
    "candidate_count" in outputSummary &&
    typeof outputSummary.candidate_count === "number" &&
    Number.isFinite(outputSummary.candidate_count)
      ? outputSummary.candidate_count
      : Array.isArray(job.clipOutputs)
        ? job.clipOutputs.length
        : 0;

  const serializedClipOutputs = job.clipOutputs.map(serializeClipOutput);
  const reconciledJobStatus =
    job.status === "NEEDS_REVIEW"
    && serializedClipOutputs.length > 0
    && serializedClipOutputs.every((output) => output.quality_status === "PASSED")
      ? "COMPLETED"
      : job.status;
  const analyzer =
    outputSummary &&
    outputSummary.analyzer &&
    typeof outputSummary.analyzer === "object" &&
    !Array.isArray(outputSummary.analyzer)
      ? (outputSummary.analyzer as Record<string, unknown>)
      : null;
  const analysisMode = analyzer && typeof analyzer.analysis_mode === "string" ? analyzer.analysis_mode : null;
  const provider = analyzer && typeof analyzer.provider === "string" ? analyzer.provider : null;
  const model = analyzer && typeof analyzer.model === "string" ? analyzer.model : null;
  const attemptedProvider = analyzer && typeof analyzer.attempted_provider === "string" ? analyzer.attempted_provider : null;
  const attemptedModel = analyzer && typeof analyzer.attempted_model === "string" ? analyzer.attempted_model : null;

  return {
    job_id: job.id,
    status: reconciledJobStatus,
    candidate_count: candidateCount,
    clip_candidates: job.clipCandidates.map(serializeClipCandidate),
    output_summary: outputSummary
      ? {
          ...outputSummary,
          analyzer_summary: analyzer
            ? {
                analysis_mode: analysisMode,
                analysis_mode_label: normalizeAnalyzerModeLabel(analysisMode),
                provider,
                provider_label: normalizeAnalyzerProviderLabel(provider, analysisMode),
                model,
                model_label: normalizeAnalyzerModelLabel(model, analysisMode),
                attempted_provider: attemptedProvider,
                attempted_provider_label: normalizeAnalyzerProviderLabel(attemptedProvider, null),
                attempted_model: attemptedModel,
                attempted_model_label: normalizeAnalyzerModelLabel(attemptedModel, null),
                prompt_version: typeof analyzer.prompt_version === "string" ? analyzer.prompt_version : null,
                fallback_reason: typeof analyzer.fallback_reason === "string" ? analyzer.fallback_reason : null
              }
            : null
        }
      : null,
    clip_outputs: serializedClipOutputs
  };
}

function serializeClipOutputExportIndex(exportIndex: Awaited<ReturnType<JobService["createClipOutputExportIndex"]>>) {
  return {
    clip_output_id: exportIndex.clipOutputId,
    job_id: exportIndex.jobId,
    candidate_id: exportIndex.candidateId,
    quality_status: exportIndex.qualityStatus,
    artifacts: exportIndex.artifacts.map((artifact) => ({
      artifact: artifact.artifact,
      label: artifact.label,
      url: artifact.url
    }))
  };
}

function serializeJobOutputsExportIndex(exportIndex: Awaited<ReturnType<JobService["createJobOutputsExportIndex"]>>) {
  return {
    job_id: exportIndex.jobId,
    status: exportIndex.status,
    clip_outputs: exportIndex.clipOutputs.map((clipOutput) => ({
      clip_output_id: clipOutput.clipOutputId,
      candidate_id: clipOutput.candidateId,
      quality_status: clipOutput.qualityStatus,
      artifacts: clipOutput.artifacts.map((artifact) => ({
        artifact: artifact.artifact,
        label: artifact.label,
        url: artifact.url
      }))
    }))
  };
}

function serializeTtsSegmentationExport(exportData: Awaited<ReturnType<JobService["createTtsSegmentationExport"]>>) {
  return {
    job_id: exportData.jobId,
    status: exportData.status,
    language: exportData.language,
    local_model_key: exportData.localModelKey,
    voice_identifier: exportData.voiceIdentifier,
    speaking_style: exportData.speakingStyle,
    emotion: exportData.emotion,
    segment_count: exportData.segmentCount,
    total_pause_ms: exportData.totalPauseMs,
    metadata: exportData.metadata,
    document: exportData.document
  };
}

function serializeTtsOutputExportIndex(exportIndex: Awaited<ReturnType<JobService["createTtsOutputExportIndex"]>>) {
  return {
    job_id: exportIndex.jobId,
    status: exportIndex.status,
    language: exportIndex.language,
    local_model_key: exportIndex.localModelKey,
    voice_identifier: exportIndex.voiceIdentifier,
    artifacts: exportIndex.artifacts.map((artifact) => ({
      artifact: artifact.artifact,
      label: artifact.label,
      url: artifact.url
    }))
  };
}

function serializeEvent(
  event: {
  id: string;
  sequence: bigint;
  stage: string | null;
  stageProgress: number | null;
  overallProgress: number | null;
  eventType: string;
  message: string;
  userMessage: string | null;
  metadata: unknown;
  occurredAt: Date;
  },
  fallbackStatus?: string | null
) {
  const metadataStatus =
    event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      && typeof (event.metadata as Record<string, unknown>).status === "string"
      ? String((event.metadata as Record<string, unknown>).status).trim().toUpperCase()
      : null;
  const eventTypeStatus =
    event.eventType === "job.completed"
      ? "COMPLETED"
      : event.eventType === "job.failed"
        ? "FAILED"
        : event.eventType === "job.canceled"
          ? "CANCELED"
          : event.eventType === "job.needs_review"
            ? "NEEDS_REVIEW"
            : null;
  const resolvedStatus = eventTypeStatus ?? metadataStatus ?? fallbackStatus ?? null;

  return {
    id: event.id,
    sequence: event.sequence.toString(),
    stage: event.stage,
    stage_progress: event.stageProgress,
    overall_progress: event.overallProgress,
    status: resolvedStatus,
    event_type: event.eventType,
    message: event.message,
    user_message: event.userMessage,
    metadata: event.metadata,
    occurred_at: event.occurredAt.toISOString()
  };
}

export function jobsRouter(jobService: JobService, eventBus: JobEventBus): Router {
  const router = Router();

  router.post(
    "/api/v1/tts/jobs",
    requireAuth,
    validateBody(ttsJobSchema),
    asyncHandler(async (request, response) => {
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      await validateLocalTtsModelSelection(request.validatedBody);
      const job = await jobService.createTextToSpeechJob({
        userId: request.identity!.effectiveUserId,
        idempotencyKey,
        input: request.validatedBody as never
      });
      await writeAudit({
        actorUserId: request.identity?.actorUserId,
        targetUserId: request.identity?.effectiveUserId,
        action: "TTS_JOB_CREATED",
        resourceType: "Job",
        resourceId: job.id,
        request,
        metadata: { status: job.status, type: job.type }
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.post(
    "/api/v1/auto-clipping/jobs",
    requireAuth,
    validateBody(autoClipJobSchema),
    asyncHandler(async (request, response) => {
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      const job = await jobService.createAutoClippingJob({
        userId: request.identity!.effectiveUserId,
        idempotencyKey,
        input: request.validatedBody as never
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "AUTO_CLIP_JOB_CREATED",
        resourceType: "Job",
        resourceId: job.id,
        metadata: { idempotency_key: idempotencyKey, job_type: "AUTO_CLIPPING" },
        request
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.post(
    "/api/v1/tts/jobs/:jobId/regenerate",
    requireAuth,
    validateBody(regenerateTtsJobSchema),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      await validateLocalTtsModelSelection(request.validatedBody);
      const job = await jobService.regenerateTextToSpeechJob({
        userId: request.identity!.effectiveUserId,
        jobId,
        idempotencyKey,
        input: request.validatedBody as never
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "TTS_JOB_REGENERATED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: { idempotency_key: idempotencyKey, job_type: "TEXT_TO_SPEECH" },
        request
      });
      response.status(202).json({
        data: {
          ...serializeJob(job),
          redirect: `/app/jobs/${job.id}`,
          message: "TTS job regenerated and old output has been replaced."
        }
      });
    })
  );

  router.post(
    "/api/v1/auto-clipping/jobs/:jobId/regenerate",
    requireAuth,
    validateBody(regenerateAutoClipJobSchema),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      const job = await jobService.regenerateAutoClippingJob({
        userId: request.identity!.effectiveUserId,
        jobId,
        idempotencyKey,
        input: request.validatedBody as never
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "AUTO_CLIP_JOB_REGENERATED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: { idempotency_key: idempotencyKey, job_type: "AUTO_CLIPPING" },
        request
      });
      response.status(202).json({
        data: {
          ...serializeJob(job),
          redirect: `/app/jobs/${job.id}`,
          message: "Auto-clipping job regenerated and previous outputs have been replaced."
        }
      });
    })
  );

  router.post(
    "/api/v1/auto-clipping/jobs/:jobId/duplicate",
    requireAuth,
    asyncHandler(async (request, response) => {
      const sourceJobId = routeParam(request.params.jobId, "jobId");
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      const job = await jobService.duplicate(
        request.identity!.effectiveUserId,
        sourceJobId,
        idempotencyKey
      );
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "AUTO_CLIP_JOB_DUPLICATED",
        resourceType: "Job",
        resourceId: job.id,
        metadata: { source_job_id: sourceJobId, idempotency_key: idempotencyKey },
        request
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.get(
    "/app/jobs/:jobId/export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createJobOutputsExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        requestOrigin
      );
      response.setHeader("Content-Type", "application/json");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${exportIndex.jobId.slice(0, 8)}-outputs-export-index.json"`
      );
      response.json({ data: serializeJobOutputsExportIndex(exportIndex) });
    })
  );

  router.get(
    "/app/jobs/:jobId/tts-segmentation-export",
    requireAuth,
    asyncHandler(async (request, response) => {
      const exportData = await jobService.createTtsSegmentationExport(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId")
      );
      response.setHeader("Content-Type", "application/json");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${exportData.jobId.slice(0, 8)}-tts-segmentation.json"`
      );
      response.json({ data: serializeTtsSegmentationExport(exportData) });
    })
  );

  router.get(
    "/app/jobs/:jobId/tts-audio-download",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const url = await jobService.createTtsAudioArtifactUrl(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        "audio",
        requestOrigin
      );
      response.redirect(url);
    })
  );

  router.get(
    "/app/jobs/:jobId/tts-output-export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createTtsOutputExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        requestOrigin
      );
      response.setHeader("Content-Type", "application/json");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="job-${exportIndex.jobId.slice(0, 8)}-tts-output-export-index.json"`
      );
      response.json({ data: serializeTtsOutputExportIndex(exportIndex) });
    })
  );

  router.get(
    "/app/jobs/:jobId/outputs/:clipOutputId/download",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const url = await jobService.createClipOutputArtifactUrl(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        routeParam(request.params.clipOutputId, "clipOutputId"),
        parseClipOutputArtifact(request.query.artifact),
        requestOrigin
      );
      response.redirect(url);
    })
  );

  router.get(
    "/app/jobs/:jobId/outputs/:clipOutputId/export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createClipOutputExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        routeParam(request.params.clipOutputId, "clipOutputId"),
        requestOrigin
      );
      response.setHeader("Content-Type", "application/json");
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="clip-output-${exportIndex.clipOutputId.slice(0, 8)}-export-index.json"`
      );
      response.json({ data: serializeClipOutputExportIndex(exportIndex) });
    })
  );

  router.get(
    "/api/v1/jobs",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobs = await jobService.list(request.identity!.effectiveUserId);
      response.json({ data: jobs.map(serializeJob) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId",
    requireAuth,
    asyncHandler(async (request, response) => {
      const job = await jobService.get(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      response.json({ data: serializeJob(job) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/outputs",
    requireAuth,
    asyncHandler(async (request, response) => {
      const job = await jobService.get(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      response.json({ data: serializeJobOutputs(job) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createJobOutputsExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        requestOrigin
      );
      response.json({ data: serializeJobOutputsExportIndex(exportIndex) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/tts-segmentation-export",
    requireAuth,
    asyncHandler(async (request, response) => {
      const exportData = await jobService.createTtsSegmentationExport(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId")
      );
      response.json({ data: serializeTtsSegmentationExport(exportData) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/tts-output-export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createTtsOutputExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        requestOrigin
      );
      response.json({ data: serializeTtsOutputExportIndex(exportIndex) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/outputs/:clipOutputId/export-index",
    requireAuth,
    asyncHandler(async (request, response) => {
      const requestOrigin = resolveRequestOrigin(request);
      const exportIndex = await jobService.createClipOutputExportIndex(
        request.identity!.effectiveUserId,
        routeParam(request.params.jobId, "jobId"),
        routeParam(request.params.clipOutputId, "clipOutputId"),
        requestOrigin
      );
      response.json({ data: serializeClipOutputExportIndex(exportIndex) });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/delete",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const result = await jobService.delete(request.identity!.effectiveUserId, jobId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "JOB_DELETED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: {
          deleted_object_count: result.deletedObjectCount,
          deleted_generated_media_asset_count: result.deletedGeneratedMediaAssetCount,
        },
        request,
      });
      response.json({
        data: {
          job_id: result.jobId,
          deleted_object_count: result.deletedObjectCount,
          deleted_generated_media_asset_count: result.deletedGeneratedMediaAssetCount,
          redirect: "/app/jobs",
          message: "Job and related generated artifacts were deleted.",
        },
      });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/cancel",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      await jobService.cancel(request.identity!.effectiveUserId, jobId);
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "JOB_CANCELED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: { requested_status: "CANCELED" },
        request
      });
      response.status(202).json({ data: { status: "CANCELED" } });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/retry",
    requireAuth,
    validateBody(retryJobSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { stage?: string; reason: string };
      const jobId = routeParam(request.params.jobId, "jobId");
      const idempotencyKey = assertIdempotencyKey(request.get("idempotency-key"));
      const job = await jobService.retry({
        userId: request.identity!.effectiveUserId,
        jobId,
        idempotencyKey,
        reason: body.reason,
        stage: body.stage
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "JOB_RETRY_REQUESTED",
        resourceType: "Job",
        resourceId: jobId,
        reason: body.reason,
        metadata: {
          requested_stage: body.stage,
          idempotency_key: idempotencyKey,
          attempt_workflow_id: job.workflowId
        },
        request
      });
      response.status(202).json({ data: serializeJob(job) });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/candidates/:candidateId/selection",
    requireAuth,
    validateBody(clipCandidateSelectionSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as { selected: boolean };
      const jobId = routeParam(request.params.jobId, "jobId");
      const candidateId = routeParam(request.params.candidateId, "candidateId");
      const candidate = await jobService.updateClipCandidateSelection({
        userId: request.identity!.effectiveUserId,
        jobId,
        candidateId,
        selected: body.selected
      });
      const renderQueueResult = body.selected
        ? await jobService.queueSelectedClipOutputs({
            userId: request.identity!.effectiveUserId,
            jobId
          })
        : null;
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: body.selected ? "CLIP_CANDIDATE_SELECTED" : "CLIP_CANDIDATE_DESELECTED",
        resourceType: "ClipCandidate",
        resourceId: candidate.id,
        metadata: {
          job_id: jobId,
          candidate_external_id: candidate.candidateExternalId,
          selected: candidate.selected,
          rank: candidate.rank
        },
        request
      });
      response.json({
        data: {
          id: candidate.id,
          selected: candidate.selected,
          rank: candidate.rank,
          render_queue: renderQueueResult
            ? {
                selected_candidate_count: renderQueueResult.selectedCount,
                created_clip_output_count: renderQueueResult.createdCount,
                existing_clip_output_count: renderQueueResult.existingCount,
                started_render_workflow_count: renderQueueResult.startedWorkflowCount
              }
            : null,
          message: candidate.selected
            ? renderQueueResult && renderQueueResult.startedWorkflowCount > 0
              ? "Candidate selected and auto-queued for render."
              : "Candidate selected. Render output already exists for the selected set."
            : "Candidate removed from the selected set."
        }
      });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/render-queue",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const result = await jobService.queueSelectedClipOutputs({
        userId: request.identity!.effectiveUserId,
        jobId
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "JOB_RENDER_QUEUE_REQUESTED",
        resourceType: "Job",
        resourceId: jobId,
        metadata: {
          selected_candidate_count: result.selectedCount,
          created_clip_output_count: result.createdCount,
          existing_clip_output_count: result.existingCount,
          started_render_workflow_count: result.startedWorkflowCount
        },
        request
      });
      response.json({
        data: {
          job_id: result.jobId,
          selected_candidate_count: result.selectedCount,
          created_clip_output_count: result.createdCount,
          existing_clip_output_count: result.existingCount,
          started_render_workflow_count: result.startedWorkflowCount,
          message:
            result.createdCount > 0
              ? `Queued ${result.createdCount} selected candidate(s) for render preparation.`
              : "All selected candidates already have pending clip outputs."
        }
      });
    })
  );

  router.post(
    "/api/v1/jobs/:jobId/outputs/:clipOutputId/rerender",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const clipOutputId = routeParam(request.params.clipOutputId, "clipOutputId");
      const result = await jobService.rerenderClipOutput({
        userId: request.identity!.effectiveUserId,
        jobId,
        clipOutputId
      });
      await writeAudit({
        actorUserId: request.identity!.actorUserId,
        targetUserId: request.identity!.effectiveUserId,
        action: "CLIP_OUTPUT_RERENDER_REQUESTED",
        resourceType: "ClipOutput",
        resourceId: clipOutputId,
        metadata: {
          job_id: jobId,
          quality_status: result.qualityStatus
        },
        request
      });
      response.status(202).json({
        data: {
          clip_output_id: result.clipOutputId,
          quality_status: result.qualityStatus,
          message: "Clip output rerender queued."
        }
      });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/events",
    requireAuth,
    asyncHandler(async (request, response) => {
      const job = await jobService.get(request.identity!.effectiveUserId, routeParam(request.params.jobId, "jobId"));
      const after = BigInt(String(request.query.after ?? "0"));
      const events = await prisma.jobEvent.findMany({
        where: { jobId: routeParam(request.params.jobId, "jobId"), sequence: { gt: after } },
        orderBy: { sequence: "asc" },
        take: 500
      });
      response.json({ data: events.map((event) => serializeEvent(event, job.status)) });
    })
  );

  router.get(
    "/api/v1/jobs/:jobId/events/stream",
    requireAuth,
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      await jobService.get(request.identity!.effectiveUserId, jobId);

      response.status(200);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("Connection", "keep-alive");
      response.flushHeaders();

      let cursor = BigInt(String(request.query.after ?? "0"));
      let fetching = false;

      const flush = async () => {
        if (fetching) return;
        fetching = true;
        try {
          const currentJob = await prisma.job.findUnique({
            where: { id: jobId },
            select: { status: true }
          });
          const events = await prisma.jobEvent.findMany({
            where: { jobId, sequence: { gt: cursor } },
            orderBy: { sequence: "asc" },
            take: 500
          });
          for (const event of events) {
            cursor = event.sequence;
            response.write(`id: ${event.sequence.toString()}\n`);
            response.write(`event: ${event.eventType}\n`);
            response.write(`data: ${JSON.stringify(serializeEvent(event, currentJob?.status ?? null))}\n\n`);
          }
        } finally {
          fetching = false;
        }
      };

      await flush();
      const unsubscribe = eventBus.on(jobId, () => void flush());
      const keepAlive = setInterval(() => {
        response.write(": keep-alive\n\n");
        void flush();
      }, 15_000);

      request.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
        response.end();
      });
    })
  );

  return router;
}

async function validateLocalTtsModelSelection(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const modelKey = (input as Record<string, unknown>).local_model_key;
  if (typeof modelKey !== "string" || !modelKey.trim()) return;

  const model = await findLocalTtsModel(modelKey);
  if (!model) {
    throw new ValidationError("Model suara lokal tidak dikenal.", {
      fields: { local_model_key: ["Pilih model suara yang tersedia di dashboard TTS."] }
    });
  }
  if (!model.available) {
    throw new ValidationError("Checkpoint untuk model suara ini belum tersedia.", {
      fields: {
        local_model_key: [
          `Tambahkan ${model.baseModelKey}.onnx beserta file konfigurasi JSON ke folder model_tts.`
        ]
      }
    });
  }
}

function parseClipOutputArtifact(value: unknown): ClipOutputArtifact {
  if (
    value === "preview"
    || value === "final"
    || value === "metadata"
    || value === "subtitle"
    || value === "subtitle_srt"
    || value === "subtitle_ass"
    || value === "subtitle_vtt"
    || value === "subtitle_json"
  ) {
    return value;
  }

  throw new AppError({
    code: "INVALID_CLIP_OUTPUT_ARTIFACT",
    message: "A valid clip output artifact is required.",
    statusCode: 400
  });
}
