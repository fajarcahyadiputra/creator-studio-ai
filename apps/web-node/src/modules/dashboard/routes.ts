import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { JobStatus, JobType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { createPublicSignedObjectReadUrl, objectExists } from "../../infrastructure/storage/s3.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { logger } from "../../shared/logging/logger.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";
import { listLocalTtsModels } from "../tts/local-tts-model-registry.js";

export const dashboardRouter = Router();

const DASHBOARD_DAYS = 7;
const ttsModelPreviewSchema = z.object({
  model_key: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(500).optional()
});
const TERMINAL_JOB_DISPLAY_STAGE: Partial<Record<JobStatus, string>> = {
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
  PARTIALLY_COMPLETED: "PARTIALLY_COMPLETED",
  NEEDS_REVIEW: "NEEDS_REVIEW"
};

function resolveRequestOrigin(request: { protocol: string; get(name: string): string | undefined }) {
  const host = request.get("host");
  return host ? `${request.protocol}://${host}` : undefined;
}

async function resolveClipPlaybackArtifact(params: {
  jobId: string;
  clipOutputId: string;
  artifact: "preview" | "final";
  objectKey: string | null;
}) {
  if (!params.objectKey) {
    return { available: false, missing: false, storageCheckFailed: false, playbackUrl: null };
  }

  try {
    if (!(await objectExists(params.objectKey))) {
      logger.warn(
        {
          jobId: params.jobId,
          clipOutputId: params.clipOutputId,
          artifact: params.artifact,
          objectKey: params.objectKey
        },
        "Clip output references an object that is missing from storage"
      );
      return { available: false, missing: true, storageCheckFailed: false, playbackUrl: null };
    }

    return {
      available: true,
      missing: false,
      storageCheckFailed: false,
      playbackUrl: await createPublicSignedObjectReadUrl(params.objectKey)
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        jobId: params.jobId,
        clipOutputId: params.clipOutputId,
        artifact: params.artifact,
        objectKey: params.objectKey
      },
      "Failed to verify clip output artifact in storage"
    );
    return { available: false, missing: false, storageCheckFailed: true, playbackUrl: null };
  }
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

const AUTO_CLIP_PLATFORM_LABELS: Record<string, string> = {
  YOUTUBE_SHORTS: "YouTube Shorts",
  TIKTOK: "TikTok",
  INSTAGRAM_REELS: "Instagram Reels",
  FACEBOOK_REELS: "Facebook Reels",
  CUSTOM: "Custom"
};

const AUTO_CLIP_OBJECTIVE_LABELS: Record<string, string> = {
  EDUCATION: "Edukasi",
  ENGAGEMENT: "Engagement",
  STORYTELLING: "Storytelling",
  CONTROVERSY: "Kontroversi",
  PRODUCT_AWARENESS: "Product awareness",
  LEAD_GENERATION: "Lead generation"
};

const AUTO_CLIP_CROP_STRATEGY_LABELS: Record<string, string> = {
  SMART_SPEAKER: "Smart speaker (1-4 wajah)",
  AUTO_REFRAME: "Auto reframe",
  FACE_TRACKING: "Face tracking",
  ACTIVE_SPEAKER: "Active speaker",
  SPLIT_SCREEN: "Split screen",
  CENTER: "Center crop",
  SPEAKER_AND_SCREEN: "Speaker and screen",
  BLURRED_BACKGROUND: "Blurred background",
  MANUAL: "Manual"
};

const AUTO_CLIP_LAYOUT_TEMPLATE_LABELS: Record<string, string> = {
  STANDARD: "Standard",
  PODCAST_SPOTLIGHT_9X16: "Podcast Spotlight 9:16"
};

const AUTO_CLIP_SUBTITLE_STYLE_LABELS: Record<string, string> = {
  PODCAST_HIGHLIGHT: "Highlight per kata biru/mint",
  DEFAULT: "Default clean",
  BOLD_KINETIC: "Bold kinetic",
  CLEAN_MINIMAL: "Clean minimal",
  NEWS_FLASH: "News Flash",
  CINEMATIC_QUOTE: "Cinematic quote"
};

const AUTO_CLIP_STANDALONE_LABELS: Record<string, string> = {
  REQUIRED: "Harus mandiri",
  PREFERRED: "Diutamakan mandiri",
  FLEXIBLE: "Fleksibel"
};

const AUTO_CLIP_FRAMING_MODE_LABELS: Record<string, string> = {
  COMBINED: "Combined",
  TRANSCRIPT_ONLY: "Transcript only",
  FACE_DETECTION_ONLY: "Face detection only"
};

function displayAutoClipLabel(map: Record<string, string> | null | undefined, value: string | null | undefined) {
  if (!value) return "-";
  return map?.[value] ?? value;
}

dashboardRouter.get(
  "/app/dashboard",
  requireAuth,
  asyncHandler(async (request, response) => {
    const userId = request.identity!.effectiveUserId;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
    const chartStart = new Date(startOfToday);
    chartStart.setDate(chartStart.getDate() - (DASHBOARD_DAYS - 1));

    const [user, jobs, recent, outputs, candidates, sourceAssets] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.job.findMany({
        where: { userId, deletedAt: null },
        include: {
          project: { select: { name: true } },
          sourceMediaAsset: { select: { displayName: true, durationMs: true } },
          clipOutputs: { select: { id: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 200
      }),
      prisma.job.findMany({
        where: { userId, deletedAt: null },
        include: {
          project: { select: { name: true } },
          sourceMediaAsset: { select: { displayName: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 10
      }),
      prisma.clipOutput.findMany({
        where: { job: { userId, deletedAt: null }, deletedAt: null },
        include: {
          candidate: { select: { title: true, finalViralScore: true } },
          job: { select: { id: true, createdAt: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 5
      }),
      prisma.clipCandidate.findMany({
        where: { job: { userId, deletedAt: null } },
        select: { finalViralScore: true, createdAt: true }
      }),
      prisma.mediaAsset.findMany({
        where: { userId, deletedAt: null, durationMs: { not: null } },
        select: { durationMs: true }
      })
    ]);

    const counts = Object.fromEntries(countBy(jobs, (job) => job.status));
    const jobsToday = jobs.filter((job) => job.createdAt >= startOfToday).length;
    const jobsThisMonth = jobs.filter((job) => job.createdAt >= startOfMonth).length;
    const totalSourceDurationSeconds = sourceAssets.reduce((sum, asset) => sum + Number(asset.durationMs ?? 0), 0) / 1000;
    const totalClipOutputs = outputs.length;
    const averageViralScore = candidates.length
      ? candidates.reduce((sum, candidate) => sum + Number(candidate.finalViralScore), 0) / candidates.length
      : 0;
    const jobTrend = buildDailyTrend(jobs.map((job) => job.createdAt), chartStart, DASHBOARD_DAYS);
    const clipScoreRanges = buildScoreRanges(candidates.map((candidate) => Number(candidate.finalViralScore)));
    const alerts = buildWorkspaceAlerts(counts);

    response.render("app/dashboard", {
      title: "Dashboard",
      user,
      counts,
      recent: recent.map((job) => ({
        ...job,
        projectName: job.project?.name ?? null,
        sourceName: job.sourceMediaAsset?.displayName ?? null
      })),
      summary: {
        jobsToday,
        jobsThisMonth,
        totalSourceDurationSeconds,
        totalClipOutputs,
        averageViralScore,
        jobTrend,
        clipScoreRanges,
        recentOutputs: outputs.map((output) => ({
          id: output.id,
          title: output.candidate.title,
          score: Number(output.candidate.finalViralScore),
          jobId: output.job.id,
          createdAt: output.createdAt
        })),
        alerts
      },
      csrfToken: request.session.csrfToken
    });
  })
);

dashboardRouter.get(
  "/app/jobs",
  requireAuth,
  asyncHandler(async (request, response) => {
    const userId = request.identity!.effectiveUserId;
    const filters = {
      search: typeof request.query.search === "string" ? request.query.search.trim() : "",
      status: typeof request.query.status === "string" ? request.query.status : "ALL",
      type: typeof request.query.type === "string" ? request.query.type : "ALL",
      provider: typeof request.query.provider === "string" ? request.query.provider.trim() : "",
      dateFrom: typeof request.query.date_from === "string" ? request.query.date_from : "",
      dateTo: typeof request.query.date_to === "string" ? request.query.date_to : ""
    };

    const jobs = await prisma.job.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(isJobStatus(filters.status) ? { status: filters.status } : {}),
        ...(isJobType(filters.type) ? { type: filters.type } : {}),
        ...(filters.dateFrom || filters.dateTo
          ? {
              createdAt: {
                ...(filters.dateFrom ? { gte: new Date(`${filters.dateFrom}T00:00:00.000Z`) } : {}),
                ...(filters.dateTo ? { lte: new Date(`${filters.dateTo}T23:59:59.999Z`) } : {})
              }
            }
          : {})
      },
      include: {
        project: { select: { name: true } },
        sourceMediaAsset: { select: { displayName: true } },
        errors: { orderBy: { occurredAt: "desc" }, take: 1 }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });

    const enrichedJobs = jobs
      .map((job) => {
        const outputSummary =
          job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
            ? (job.outputSummary as Record<string, unknown>)
            : null;
        const analyzer =
          outputSummary?.analyzer && typeof outputSummary.analyzer === "object" && !Array.isArray(outputSummary.analyzer)
            ? (outputSummary.analyzer as Record<string, unknown>)
            : null;
        const provider =
          typeof analyzer?.provider === "string"
            ? analyzer.provider
            : null;
        return {
          ...job,
          projectName: job.project?.name ?? null,
          sourceName: job.sourceMediaAsset?.displayName ?? null,
          provider,
          shortId: job.id.slice(0, 8),
          runningDurationLabel:
            job.startedAt && !job.completedAt ? formatDuration(Date.now() - job.startedAt.getTime()) : null
        };
      })
      .filter((job) => {
        if (filters.search) {
          const haystack = [job.id, job.projectName, job.sourceName].filter(Boolean).join(" ").toLowerCase();
          if (!haystack.includes(filters.search.toLowerCase())) return false;
        }
        if (filters.provider && (job.provider ?? "").toLowerCase() !== filters.provider.toLowerCase()) return false;
        return true;
      });

    const providerOptions = [...new Set(enrichedJobs.map((job) => job.provider).filter((value): value is string => Boolean(value)))].sort();

    response.render("app/jobs", {
      title: "Jobs",
      jobs: enrichedJobs,
      filters,
      statusOptions: [...new Set(jobs.map((job) => job.status))].sort(),
      typeOptions: [...new Set(jobs.map((job) => job.type))].sort(),
      providerOptions,
      csrfToken: request.session.csrfToken
    });
  })
);

dashboardRouter.get(
  "/app/jobs/:jobId",
  requireAuth,
  asyncHandler(async (request, response) => {
    const jobId = String(request.params.jobId);
    const job = await prisma.job.findFirst({
      where: { id: jobId, userId: request.identity!.effectiveUserId, deletedAt: null },
      include: {
        project: { select: { name: true } },
        sourceMediaAsset: { select: { displayName: true, durationMs: true, objectKey: true, mimeType: true } },
        autoClipRequest: true,
        ttsRequest: {
          include: {
            outputs: {
              include: {
                mediaAsset: true
              },
              orderBy: { version: "desc" }
            }
          }
        },
        attempts: { orderBy: { attemptNumber: "desc" } },
        errors: { orderBy: { occurredAt: "desc" } },
        stages: { orderBy: { createdAt: "asc" } },
        clipCandidates: { orderBy: [{ rank: "asc" }, { createdAt: "asc" }] },
        clipOutputs: {
          include: {
            candidate: {
              select: {
                finalViralScore: true,
                title: true
              }
            },
            subtitles: {
              orderBy: { createdAt: "desc" },
              take: 5
            }
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });

    if (!job) {
      response.status(404).render("app/job-detail", {
        title: "Job not found",
        job: null,
        events: [],
        candidates: [],
        clipOutputs: [],
        outputSummary: {
          sourceSummary: null,
          analysisVersion: null,
          candidateCount: 0,
          analyzer: null,
          requestSnapshot: null
        },
        csrfToken: request.session.csrfToken
      });
      return;
    }

    const events = await prisma.jobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { sequence: "desc" },
      take: 50
    });
    const outputSummary =
      job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
        ? (job.outputSummary as Record<string, unknown>)
        : null;
    const progressView = resolveJobProgressView(job.status, job.progressPercent, job.currentStage);
    const analyzer =
      outputSummary?.analyzer && typeof outputSummary.analyzer === "object" && !Array.isArray(outputSummary.analyzer)
        ? (outputSummary.analyzer as Record<string, unknown>)
        : null;
    const sourceMediaPlaybackUrl = job.sourceMediaAsset?.objectKey
      ? await createPublicSignedObjectReadUrl(job.sourceMediaAsset.objectKey)
      : null;
    const latestTtsOutput =
      job.ttsRequest?.outputs.find((output) => output.status === "READY" && output.mediaAsset?.objectKey)
      ?? job.ttsRequest?.outputs.find((output) => Boolean(output.mediaAsset?.objectKey))
      ?? null;
    const ttsAudioPlaybackUrl = latestTtsOutput?.mediaAsset.objectKey
      ? await createPublicSignedObjectReadUrl(latestTtsOutput.mediaAsset.objectKey)
      : null;
    const strategyConfig = toJsonRecord(job.autoClipRequest?.strategyConfig);
    const visualConfig = toJsonRecord(job.autoClipRequest?.visualConfig);
    const subtitleConfig = toJsonRecord(job.autoClipRequest?.subtitleConfig);
    const providerConfig = toJsonRecord(job.autoClipRequest?.providerConfigSnapshot);
    const ttsOutputConfig = toJsonRecord(job.ttsRequest?.outputConfig);
    const ttsInputSnapshot = toJsonRecord(job.inputSnapshot);
    const ttsSummary =
      outputSummary?.tts && typeof outputSummary.tts === "object" && !Array.isArray(outputSummary.tts)
        ? (outputSummary.tts as Record<string, unknown>)
        : null;
    const clipOutputs = await Promise.all(job.clipOutputs.map(async (output) => {
        const renderSettings =
          output.renderSettings && typeof output.renderSettings === "object" && !Array.isArray(output.renderSettings)
            ? (output.renderSettings as Record<string, unknown>)
            : {};
        const visual =
          renderSettings.visual && typeof renderSettings.visual === "object" && !Array.isArray(renderSettings.visual)
            ? (renderSettings.visual as Record<string, unknown>)
            : {};
        const configuredMetadata =
          renderSettings.metadata && typeof renderSettings.metadata === "object" && !Array.isArray(renderSettings.metadata)
            ? (renderSettings.metadata as Record<string, unknown>)
            : {};
        const qualityReport =
          output.qualityReport && typeof output.qualityReport === "object" && !Array.isArray(output.qualityReport)
            ? (output.qualityReport as Record<string, unknown>)
            : {};
        const qualityMetadata =
          qualityReport.metadata && typeof qualityReport.metadata === "object" && !Array.isArray(qualityReport.metadata)
            ? (qualityReport.metadata as Record<string, unknown>)
            : {};
        const metadata = Object.keys(qualityMetadata).length > 0 ? qualityMetadata : configuredMetadata;
        const qualityCandidate =
          qualityReport.candidate && typeof qualityReport.candidate === "object" && !Array.isArray(qualityReport.candidate)
            ? (qualityReport.candidate as Record<string, unknown>)
            : {};
        const qualityValidation =
          qualityReport.validation && typeof qualityReport.validation === "object" && !Array.isArray(qualityReport.validation)
            ? (qualityReport.validation as Record<string, unknown>)
            : {};
        const latestAttempt =
          qualityReport.latest_attempt && typeof qualityReport.latest_attempt === "object" && !Array.isArray(qualityReport.latest_attempt)
            ? (qualityReport.latest_attempt as Record<string, unknown>)
            : {};
        const qualityChecks =
          qualityValidation.checks &&
          typeof qualityValidation.checks === "object" &&
          !Array.isArray(qualityValidation.checks)
            ? (qualityValidation.checks as Record<string, unknown>)
            : {};
        const qualityObserved =
          qualityValidation.observed &&
          typeof qualityValidation.observed === "object" &&
          !Array.isArray(qualityValidation.observed)
            ? (qualityValidation.observed as Record<string, unknown>)
            : {};
        const faceLayout =
          qualityReport.face_layout &&
          typeof qualityReport.face_layout === "object" &&
          !Array.isArray(qualityReport.face_layout)
            ? (qualityReport.face_layout as Record<string, unknown>)
            : {};
        const renderPlan =
          qualityReport.render_plan &&
          typeof qualityReport.render_plan === "object" &&
          !Array.isArray(qualityReport.render_plan)
            ? (qualityReport.render_plan as Record<string, unknown>)
            : {};
        const speechCleanup =
          qualityReport.speech_cleanup &&
          typeof qualityReport.speech_cleanup === "object" &&
          !Array.isArray(qualityReport.speech_cleanup)
            ? (qualityReport.speech_cleanup as Record<string, unknown>)
            : {};
        const speechCleanupRemovals = Array.isArray(speechCleanup.removals)
          ? speechCleanup.removals
              .filter(
                (removal): removal is Record<string, unknown> =>
                  Boolean(removal)
                  && typeof removal === "object"
                  && !Array.isArray(removal)
              )
              .map((removal) => ({
                startTime: typeof removal.clip_start_time === "number" ? removal.clip_start_time : null,
                endTime: typeof removal.clip_end_time === "number" ? removal.clip_end_time : null,
                reason: typeof removal.reason === "string" ? removal.reason : "speech_cleanup",
                confidence: typeof removal.confidence === "number" ? removal.confidence : null
              }))
          : [];
        const visualSettings =
          visual.settings && typeof visual.settings === "object" && !Array.isArray(visual.settings)
            ? (visual.settings as Record<string, unknown>)
            : {};
        const finalObserved =
          qualityObserved.final &&
          typeof qualityObserved.final === "object" &&
          !Array.isArray(qualityObserved.final)
            ? (qualityObserved.final as Record<string, unknown>)
            : {};
        const previewObserved =
          qualityObserved.preview &&
          typeof qualityObserved.preview === "object" &&
          !Array.isArray(qualityObserved.preview)
            ? (qualityObserved.preview as Record<string, unknown>)
            : {};
        const validationWarnings = Array.isArray(qualityValidation.warnings)
          ? qualityValidation.warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0)
          : [];
        const latestAttemptMessage =
          typeof latestAttempt.message === "string" && latestAttempt.message.trim().length > 0
            ? latestAttempt.message
            : null;
        const warningMessage =
          typeof qualityReport.warning_message === "string" && qualityReport.warning_message.trim().length > 0
            ? qualityReport.warning_message
            : null;
        const reconciledQualityStatus =
          output.qualityStatus === "NEEDS_REVIEW"
          && typeof qualityValidation.status === "string"
          && qualityValidation.status === "passed"
          && Boolean(output.finalObjectKey)
          && qualityChecks.playable === true
            ? "PASSED"
            : output.qualityStatus;
        const [previewArtifact, finalArtifact] = await Promise.all([
          resolveClipPlaybackArtifact({
            jobId: job.id,
            clipOutputId: output.id,
            artifact: "preview",
            objectKey: output.previewObjectKey
          }),
          resolveClipPlaybackArtifact({
            jobId: job.id,
            clipOutputId: output.id,
            artifact: "final",
            objectKey: output.finalObjectKey
          })
        ]);
        return {
          id: output.id,
          candidateId: output.candidateId,
          candidateTitle:
            typeof qualityCandidate.title === "string"
              ? qualityCandidate.title
              : output.candidate?.title ?? null,
          finalViralScore:
            output.candidate?.finalViralScore != null
              ? Number(output.candidate.finalViralScore)
              : null,
          qualityStatus: reconciledQualityStatus,
          durationMs: output.durationMs,
          version: output.version,
          width: output.width,
          height: output.height,
          createdAt: output.createdAt,
          previewAvailable: previewArtifact.available,
          finalAvailable: finalArtifact.available,
          previewMissing: previewArtifact.missing,
          finalMissing: finalArtifact.missing,
          videoStorageCheckFailed:
            previewArtifact.storageCheckFailed || finalArtifact.storageCheckFailed,
          metadataAvailable: Boolean(output.metadataObjectKey),
          thumbnailAvailable: false,
          subtitleAvailable: output.subtitles.length > 0,
          subtitleFormats: output.subtitles.map((subtitle) => subtitle.format),
          subtitleDownloads: output.subtitles.map((subtitle) => ({
            format: subtitle.format,
            language: subtitle.language,
            isBurnedIn: subtitle.isBurnedIn,
            artifact: `subtitle_${subtitle.format.toLowerCase()}`,
            label: subtitle.format.toUpperCase()
          })),
          subtitleLanguages: output.subtitles.map((subtitle) => subtitle.language),
          subtitleBurnedIn: output.subtitles.some((subtitle) => subtitle.isBurnedIn),
          aspectRatio: typeof visual.aspect_ratio === "string" ? visual.aspect_ratio : null,
          cropStrategy:
            typeof renderPlan.crop_strategy === "string"
              ? renderPlan.crop_strategy
              : typeof visual.crop_strategy === "string"
                ? visual.crop_strategy
                : null,
          framingDetectionMode:
            typeof visualSettings.framing_detection_mode === "string"
              ? visualSettings.framing_detection_mode
              : null,
          splitOnMultiFace:
            typeof visualSettings.split_on_multi_face === "boolean"
              ? visualSettings.split_on_multi_face
              : null,
          splitMinFaceCount:
            typeof visualSettings.split_min_face_count === "number"
              ? visualSettings.split_min_face_count
              : null,
          splitFrameEnabled:
            typeof renderPlan.crop_mode === "string"
              ? renderPlan.crop_mode === "split_frame"
              : null,
          speakerCount:
            typeof renderPlan.speaker_count === "number" ? renderPlan.speaker_count : null,
          activeSpeakerCount:
            typeof renderPlan.active_speaker_count === "number"
              ? renderPlan.active_speaker_count
              : typeof faceLayout.max_active_speaker_count === "number"
                ? faceLayout.max_active_speaker_count
                : null,
          activeSpeakerSource:
            typeof renderPlan.active_speaker_source === "string"
              ? renderPlan.active_speaker_source
              : typeof renderPlan.split_evidence_source === "string"
                ? renderPlan.split_evidence_source
                : null,
          detectedFaceCount:
            typeof faceLayout.max_face_count === "number" ? faceLayout.max_face_count : null,
          averageFaceCount:
            typeof faceLayout.average_face_count === "number" ? faceLayout.average_face_count : null,
          singleFaceAnchor:
            typeof faceLayout.single_face_anchor === "string" ? faceLayout.single_face_anchor : null,
          splitFrameSupported:
            typeof faceLayout.supports_split_frame === "boolean" ? faceLayout.supports_split_frame : null,
          targetPlatform:
            renderSettings.strategy &&
            typeof renderSettings.strategy === "object" &&
            !Array.isArray(renderSettings.strategy) &&
            typeof (renderSettings.strategy as Record<string, unknown>).target_platform === "string"
              ? String((renderSettings.strategy as Record<string, unknown>).target_platform)
              : null,
          renderer:
            output.qualityReport &&
            typeof output.qualityReport === "object" &&
            !Array.isArray(output.qualityReport) &&
            typeof (output.qualityReport as Record<string, unknown>).renderer === "string"
              ? String((output.qualityReport as Record<string, unknown>).renderer)
              : null,
          renderStatus:
            typeof qualityReport.status === "string"
              ? String(qualityReport.status)
              : null,
          latestAttemptMessage: latestAttemptMessage ?? warningMessage,
          speechCleanup: {
            enabled: speechCleanup.enabled === true,
            applied: speechCleanup.applied === true,
            removalCount:
              typeof speechCleanup.removal_count === "number"
                ? speechCleanup.removal_count
                : speechCleanupRemovals.length,
            removedDurationSeconds:
              typeof speechCleanup.removed_duration_seconds === "number"
                ? speechCleanup.removed_duration_seconds
                : 0,
            outputDurationSeconds:
              typeof speechCleanup.output_duration_seconds === "number"
                ? speechCleanup.output_duration_seconds
                : null,
            removals: speechCleanupRemovals
          },
          validationStatus:
            typeof qualityValidation.status === "string" ? String(qualityValidation.status) : null,
          validationWarnings,
          outputPlayable:
            typeof qualityChecks.playable === "boolean" ? qualityChecks.playable : null,
          resolutionMatchesTarget:
            typeof qualityChecks.resolution_matches_target === "boolean"
              ? qualityChecks.resolution_matches_target
              : null,
          audioPresent:
            typeof qualityChecks.audio_present === "boolean" ? qualityChecks.audio_present : null,
          previewPlayable:
            typeof qualityChecks.preview_playable === "boolean" ? qualityChecks.preview_playable : null,
          videoCodecMatchesTarget:
            typeof qualityChecks.video_codec_matches_target === "boolean"
              ? qualityChecks.video_codec_matches_target
              : null,
          audioCodecMatchesTarget:
            typeof qualityChecks.audio_codec_matches_target === "boolean"
              ? qualityChecks.audio_codec_matches_target
              : null,
          durationWithinTolerance:
            typeof qualityChecks.duration_within_tolerance === "boolean"
              ? qualityChecks.duration_within_tolerance
              : null,
          subtitleExportReady:
            typeof qualityChecks.subtitle_export_ready === "boolean"
              ? qualityChecks.subtitle_export_ready
              : null,
          subtitleCueCount:
            typeof qualityObserved.subtitle_cue_count === "number" ? qualityObserved.subtitle_cue_count : null,
          finalDurationMs:
            typeof finalObserved.duration_ms === "number" ? finalObserved.duration_ms : null,
          finalVideoCodec:
            typeof finalObserved.codec_name === "string" ? finalObserved.codec_name : null,
          finalAudioCodec:
            typeof finalObserved.audio_codec_name === "string" ? finalObserved.audio_codec_name : null,
          previewDurationMs:
            typeof previewObserved.duration_ms === "number" ? previewObserved.duration_ms : null,
          retentionLevel:
            typeof metadata.retention_level === "string" ? metadata.retention_level : null,
          suggestedCaption:
            typeof metadata.suggested_caption === "string" ? metadata.suggested_caption : null,
          relatedHashtags: Array.isArray(metadata.related_hashtags)
            ? metadata.related_hashtags.filter((tag): tag is string => typeof tag === "string")
            : [],
          viralHashtags: Array.isArray(metadata.viral_hashtags)
            ? metadata.viral_hashtags.filter((tag): tag is string => typeof tag === "string")
            : [],
          sourceAttribution:
            typeof metadata.source_attribution === "string" ? metadata.source_attribution : null,
          thumbnailPlaybackUrl: null,
          previewPlaybackUrl: previewArtifact.playbackUrl,
          finalPlaybackUrl: finalArtifact.playbackUrl
        };
      }));
    const clipOutputByCandidateId = new Map(clipOutputs.map((output) => [output.candidateId, output]));
    const candidates = job.clipCandidates.map((candidate) => {
      const scoreBreakdown =
        candidate.scoreBreakdown && typeof candidate.scoreBreakdown === "object" && !Array.isArray(candidate.scoreBreakdown)
          ? (candidate.scoreBreakdown as Record<string, unknown>)
          : {};
      const whyItWorks =
        Array.isArray(candidate.whyItWorks)
          ? candidate.whyItWorks.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
      const metadataSuggestions =
        candidate.metadataSuggestions &&
        typeof candidate.metadataSuggestions === "object" &&
        !Array.isArray(candidate.metadataSuggestions)
          ? (candidate.metadataSuggestions as Record<string, unknown>)
          : {};
      const safetyNotes = Array.isArray(candidate.safetyNotes)
        ? candidate.safetyNotes.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
      const hashtags = Array.isArray(metadataSuggestions.suggested_hashtags)
        ? metadataSuggestions.suggested_hashtags.filter((tag): tag is string => typeof tag === "string")
        : [];
      const linkedClipOutput = clipOutputByCandidateId.get(candidate.id);
      const previewUsesSourceTimeline = !linkedClipOutput?.previewPlaybackUrl && !linkedClipOutput?.finalPlaybackUrl;

      return {
        id: candidate.id,
        candidateId: candidate.candidateExternalId,
        title: candidate.title,
        hookText: candidate.hookText,
        endingText: candidate.endingText,
        summary: candidate.summary,
        whyItWorks,
        contentCategory: candidate.contentCategory,
        contextComplete: candidate.contextComplete,
        finalViralScore: Number(candidate.finalViralScore),
        startSeconds: Number(candidate.startMs) / 1000,
        endSeconds: Number(candidate.endMs) / 1000,
        durationSeconds: Number(candidate.durationMs) / 1000,
        hashtags,
        rank: candidate.rank,
        selected: candidate.selected,
        safetyNotes,
        scoreSummary: {
          hookStrength: toOptionalNumber(scoreBreakdown.hook_strength),
          shareability: toOptionalNumber(scoreBreakdown.shareability),
          emotionalPull: toOptionalNumber(scoreBreakdown.emotional_pull),
          clarity: toOptionalNumber(scoreBreakdown.clarity)
        },
        suggestedCaption: typeof metadataSuggestions.suggested_caption === "string" ? metadataSuggestions.suggested_caption : null,
        hookSecond: typeof metadataSuggestions.hook_second === "number" ? metadataSuggestions.hook_second : null,
        mainPointSecond:
          typeof metadataSuggestions.main_point_second === "number" ? metadataSuggestions.main_point_second : null,
        punchlineSecond:
          typeof metadataSuggestions.punchline_second === "number" ? metadataSuggestions.punchline_second : null,
        retentionLevel:
          typeof metadataSuggestions.retention_level === "string" ? metadataSuggestions.retention_level : null,
        requiresContext:
          typeof metadataSuggestions.requires_context === "boolean" ? metadataSuggestions.requires_context : null,
        canStandalone:
          typeof metadataSuggestions.can_standalone === "boolean" ? metadataSuggestions.can_standalone : null,
        previewVideoUrl: linkedClipOutput?.previewPlaybackUrl ?? linkedClipOutput?.finalPlaybackUrl ?? sourceMediaPlaybackUrl,
        previewMimeType:
          linkedClipOutput?.previewPlaybackUrl || linkedClipOutput?.finalPlaybackUrl
            ? "video/mp4"
            : (job.sourceMediaAsset?.mimeType ?? null),
        previewUsesSourceTimeline,
        previewLabel: previewUsesSourceTimeline ? "Source preview" : "Rendered clip preview",
        previewActionLabel: previewUsesSourceTimeline ? "Open source video" : "Open rendered clip"
      };
    });

    response.render("app/job-detail", {
      title: `Job ${job.id.slice(0, 8)}`,
      displayAutoClipLabel,
      platformLabels: AUTO_CLIP_PLATFORM_LABELS,
      objectiveLabels: AUTO_CLIP_OBJECTIVE_LABELS,
      cropStrategyLabels: AUTO_CLIP_CROP_STRATEGY_LABELS,
      layoutTemplateLabels: AUTO_CLIP_LAYOUT_TEMPLATE_LABELS,
      subtitleStyleLabels: AUTO_CLIP_SUBTITLE_STYLE_LABELS,
      standaloneLabels: AUTO_CLIP_STANDALONE_LABELS,
      framingModeLabels: AUTO_CLIP_FRAMING_MODE_LABELS,
      job: {
        ...job,
        progressPercent: progressView.percent,
        currentStage: progressView.stage
      },
      events,
      candidates,
      clipOutputs,
      outputSummary: {
        sourceSummary: typeof outputSummary?.source_summary === "string" ? outputSummary.source_summary : null,
        analysisVersion: typeof outputSummary?.analysis_version === "string" ? outputSummary.analysis_version : null,
        candidateCount: typeof outputSummary?.candidate_count === "number" ? outputSummary.candidate_count : candidates.length,
        estimatedUsage: {
          sourceDurationSeconds: job.sourceMediaAsset?.durationMs ? Number(job.sourceMediaAsset.durationMs) / 1000 : null,
          selectedCandidates: candidates.filter((candidate) => candidate.selected).length,
          clipOutputs: job.clipOutputs.length
        },
        analyzer: (() => {
          if (!analyzer) return null;

          const analysisMode = typeof analyzer.analysis_mode === "string" ? analyzer.analysis_mode : null;
          const provider = typeof analyzer.provider === "string" ? analyzer.provider : null;
          const model = typeof analyzer.model === "string" ? analyzer.model : null;
          const attemptedProvider =
            typeof analyzer.attempted_provider === "string" ? analyzer.attempted_provider : null;
          const attemptedModel = typeof analyzer.attempted_model === "string" ? analyzer.attempted_model : null;
          const candidateSourceCounts =
            analyzer.candidate_source_counts &&
            typeof analyzer.candidate_source_counts === "object" &&
            !Array.isArray(analyzer.candidate_source_counts)
              ? (analyzer.candidate_source_counts as Record<string, unknown>)
              : {};
          const providerCandidateAudit =
            analyzer.provider_candidate_audit &&
            typeof analyzer.provider_candidate_audit === "object" &&
            !Array.isArray(analyzer.provider_candidate_audit)
              ? (analyzer.provider_candidate_audit as Record<string, unknown>)
              : {};

          return {
            analysisMode,
            analysisModeLabel: normalizeAnalyzerModeLabel(analysisMode),
            promptVersion: typeof analyzer.prompt_version === "string" ? analyzer.prompt_version : null,
            provider,
            providerLabel: normalizeAnalyzerProviderLabel(provider, analysisMode),
            model,
            modelLabel: normalizeAnalyzerModelLabel(model, analysisMode),
            attemptedProvider,
            attemptedProviderLabel: normalizeAnalyzerProviderLabel(attemptedProvider, null),
            attemptedModel,
            attemptedModelLabel: normalizeAnalyzerModelLabel(attemptedModel, null),
            providerRequestId: typeof analyzer.provider_request_id === "string" ? analyzer.provider_request_id : null,
            requestId: typeof analyzer.request_id === "string" ? analyzer.request_id : null,
            latencyMs: typeof analyzer.latency_ms === "number" ? analyzer.latency_ms : null,
            fallbackReason: typeof analyzer.fallback_reason === "string" ? analyzer.fallback_reason : null,
            fallbackTrigger: typeof analyzer.fallback_trigger === "string" ? analyzer.fallback_trigger : null,
            openaiCandidateCount:
              typeof candidateSourceCounts.openai === "number" ? candidateSourceCounts.openai : null,
            heuristicCandidateCount:
              typeof candidateSourceCounts.heuristic === "number" ? candidateSourceCounts.heuristic : null,
            providerCandidateAudit: {
              rawCandidateCount:
                typeof providerCandidateAudit.raw_candidate_count === "number"
                  ? providerCandidateAudit.raw_candidate_count
                  : null,
              acceptedBeforeNormalization:
                typeof providerCandidateAudit.accepted_before_normalization === "number"
                  ? providerCandidateAudit.accepted_before_normalization
                  : null,
              acceptedAfterDeduplication:
                typeof providerCandidateAudit.accepted_after_deduplication === "number"
                  ? providerCandidateAudit.accepted_after_deduplication
                  : null,
              rejectedBelowMinimumScore:
                typeof providerCandidateAudit.rejected_below_minimum_score === "number"
                  ? providerCandidateAudit.rejected_below_minimum_score
                  : null,
              rejectedBelowMinimumDuration:
                typeof providerCandidateAudit.rejected_below_minimum_duration === "number"
                  ? providerCandidateAudit.rejected_below_minimum_duration
                  : null,
              rejectedAboveMaximumDuration:
                typeof providerCandidateAudit.rejected_above_maximum_duration === "number"
                  ? providerCandidateAudit.rejected_above_maximum_duration
                  : null,
              removedByDeduplication:
                typeof providerCandidateAudit.removed_by_deduplication === "number"
                  ? providerCandidateAudit.removed_by_deduplication
                  : null,
              minimumViralScore:
                typeof providerCandidateAudit.minimum_viral_score === "number"
                  ? providerCandidateAudit.minimum_viral_score
                  : null,
              minimumDurationSeconds:
                typeof providerCandidateAudit.minimum_duration_seconds === "number"
                  ? providerCandidateAudit.minimum_duration_seconds
                  : null,
              maximumDurationSeconds:
                typeof providerCandidateAudit.maximum_duration_seconds === "number"
                  ? providerCandidateAudit.maximum_duration_seconds
                  : null
            }
          };
        })(),
        tts: ttsSummary
          ? {
              segmentCount: typeof ttsSummary.segment_count === "number" ? ttsSummary.segment_count : 0,
              totalPauseMs: typeof ttsSummary.total_pause_ms === "number" ? ttsSummary.total_pause_ms : 0,
              averagePauseMs:
                typeof ttsSummary.segment_count === "number" &&
                ttsSummary.segment_count > 0 &&
                typeof ttsSummary.total_pause_ms === "number"
                  ? Math.round(ttsSummary.total_pause_ms / ttsSummary.segment_count)
                  : 0,
              previewSegments: Array.isArray(ttsSummary.preview_segments)
                ? ttsSummary.preview_segments
                    .filter((segment): segment is Record<string, unknown> => Boolean(segment && typeof segment === "object"))
                    .slice(0, 5)
                    .map((segment) => ({
                      id: typeof segment.id === "number" ? segment.id : null,
                      text: typeof segment.text === "string" ? segment.text : "",
                      pauseAfter: typeof segment.pause_after === "number" ? segment.pause_after : null,
                      emotion: typeof segment.emotion === "string" ? segment.emotion : null,
                      speed: typeof segment.speed === "string" ? segment.speed : null,
                      emphasis: typeof segment.emphasis === "string" ? segment.emphasis : null
                    }))
                : [],
              fullSegments:
                ttsSummary.document &&
                typeof ttsSummary.document === "object" &&
                !Array.isArray(ttsSummary.document) &&
                Array.isArray((ttsSummary.document as Record<string, unknown>).segments)
                  ? ((ttsSummary.document as Record<string, unknown>).segments as unknown[])
                      .filter((segment): segment is Record<string, unknown> => Boolean(segment && typeof segment === "object"))
                      .map((segment) => ({
                        id: typeof segment.id === "number" ? segment.id : null,
                        text: typeof segment.text === "string" ? segment.text : "",
                        pauseAfter: typeof segment.pause_after === "number" ? segment.pause_after : null,
                        emotion: typeof segment.emotion === "string" ? segment.emotion : null,
                        speed: typeof segment.speed === "string" ? segment.speed : null,
                        emphasis: typeof segment.emphasis === "string" ? segment.emphasis : null,
                        volume: typeof segment.volume === "string" ? segment.volume : null,
                        breathBefore: typeof segment.breath_before === "boolean" ? segment.breath_before : null,
                        breathAfter: typeof segment.breath_after === "boolean" ? segment.breath_after : null,
                        fadeInMs: typeof segment.fade_in_ms === "number" ? segment.fade_in_ms : null,
                        fadeOutMs: typeof segment.fade_out_ms === "number" ? segment.fade_out_ms : null
                      }))
                  : [],
              metadata:
                ttsSummary.metadata && typeof ttsSummary.metadata === "object" && !Array.isArray(ttsSummary.metadata)
                  ? {
                      requestId: toOptionalString((ttsSummary.metadata as Record<string, unknown>).request_id),
                      provider: toOptionalString((ttsSummary.metadata as Record<string, unknown>).provider),
                      model: toOptionalString((ttsSummary.metadata as Record<string, unknown>).model),
                      providerRequestId: toOptionalString((ttsSummary.metadata as Record<string, unknown>).provider_request_id),
                      latencyMs: toOptionalNumber((ttsSummary.metadata as Record<string, unknown>).latency_ms),
                      promptVersion: toOptionalString((ttsSummary.metadata as Record<string, unknown>).prompt_version)
                    }
                  : null,
              audioOutput: latestTtsOutput
                ? {
                    status: latestTtsOutput.status,
                    version: latestTtsOutput.version,
                    durationMs: latestTtsOutput.durationMs ? Number(latestTtsOutput.durationMs) : null,
                    sampleRate: latestTtsOutput.mediaAsset?.audioSampleRate ?? null,
                    mimeType: latestTtsOutput.mediaAsset?.mimeType ?? null,
                    extension: latestTtsOutput.mediaAsset?.extension ?? null,
                    playbackUrl: ttsAudioPlaybackUrl,
                    mediaAssetId: latestTtsOutput.mediaAssetId,
                    objectKey: latestTtsOutput.mediaAsset?.objectKey ?? null,
                    requestedFormat:
                      latestTtsOutput.providerMetadata &&
                      typeof latestTtsOutput.providerMetadata === "object" &&
                      !Array.isArray(latestTtsOutput.providerMetadata)
                        ? toOptionalString((latestTtsOutput.providerMetadata as Record<string, unknown>).requested_format)
                        : null,
                    actualFormat:
                      latestTtsOutput.providerMetadata &&
                      typeof latestTtsOutput.providerMetadata === "object" &&
                      !Array.isArray(latestTtsOutput.providerMetadata)
                        ? toOptionalString((latestTtsOutput.providerMetadata as Record<string, unknown>).format)
                        : null,
                    fallbackUsed:
                      latestTtsOutput.providerMetadata &&
                      typeof latestTtsOutput.providerMetadata === "object" &&
                      !Array.isArray(latestTtsOutput.providerMetadata)
                        ? toOptionalBoolean((latestTtsOutput.providerMetadata as Record<string, unknown>).fallback_used)
                        : null,
                    fallbackReason:
                      latestTtsOutput.providerMetadata &&
                      typeof latestTtsOutput.providerMetadata === "object" &&
                      !Array.isArray(latestTtsOutput.providerMetadata)
                        ? toOptionalString((latestTtsOutput.providerMetadata as Record<string, unknown>).fallback_reason)
                        : null
                  }
                : null
            }
          : null,
        requestSnapshot: job.autoClipRequest
          ? {
              sourceType: job.autoClipRequest.sourceType,
              sourceLanguage: job.autoClipRequest.sourceLanguage ?? null,
              speakerCount: job.autoClipRequest.speakerCount ?? null,
              topic: job.autoClipRequest.topic ?? null,
              contentTitle: job.autoClipRequest.contentTitle ?? null,
              contentContext: job.autoClipRequest.contentContext ?? null,
              customVocabulary: toStringArray(job.autoClipRequest.customVocabulary),
              strategy: {
                targetPlatform: toOptionalString(strategyConfig.target_platform),
                objective: toOptionalString(strategyConfig.objective),
                tones: toStringArray(strategyConfig.tones),
                desiredClipCount: toOptionalNumber(strategyConfig.desired_clip_count),
                candidatePoolCount: toOptionalNumber(strategyConfig.candidate_pool_count),
                minimumDurationSeconds: toOptionalNumber(strategyConfig.minimum_duration_seconds),
                maximumDurationSeconds: toOptionalNumber(strategyConfig.maximum_duration_seconds),
                minimumViralScore: toOptionalNumber(strategyConfig.minimum_viral_score),
                preferredTopics: toStringArray(strategyConfig.preferred_topics),
                topicsToAvoid: toStringArray(strategyConfig.topics_to_avoid),
                sensitiveTopics: toStringArray(strategyConfig.sensitive_topics),
                clipStyleTags: toStringArray(strategyConfig.clip_style_tags),
                viralityPriorities: toStringArray(strategyConfig.virality_priorities),
                selectionBrief: toOptionalString(strategyConfig.selection_brief),
                avoidanceBrief: toOptionalString(strategyConfig.avoidance_brief),
                packagingBrief: toOptionalString(strategyConfig.packaging_brief),
                hookStyle: toOptionalString(strategyConfig.hook_style),
                ctaPreference: toOptionalString(strategyConfig.cta_preference),
                standalonePriority: toOptionalString(strategyConfig.standalone_priority),
                requireSpokenAudio: toOptionalBoolean(strategyConfig.require_spoken_audio),
                profanityHandling: toOptionalString(strategyConfig.profanity_handling),
                speechCleanupEnabled: toOptionalBoolean(strategyConfig.speech_cleanup_enabled) ?? false,
                removeLongSilence: toOptionalBoolean(strategyConfig.remove_long_silence) ?? false,
                removeFillerWords: toOptionalBoolean(strategyConfig.remove_filler_words) ?? false
              },
              visual: {
                aspectRatio: toOptionalString(visualConfig.aspect_ratio),
                cropStrategy: toOptionalString(visualConfig.crop_strategy),
                layoutTemplate: toOptionalString(toJsonRecord(visualConfig.settings).layout_template) ?? "STANDARD",
                podcastSourceEnabled:
                  toOptionalBoolean(toJsonRecord(visualConfig.settings).podcast_source_enabled) ?? true,
                podcastSpotlightStyle:
                  toOptionalString(toJsonRecord(visualConfig.settings).podcast_spotlight_style) ?? "EDITORIAL_GOLD",
                headlineOverlayEnabled:
                  toOptionalBoolean(toJsonRecord(visualConfig.settings).headline_overlay_enabled) ?? true,
                headlineOverlayPosition:
                  toOptionalString(toJsonRecord(visualConfig.settings).headline_overlay_position) ?? "BOTTOM",
                framingDetectionMode:
                  toOptionalString(toJsonRecord(visualConfig.settings).framing_detection_mode) ?? "COMBINED",
                splitOnMultiFace:
                  toOptionalBoolean(toJsonRecord(visualConfig.settings).split_on_multi_face) ?? true,
                splitMinFaceCount:
                  toOptionalNumber(toJsonRecord(visualConfig.settings).split_min_face_count) ?? 2
              },
              subtitle: {
                enabled: toOptionalBoolean(subtitleConfig.enabled),
                language: toOptionalString(subtitleConfig.language),
                burnIn: toOptionalBoolean(subtitleConfig.burn_in),
                exportFormats: toStringArray(subtitleConfig.export_formats),
                style: toOptionalString(toJsonRecord(subtitleConfig.settings).style),
                fontFamily: toOptionalString(toJsonRecord(subtitleConfig.settings).font_family),
                position: toOptionalString(toJsonRecord(subtitleConfig.settings).position),
                maxLines: toOptionalNumber(toJsonRecord(subtitleConfig.settings).max_lines),
                safeMarginPercent: toOptionalNumber(toJsonRecord(subtitleConfig.settings).safe_margin_percent),
                profanityCensor: toOptionalBoolean(toJsonRecord(subtitleConfig.settings).profanity_censor),
                typoCorrection: toOptionalBoolean(toJsonRecord(subtitleConfig.settings).typo_correction),
                wordHighlight: toOptionalBoolean(toJsonRecord(subtitleConfig.settings).word_highlight),
                textCase: toOptionalString(toJsonRecord(subtitleConfig.settings).text_case) ?? "UPPERCASE"
              },
              provider: {
                credentialMode: toOptionalString(providerConfig.credential_mode),
                providerId: toOptionalString(providerConfig.provider_id),
                analysisModelId: toOptionalString(providerConfig.analysis_model_id)
              }
            }
          : null,
        ttsRequestSnapshot: job.ttsRequest
          ? {
              script: job.ttsRequest.script,
              language: job.ttsRequest.language,
              localModelKey:
                toOptionalString(ttsInputSnapshot.local_model_key) ??
                toOptionalString(ttsOutputConfig.local_model_key) ??
                null,
              voiceIdentifier: job.ttsRequest.voiceIdentifier ?? null,
              speakingStyle: job.ttsRequest.speakingStyle ?? null,
              emotion: job.ttsRequest.emotion ?? null,
              speakingSpeed: job.ttsRequest.speakingSpeed ? Number(job.ttsRequest.speakingSpeed) : null,
              pitch: job.ttsRequest.pitch ? Number(job.ttsRequest.pitch) : null,
              pauseIntensity: job.ttsRequest.pauseIntensity ? Number(job.ttsRequest.pauseIntensity) : null,
              targetDurationMs: job.ttsRequest.targetDurationMs ? Number(job.ttsRequest.targetDurationMs) : null,
              preferredFormat: toOptionalString(ttsOutputConfig.preferred_format),
              segmentationMode: toOptionalString(ttsOutputConfig.segmentation_mode) ?? "LOCAL_HEURISTIC",
              sampleRate: toOptionalNumber(ttsOutputConfig.sample_rate),
              channels: toOptionalNumber(ttsOutputConfig.channels),
              userPreferences:
                ttsOutputConfig.user_preferences && typeof ttsOutputConfig.user_preferences === "object" && !Array.isArray(ttsOutputConfig.user_preferences)
                  ? {
                      toneNotes: toOptionalString((ttsOutputConfig.user_preferences as Record<string, unknown>).tone_notes),
                      deliveryGoal: toOptionalString((ttsOutputConfig.user_preferences as Record<string, unknown>).delivery_goal),
                      segmentLengthPreference: toOptionalString((ttsOutputConfig.user_preferences as Record<string, unknown>).segment_length_preference),
                      breathingStyle: toOptionalString((ttsOutputConfig.user_preferences as Record<string, unknown>).breathing_style)
                    }
                  : null
            }
          : null
      },
      csrfToken: request.session.csrfToken
    });
  })
);

dashboardRouter.get(
  "/app/tools/text-to-speech",
  requireAuth,
  asyncHandler(async (request, response) => {
    const userId = request.identity!.effectiveUserId;
    const [user, ttsPresets, localTtsModels] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          setting: {
            select: {
              defaultContentNiche: true,
              defaultAudience: true
            }
          }
        }
      }),
      loadOptionalTtsPresets(userId),
      loadOptionalLocalTtsModels()
    ]);

    const selectedPreset = ttsPresets.find((preset) => preset.isDefault) ?? ttsPresets[0] ?? null;
    const presetConfig = toJsonRecord(selectedPreset?.config);
    const defaultLocalModel =
      localTtsModels.find(
        (model) => model.available && /^id(?:_|-)/i.test(model.languageCode)
      ) ??
      localTtsModels.find((model) => model.available) ??
      null;
    const selectedLocalModelKey =
      toOptionalString(presetConfig.local_model_key) ??
      toOptionalString(presetConfig.voice_identifier) ??
      defaultLocalModel?.key ??
      "";
    const selectedLocalModel =
      localTtsModels.find((model) => model.key === selectedLocalModelKey && model.available) ??
      defaultLocalModel;
    const effectiveLocalModelKey = selectedLocalModel?.key ?? "";
    response.render("app/text-to-speech", {
      title: "Text to Speech",
      ttsPresets: ttsPresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        isDefault: preset.isDefault,
        config: toJsonRecord(preset.config)
      })),
      localTtsModels: localTtsModels.map((model) => ({
        key: model.key,
        displayName: model.displayName,
        languageCode: model.languageCode,
        localeGroup: model.localeGroup,
        voiceName: model.voiceName,
        quality: model.quality,
        sampleRate: model.sampleRate,
        speakerCount: model.speakerCount,
        phonemeType: model.phonemeType,
        dataset: model.dataset,
        defaultSampleText: model.defaultSampleText,
        engine: model.engine,
        baseModelKey: model.baseModelKey,
        profileKind: model.profileKind,
        description: model.description,
        gender: model.gender,
        ageGroup: model.ageGroup,
        character: model.character,
        intonation: model.intonation,
        speakingStyle: model.speakingStyle,
        licenseName: model.licenseName,
        licenseUrl: model.licenseUrl,
        available: model.available
      })),
      selectedPresetId: selectedPreset?.id ?? "",
      formDefaults: {
        language: toOptionalString(presetConfig.language) ?? "id",
        localModelKey: effectiveLocalModelKey,
        voiceIdentifier: toOptionalString(presetConfig.voice_identifier) ?? "",
        speakingStyle: toOptionalString(presetConfig.speaking_style) ?? "documentary",
        emotion: toOptionalString(presetConfig.emotion) ?? "serious",
        speakingSpeed: toOptionalNumber(presetConfig.speaking_speed) ?? 1,
        pitch: toOptionalNumber(presetConfig.pitch) ?? 0,
        pauseIntensity: toOptionalNumber(presetConfig.pause_intensity) ?? 1,
        targetDurationMs: toOptionalNumber(presetConfig.target_duration_ms) ?? "",
        preferredFormat: toOptionalString(presetConfig.preferred_format) ?? "WAV",
        segmentationMode: toOptionalString(presetConfig.segmentation_mode) ?? "LOCAL_HEURISTIC",
        sampleRate: toOptionalNumber(presetConfig.sample_rate) ?? 24000,
        channels: toOptionalNumber(presetConfig.channels) ?? 1,
        toneNotes: toOptionalString(presetConfig.tone_notes) ?? "",
        deliveryGoal: toOptionalString(presetConfig.delivery_goal) ?? "",
        segmentLengthPreference: toOptionalString(presetConfig.segment_length_preference) ?? "BALANCED",
        breathingStyle: toOptionalString(presetConfig.breathing_style) ?? "NATURAL",
        samplePreviewText:
          toOptionalString(presetConfig.sample_preview_text) ??
          selectedLocalModel?.defaultSampleText ??
          "Halo, ini adalah sample suara untuk preview model TTS.",
        audienceHint: user?.setting?.defaultAudience ?? "",
        nicheHint: user?.setting?.defaultContentNiche ?? ""
      },
      csrfToken: request.session.csrfToken
    });
  })
);

dashboardRouter.post(
  "/api/v1/tts/local-model-preview",
  requireAuth,
  validateBody(ttsModelPreviewSchema),
  asyncHandler(async (request, response) => {
    const body = request.validatedBody as {
      model_key: string;
      text?: string;
    };
    const sampleText = typeof body.text === "string" && body.text.trim().length > 0 ? body.text.trim() : undefined;
    const previewUrl = new URL(
      `/internal/v1/tts/models/${encodeURIComponent(body.model_key)}/preview`,
      env.AI_MEDIA_PYTHON_INTERNAL_BASE_URL
    );
    if (sampleText) {
      previewUrl.searchParams.set("text", sampleText);
    }

    const previewResponse = await fetch(previewUrl, {
      headers: {
        authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`
      }
    });

    if (!previewResponse.ok) {
      const detail = await previewResponse.text();
      response.status(previewResponse.status).json({
        error: {
          code: "TTS_PREVIEW_FAILED",
          message: detail || "Preview suara model lokal tidak bisa dibuat saat ini."
        }
      });
      return;
    }

    const contentType = previewResponse.headers.get("content-type") || "audio/wav";
    const audioBuffer = Buffer.from(await previewResponse.arrayBuffer());
    response.setHeader("content-type", contentType);
    response.setHeader("cache-control", "no-store");
    response.send(audioBuffer);
  })
);

dashboardRouter.get(
  "/app/tools/auto-clipping",
  requireAuth,
  asyncHandler(async (request, response) => {
    const userId = request.identity!.effectiveUserId;
    const [assets, user, clippingPresets, brandKits] = await Promise.all([
      prisma.mediaAsset.findMany({
        where: { userId, status: "READY", deletedAt: null, type: "VIDEO" },
        orderBy: { createdAt: "desc" },
        take: 100
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          setting: {
            select: {
              defaultContentNiche: true,
              defaultAudience: true,
              preferences: true
            }
          }
        }
      }),
      loadOptionalAutoClipPresets(userId),
      loadOptionalBrandKits(userId)
    ]);
    const userPreferences = toJsonRecord(user?.setting?.preferences);
    const preferredBrandKitId = toStringValue(userPreferences.preferred_brand_kit_id) ?? "";
    const selectedPreset = clippingPresets.find((preset) => preset.isDefault) ?? clippingPresets[0] ?? null;
    const selectedBrandKit =
      brandKits.find((brandKit) => brandKit.id === preferredBrandKitId)
      ?? brandKits.find((brandKit) => brandKit.isDefault)
      ?? brandKits[0]
      ?? null;
    const formDefaults = mergeAutoClipDefaults(
      buildAutoClipFormDefaults(
        user?.setting?.defaultContentNiche,
        user?.setting?.defaultAudience,
        toStringValue(userPreferences.channel_name),
        toStringValue(userPreferences.channel_tagline)
      ),
      selectedPreset?.config,
      selectedBrandKit
        ? {
            fontConfig: selectedBrandKit.fontConfig,
            safeMarginConfig: selectedBrandKit.safeMarginConfig,
            subtitlePreset: selectedBrandKit.subtitlePreset
          }
        : null
    );
    response.render("app/auto-clipping", {
      title: "Auto Clipping",
      assets,
      formDefaults,
      clippingPresets: clippingPresets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        isDefault: preset.isDefault,
        config: toJsonRecord(preset.config)
      })),
      brandKits: brandKits.map((brandKit) => ({
        id: brandKit.id,
        name: brandKit.name,
        isDefault: brandKit.isDefault,
        fontConfig: toJsonRecord(brandKit.fontConfig),
        colorConfig: toJsonRecord(brandKit.colorConfig),
        safeMarginConfig: toJsonRecord(brandKit.safeMarginConfig),
        subtitlePreset: toJsonRecord(brandKit.subtitlePreset)
      })),
      selectedPresetId: selectedPreset?.id ?? "",
      selectedBrandKitId: selectedBrandKit?.id ?? "",
      csrfToken: request.session.csrfToken
    });
  })
);

async function loadOptionalAutoClipPresets(userId: string) {
  try {
    return await prisma.preset.findMany({
      where: { userId, type: "CLIPPING", deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }]
    });
  } catch (error) {
    logger.warn({ userId, err: error }, "Failed to load clipping presets for auto-clipping page; falling back to defaults");
    return [];
  }
}

async function loadOptionalTtsPresets(userId: string) {
  try {
    return await prisma.preset.findMany({
      where: { userId, type: "TTS", deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }]
    });
  } catch (error) {
    logger.warn({ userId, err: error }, "Failed to load TTS presets; continuing with manual defaults");
    return [];
  }
}

async function loadOptionalLocalTtsModels() {
  try {
    return (await listLocalTtsModels()).filter(isValidLocalTtsModel);
  } catch (error) {
    logger.warn({ err: error }, "Failed to load local TTS models; continuing with empty model list");
    return [];
  }
}

async function loadOptionalBrandKits(userId: string) {
  try {
    return await prisma.brandKit.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }]
    });
  } catch (error) {
    logger.warn({ userId, err: error }, "Failed to load brand kits for auto-clipping page; continuing without brand kits");
    return [];
  }
}

function countBy<T>(items: T[], keySelector: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keySelector(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()];
}

function resolveJobProgressView(status: JobStatus, progressPercent: number, currentStage: string | null) {
  if (status === "COMPLETED") {
    return {
      percent: 100,
      stage: TERMINAL_JOB_DISPLAY_STAGE[status] ?? currentStage ?? status
    };
  }

  if (status === "FAILED" || status === "CANCELED" || status === "NEEDS_REVIEW") {
    return {
      percent: Math.min(Math.max(progressPercent, 0), 99),
      stage: TERMINAL_JOB_DISPLAY_STAGE[status] ?? currentStage ?? status
    };
  }

  if (status === "PARTIALLY_COMPLETED") {
    return {
      percent: Math.max(progressPercent, 100),
      stage: TERMINAL_JOB_DISPLAY_STAGE[status] ?? currentStage ?? status
    };
  }

  return {
    percent: Math.max(0, Math.min(100, progressPercent)),
    stage: currentStage
  };
}

function buildDailyTrend(dates: Date[], start: Date, days: number) {
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = date.toISOString().slice(0, 10);
    return { key, label: key.slice(5), count: 0 };
  });
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const date of dates) {
    const key = date.toISOString().slice(0, 10);
    const bucket = bucketMap.get(key);
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

function buildScoreRanges(scores: number[]) {
  const ranges = [
    { label: "< 6", count: 0 },
    { label: "6 - 7.9", count: 0 },
    { label: "8 - 8.9", count: 0 },
    { label: ">= 9", count: 0 }
  ];
  for (const score of scores) {
    if (score < 6 && ranges[0]) ranges[0].count += 1;
    else if (score < 8 && ranges[1]) ranges[1].count += 1;
    else if (score < 9 && ranges[2]) ranges[2].count += 1;
    else if (ranges[3]) ranges[3].count += 1;
  }
  return ranges;
}

function buildWorkspaceAlerts(counts: Record<string, number>) {
  const alerts: string[] = [];
  if ((counts.FAILED ?? 0) > 0) alerts.push(`${counts.FAILED} job failed and may need retry.`);
  if ((counts.NEEDS_REVIEW ?? 0) > 0) alerts.push(`${counts.NEEDS_REVIEW} job is waiting for review.`);
  if ((counts.RUNNING ?? 0) > 3) alerts.push("Several jobs are running in parallel. Watch processing backlog.");
  return alerts;
}

function formatDuration(ms: number) {
  const totalMinutes = Math.max(1, Math.floor(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function buildAutoClipFormDefaults(
  defaultContentNiche?: string | null,
  defaultAudience?: string | null,
  channelName?: string | null,
  channelTagline?: string | null
) {
  return {
    sourceLanguage: "id",
    speakerCount: 1,
    customVocabulary: "OpenAI, ChatGPT, AI, retention, hook, CTA",
    topic: "Strategi konten short-form yang bikin penonton bertahan sampai akhir",
    niche: defaultContentNiche?.trim() || "Edukasi content creator",
    targetAudience:
      defaultAudience?.trim() || "Content creator pemula, social media manager, dan owner bisnis kecil",
    platform: "YOUTUBE_SHORTS",
    objective: "EDUCATION",
    primaryTone: "EDUCATIONAL",
    secondaryTone: "CONFIDENT",
    clipCount: 5,
    candidatePoolCount: 10,
    minDuration: 30,
    maxDuration: 55,
    minimumViralScore: 7.5,
    hookStyle: "",
    ctaPreference: "",
    clipStyleTags: "storytelling, edukasi, shocking, jawaban_tajam",
    viralityPriorities: "hook 0-2 detik, konflik, opini nendang, ending memancing komentar",
    selectionBrief: [
      "Prioritaskan momen yang langsung masuk ke inti masalah tanpa basa-basi.",
      "Cari jawaban yang quotable, opini tajam, cerita dengan payoff jelas, atau konflik yang cepat dimengerti.",
      "Kalau ada beberapa pilihan kuat, utamakan yang paling singkat tetapi tetap utuh dan terasa viral."
    ].join(" "),
    avoidanceBrief: [
      "Hindari intro panjang, filler berulang, kalimat menggantung tanpa payoff, dan potongan yang baru menarik setelah setup terlalu lama.",
      "Jangan pilih momen yang butuh konteks panjang, terlalu internal, atau terlalu bergantung ke visual kalau spoken value-nya lemah."
    ].join(" "),
    packagingBrief: [
      "Hook text harus pendek, tajam, dan memancing rasa penasaran.",
      "Utamakan caption yang mudah dipahami audience Indonesia dan hashtag yang relevan, natural, dan tidak spammy."
    ].join(" "),
    standalonePriority: "FLEXIBLE",
    requireSpokenAudio: true,
    profanityHandling: "KEEP",
    preferredTopics: "hook 3 detik pertama, audience retention, storytelling, CTA komentar",
    topicsToAvoid: "politik partisan, SARA, klaim medis berisiko",
    contentContext: [
      "Anda adalah editor short video Indonesia untuk TikTok, Reels, dan YouTube Shorts.",
      "Cari momen paling potensial viral, bukan sekadar potongan rapi.",
      "Pilih potongan yang paling cepat menarik perhatian, paling mudah dipahami tanpa konteks panjang, dan punya alasan kuat untuk ditonton sampai akhir.",
      "Prioritaskan momen dengan hook kuat di 1-3 detik pertama, konflik atau rasa penasaran yang jelas, insight praktis, bahasa natural, dan payoff yang selesai dengan rapi.",
      "Utamakan opini nendang, cerita pengalaman pribadi, perdebatan, jawaban tajam, insight yang shareable, dan ending yang memancing komentar.",
      "Jika ada beberapa kandidat, utamakan yang durasinya paling pendek tetapi tetap utuh secara makna.",
      "Hindari opening yang masih basa-basi, filler berulang, jeda kosong, transisi yang tidak penting, atau bagian yang baru menarik setelah terlalu lama setup.",
      "Jangan pilih momen hanya karena keyword. Pilih karena ada emosi, konflik, ironi, insight, atau curiosity gap yang jelas.",
      "Jangan pernah memotong saat pembicara masih mulai menjelaskan, masih menjawab setengah, masih menggantung dengan kata sambung seperti karena, jadi, makanya, kalau, atau saat kalimat sesudahnya jelas masih menyelesaikan poin utama.",
      "Untuk konten edukatif, utamakan clip yang benar-benar menyelesaikan penjelasan inti, meski perlu tambahan 2-8 detik, selama hasilnya tetap tajam dan tidak melewati batas durasi.",
      "Cari ending yang bisa memicu komentar, share, save, atau diskusi, bukan ending yang menggantung tanpa payoff.",
      "Kalau sumber videonya edukatif, pilih bagian yang menyederhanakan ide rumit menjadi kalimat yang tajam dan mudah dipotong menjadi clip mandiri.",
      "Kalau ada istilah teknis, utamakan bagian yang paling jelas, paling quotable, dan paling relevan untuk audience Indonesia.",
      "Jika akhir clip masih terasa seperti setup untuk kalimat berikutnya, anggap kandidat itu gagal dan pilih atau perpanjang sampai jawabannya benar-benar landing."
    ].join(" "),
    sensitiveTopics: "klaim medis, saran legal, data pribadi",
    aspectRatio: "9:16",
    cropStrategy: "SMART_SPEAKER",
    subtitleLanguage: "id",
    subtitlePrimaryFormat: "ASS",
    subtitleEnabled: true,
    subtitleBurnIn: true,
    subtitleStyle: "PODCAST_HIGHLIGHT",
    subtitleTextCase: "UPPERCASE",
    subtitleFontFamily: "Montserrat",
    subtitlePosition: "BOTTOM",
    subtitleMaxLines: 2,
    subtitleSafeMarginPercent: 20,
    layoutTemplate: "STANDARD",
    podcastSourceEnabled: true,
    podcastSpotlightStyle: "EDITORIAL_GOLD",
    headlineOverlayEnabled: true,
    headlineOverlayPosition: "BOTTOM",
    framingDetectionMode: "COMBINED",
    splitOnMultiFace: true,
    splitMinFaceCount: 2,
    channelName: channelName?.trim() || "",
    channelTagline: channelTagline?.trim() || ""
  };
}

function isValidLocalTtsModel(model: unknown): model is {
  key: string;
  displayName: string;
  languageCode: string;
  localeGroup: string;
  voiceName: string;
  quality: string | null;
  sampleRate: number | null;
  speakerCount: number | null;
  phonemeType: string | null;
  dataset: string | null;
  defaultSampleText: string;
  engine: "piper";
  baseModelKey: string;
  profileKind: "derived" | "checkpoint";
  description: string;
  gender: string | null;
  ageGroup: string | null;
  character: string | null;
  intonation: string | null;
  speakingStyle: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  available: boolean;
} {
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return false;
  }
  const value = model as Record<string, unknown>;
  const requiredStringsValid = [
    value.key,
    value.displayName,
    value.languageCode,
    value.localeGroup,
    value.voiceName,
    value.defaultSampleText,
    value.baseModelKey,
    value.description
  ].every((entry) => typeof entry === "string");
  return (
    requiredStringsValid &&
    value.engine === "piper" &&
    (value.profileKind === "derived" || value.profileKind === "checkpoint") &&
    typeof value.available === "boolean"
  );
}

function mergeAutoClipDefaults(
  baseDefaults: ReturnType<typeof buildAutoClipFormDefaults>,
  presetConfigValue?: unknown,
  brandKitValue?: {
    fontConfig: unknown;
    safeMarginConfig: unknown;
    subtitlePreset: unknown;
  } | null
) {
  const presetConfig = toJsonRecord(presetConfigValue);
  const durations = toJsonRecord(presetConfig.durations);
  const subtitleConfig = toJsonRecord(presetConfig.subtitle);
  const fontConfig = toJsonRecord(brandKitValue?.fontConfig);
  const safeMarginConfig = toJsonRecord(brandKitValue?.safeMarginConfig);
  const subtitlePreset = toJsonRecord(brandKitValue?.subtitlePreset);

  return {
    ...baseDefaults,
    platform: toStringValue(presetConfig.target_platform) ?? baseDefaults.platform,
    objective: toStringValue(presetConfig.objective) ?? baseDefaults.objective,
    clipCount: toNumberValue(presetConfig.desired_clip_count) ?? baseDefaults.clipCount,
    candidatePoolCount: toNumberValue(presetConfig.candidate_pool_count) ?? baseDefaults.candidatePoolCount,
    minDuration: toNumberValue(durations.min_seconds) ?? baseDefaults.minDuration,
    maxDuration: toNumberValue(durations.max_seconds) ?? baseDefaults.maxDuration,
    minimumViralScore: toNumberValue(presetConfig.minimum_viral_score) ?? baseDefaults.minimumViralScore,
    hookStyle: toStringValue(presetConfig.hook_style) ?? baseDefaults.hookStyle,
    ctaPreference: toStringValue(presetConfig.cta_preference) ?? baseDefaults.ctaPreference,
    clipStyleTags: toCommaListValue(presetConfig.clip_style_tags) ?? baseDefaults.clipStyleTags,
    viralityPriorities: toCommaListValue(presetConfig.virality_priorities) ?? baseDefaults.viralityPriorities,
    selectionBrief:
      toStringValue(presetConfig.selection_brief)
      ?? toStringValue(presetConfig.clip_selection_brief)
      ?? baseDefaults.selectionBrief,
    avoidanceBrief:
      toStringValue(presetConfig.avoidance_brief)
      ?? toStringValue(presetConfig.clip_avoidance_brief)
      ?? baseDefaults.avoidanceBrief,
    packagingBrief:
      toStringValue(presetConfig.packaging_brief)
      ?? toStringValue(presetConfig.packaging_brief_long)
      ?? baseDefaults.packagingBrief,
    standalonePriority: toStringValue(presetConfig.standalone_priority) ?? baseDefaults.standalonePriority,
    requireSpokenAudio: toOptionalBoolean(presetConfig.require_spoken_audio) ?? baseDefaults.requireSpokenAudio,
    aspectRatio: toStringValue(presetConfig.aspect_ratio) ?? baseDefaults.aspectRatio,
    preferredTopics: toCommaListValue(presetConfig.preferred_topics) ?? baseDefaults.preferredTopics,
    topicsToAvoid: toCommaListValue(presetConfig.topics_to_avoid) ?? baseDefaults.topicsToAvoid,
    contentContext:
      toStringValue(presetConfig.content_context)
      ?? toStringValue(presetConfig.analysis_brief)
      ?? toStringValue(presetConfig.editor_brief)
      ?? baseDefaults.contentContext,
    sensitiveTopics: toCommaListValue(presetConfig.sensitive_topics) ?? baseDefaults.sensitiveTopics,
    subtitleLanguage: toStringValue(subtitleConfig.language) ?? baseDefaults.subtitleLanguage,
    subtitlePrimaryFormat:
      toStringValue(subtitleConfig.format)
      ?? toStringArray(subtitleConfig.export_formats)[0]
      ?? baseDefaults.subtitlePrimaryFormat,
    subtitleEnabled: toOptionalBoolean(subtitleConfig.enabled) ?? baseDefaults.subtitleEnabled,
    subtitleBurnIn: toOptionalBoolean(subtitleConfig.burn_in) ?? baseDefaults.subtitleBurnIn,
    subtitleStyle: toStringValue(subtitleConfig.style) ?? baseDefaults.subtitleStyle,
    subtitleTextCase:
      toStringValue(subtitlePreset.text_case) ??
      toStringValue(subtitleConfig.text_case) ??
      baseDefaults.subtitleTextCase,
    subtitleFontFamily:
      toStringValue(subtitleConfig.font_family) ?? toStringValue(fontConfig.primary) ?? baseDefaults.subtitleFontFamily,
    subtitlePosition:
      toStringValue(subtitlePreset.position) ?? toStringValue(subtitleConfig.position) ?? baseDefaults.subtitlePosition,
    subtitleMaxLines:
      toNumberValue(subtitlePreset.max_lines) ?? toNumberValue(subtitleConfig.max_lines) ?? baseDefaults.subtitleMaxLines,
    subtitleSafeMarginPercent:
      toNumberValue(subtitlePreset.safe_margin_percent) ??
      toNumberValue(safeMarginConfig.bottom_percent) ??
      baseDefaults.subtitleSafeMarginPercent,
    layoutTemplate:
      toStringValue(presetConfig.layout_template)
      ?? toStringValue(presetConfig.layoutTemplate)
      ?? baseDefaults.layoutTemplate,
    podcastSourceEnabled:
      toOptionalBoolean(presetConfig.podcast_source_enabled)
      ?? toOptionalBoolean(presetConfig.podcastSourceEnabled)
      ?? baseDefaults.podcastSourceEnabled,
    podcastSpotlightStyle:
      toStringValue(presetConfig.podcast_spotlight_style)
      ?? toStringValue(presetConfig.podcastSpotlightStyle)
      ?? baseDefaults.podcastSpotlightStyle,
    headlineOverlayEnabled:
      toOptionalBoolean(presetConfig.headline_overlay_enabled)
      ?? toOptionalBoolean(presetConfig.headlineOverlayEnabled)
      ?? baseDefaults.headlineOverlayEnabled,
    headlineOverlayPosition:
      toStringValue(presetConfig.headline_overlay_position)
      ?? toStringValue(presetConfig.headlineOverlayPosition)
      ?? baseDefaults.headlineOverlayPosition,
    framingDetectionMode:
      toStringValue(presetConfig.framing_detection_mode)
      ?? toStringValue(presetConfig.framingDetectionMode)
      ?? baseDefaults.framingDetectionMode,
    splitOnMultiFace:
      toOptionalBoolean(presetConfig.split_on_multi_face)
      ?? toOptionalBoolean(presetConfig.splitOnMultiFace)
      ?? baseDefaults.splitOnMultiFace,
    splitMinFaceCount:
      toNumberValue(presetConfig.split_min_face_count)
      ?? toNumberValue(presetConfig.splitMinFaceCount)
      ?? baseDefaults.splitMinFaceCount
  };
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toCommaListValue(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length > 0 ? items.join(", ") : undefined;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function toOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isJobStatus(value: string | undefined): value is JobStatus {
  return typeof value === "string" && value in JobStatus;
}

function isJobType(value: string | undefined): value is JobType {
  return typeof value === "string" && value in JobType;
}

dashboardRouter.get(
  "/admin/dashboard",
  requireAuth,
  requirePermission("admin.dashboard.view"),
  asyncHandler(async (request, response) => {
    const [
      users,
      jobGroups,
      recentUsers,
      userStatusGroups,
      providerCount,
      enabledProviderCount,
      featureFlagCount,
      enabledFeatureFlagCount,
      systemSettingCount,
      secretSystemSettingCount,
      importedSourceMediaCount,
      clipResultMediaCount,
      ttsOutputMediaCount,
      subtitleArtifactCount
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.job.groupBy({ by: ["status"], _count: true }),
      prisma.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10 }),
      prisma.user.groupBy({ by: ["status"], _count: true }),
      prisma.aiProvider.count(),
      prisma.aiProvider.count({ where: { enabled: true } }),
      prisma.featureFlag.count(),
      prisma.featureFlag.count({ where: { enabled: true } }),
      prisma.systemSetting.count(),
      prisma.systemSetting.count({ where: { isSecret: true } }),
      prisma.mediaAsset.count({
        where: {
          deletedAt: null,
          OR: [{ sourceJobs: { some: {} } }, { transcripts: { some: {} } }]
        }
      }),
      prisma.mediaAsset.count({
        where: {
          deletedAt: null,
          OR: [{ clipOutputs: { some: {} } }, { metadata: { path: ["source"], equals: "clip-output-render" } }]
        }
      }),
      prisma.mediaAsset.count({
        where: {
          deletedAt: null,
          OR: [{ ttsOutputs: { some: {} } }, { metadata: { path: ["source"], equals: "tts-render" } }]
        }
      }),
      prisma.mediaAsset.count({
        where: {
          deletedAt: null,
          OR: [{ subtitleAssets: { some: {} } }, { type: "SUBTITLE" }]
        }
      })
    ]);
    const jobCounts = Object.fromEntries(jobGroups.map((item) => [item.status, item._count]));
    const userStatusCounts = Object.fromEntries(userStatusGroups.map((item) => [item.status, item._count]));
    response.render("admin/dashboard", {
      title: "Admin Dashboard",
      users,
      jobCounts,
      userStatusCounts,
      providerSummary: {
        total: providerCount,
        enabled: enabledProviderCount,
        disabled: Math.max(0, providerCount - enabledProviderCount)
      },
      featureSummary: {
        total: featureFlagCount,
        enabled: enabledFeatureFlagCount
      },
      systemSummary: {
        total: systemSettingCount,
        secret: secretSystemSettingCount
      },
      mediaSummary: {
        importedSource: importedSourceMediaCount,
        clipResults: clipResultMediaCount,
        ttsOutputs: ttsOutputMediaCount,
        subtitleArtifacts: subtitleArtifactCount
      },
      recentUsers,
      csrfToken: request.session.csrfToken
    });
  })
);
