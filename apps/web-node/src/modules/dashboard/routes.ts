import { Router } from "express";
import { JobStatus, JobType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";

export const dashboardRouter = Router();

const DASHBOARD_DAYS = 7;

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
        sourceMediaAsset: { select: { displayName: true, durationMs: true } },
        attempts: { orderBy: { attemptNumber: "desc" } },
        errors: { orderBy: { occurredAt: "desc" } },
        stages: { orderBy: { createdAt: "asc" } },
        clipCandidates: { orderBy: [{ rank: "asc" }, { createdAt: "asc" }] },
        clipOutputs: {
          include: {
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
          analyzer: null
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
    const analyzer =
      outputSummary?.analyzer && typeof outputSummary.analyzer === "object" && !Array.isArray(outputSummary.analyzer)
        ? (outputSummary.analyzer as Record<string, unknown>)
        : null;
    const candidates = job.clipCandidates.map((candidate) => {
      const scoreBreakdown =
        candidate.scoreBreakdown && typeof candidate.scoreBreakdown === "object" && !Array.isArray(candidate.scoreBreakdown)
          ? (candidate.scoreBreakdown as Record<string, unknown>)
          : {};
      const metadataSuggestions =
        candidate.metadataSuggestions &&
        typeof candidate.metadataSuggestions === "object" &&
        !Array.isArray(candidate.metadataSuggestions)
          ? (candidate.metadataSuggestions as Record<string, unknown>)
          : {};
      const hashtags = Array.isArray(metadataSuggestions.suggested_hashtags)
        ? metadataSuggestions.suggested_hashtags.filter((tag): tag is string => typeof tag === "string")
        : [];

      return {
        id: candidate.id,
        candidateId: candidate.candidateExternalId,
        title: candidate.title,
        hookText: candidate.hookText,
        summary: candidate.summary,
        contentCategory: candidate.contentCategory,
        finalViralScore: Number(candidate.finalViralScore),
        startSeconds: Number(candidate.startMs) / 1000,
        endSeconds: Number(candidate.endMs) / 1000,
        durationSeconds: Number(candidate.durationMs) / 1000,
        hashtags,
        rank: candidate.rank,
        selected: candidate.selected,
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
          typeof metadataSuggestions.can_standalone === "boolean" ? metadataSuggestions.can_standalone : null
      };
    });

    response.render("app/job-detail", {
      title: `Job ${job.id.slice(0, 8)}`,
      job,
      events,
      candidates,
      clipOutputs: job.clipOutputs.map((output) => {
        const renderSettings =
          output.renderSettings && typeof output.renderSettings === "object" && !Array.isArray(output.renderSettings)
            ? (output.renderSettings as Record<string, unknown>)
            : {};
        const visual =
          renderSettings.visual && typeof renderSettings.visual === "object" && !Array.isArray(renderSettings.visual)
            ? (renderSettings.visual as Record<string, unknown>)
            : {};
        const metadata =
          renderSettings.metadata && typeof renderSettings.metadata === "object" && !Array.isArray(renderSettings.metadata)
            ? (renderSettings.metadata as Record<string, unknown>)
            : {};
        const qualityReport =
          output.qualityReport && typeof output.qualityReport === "object" && !Array.isArray(output.qualityReport)
            ? (output.qualityReport as Record<string, unknown>)
            : {};
        const qualityCandidate =
          qualityReport.candidate && typeof qualityReport.candidate === "object" && !Array.isArray(qualityReport.candidate)
            ? (qualityReport.candidate as Record<string, unknown>)
            : {};
        const qualityValidation =
          qualityReport.validation && typeof qualityReport.validation === "object" && !Array.isArray(qualityReport.validation)
            ? (qualityReport.validation as Record<string, unknown>)
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

        return {
          id: output.id,
          candidateId: output.candidateId,
          candidateTitle:
            typeof qualityCandidate.title === "string" ? qualityCandidate.title : null,
          qualityStatus: output.qualityStatus,
          durationMs: output.durationMs,
          version: output.version,
          width: output.width,
          height: output.height,
          createdAt: output.createdAt,
          previewAvailable: Boolean(output.previewObjectKey),
          finalAvailable: Boolean(output.finalObjectKey),
          metadataAvailable: Boolean(output.metadataObjectKey),
          thumbnailAvailable: Boolean(output.thumbnailObjectKey),
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
            typeof metadata.suggested_caption === "string" ? metadata.suggested_caption : null
        };
      }),
      outputSummary: {
        sourceSummary: typeof outputSummary?.source_summary === "string" ? outputSummary.source_summary : null,
        analysisVersion: typeof outputSummary?.analysis_version === "string" ? outputSummary.analysis_version : null,
        candidateCount: typeof outputSummary?.candidate_count === "number" ? outputSummary.candidate_count : candidates.length,
        estimatedUsage: {
          sourceDurationSeconds: job.sourceMediaAsset?.durationMs ? Number(job.sourceMediaAsset.durationMs) / 1000 : null,
          selectedCandidates: candidates.filter((candidate) => candidate.selected).length,
          clipOutputs: job.clipOutputs.length
        },
        analyzer: analyzer
          ? {
              analysisMode: typeof analyzer.analysis_mode === "string" ? analyzer.analysis_mode : null,
              promptVersion: typeof analyzer.prompt_version === "string" ? analyzer.prompt_version : null,
              provider: typeof analyzer.provider === "string" ? analyzer.provider : null,
              model: typeof analyzer.model === "string" ? analyzer.model : null,
              providerRequestId: typeof analyzer.provider_request_id === "string" ? analyzer.provider_request_id : null,
              requestId: typeof analyzer.request_id === "string" ? analyzer.request_id : null,
              latencyMs: typeof analyzer.latency_ms === "number" ? analyzer.latency_ms : null,
              fallbackReason: typeof analyzer.fallback_reason === "string" ? analyzer.fallback_reason : null
            }
          : null
      },
      csrfToken: request.session.csrfToken
    });
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
              defaultAudience: true
            }
          }
        }
      }),
      prisma.preset.findMany({
        where: { userId, type: "CLIPPING", deletedAt: null },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }]
      }),
      prisma.brandKit.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }]
      })
    ]);
    const selectedPreset = clippingPresets.find((preset) => preset.isDefault) ?? clippingPresets[0] ?? null;
    const selectedBrandKit = brandKits.find((brandKit) => brandKit.isDefault) ?? brandKits[0] ?? null;
    const formDefaults = mergeAutoClipDefaults(
      buildAutoClipFormDefaults(user?.setting?.defaultContentNiche, user?.setting?.defaultAudience),
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

function countBy<T>(items: T[], keySelector: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keySelector(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()];
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

function buildAutoClipFormDefaults(defaultContentNiche?: string | null, defaultAudience?: string | null) {
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
    minDuration: 30,
    maxDuration: 55,
    minimumViralScore: 7.5,
    hookStyle: "QUESTION",
    ctaPreference: "COMMENT",
    profanityHandling: "KEEP",
    preferredTopics: "hook 3 detik pertama, audience retention, storytelling, CTA komentar",
    topicsToAvoid: "politik partisan, SARA, klaim medis berisiko",
    contentContext:
      "Cari potongan yang langsung masuk ke masalah utama, punya payoff jelas, dan bisa berdiri sendiri tanpa konteks panjang. Prioritaskan momen dengan hook kuat di 1-3 detik pertama, insight praktis, bahasa natural, dan ending yang mendorong komentar atau save. Hindari pembuka yang terlalu lama, filler berulang, atau referensi internal yang membingungkan.",
    sensitiveTopics: "klaim medis, saran legal, data pribadi",
    aspectRatio: "9:16",
    cropStrategy: "AUTO_REFRAME",
    subtitleLanguage: "id",
    subtitleStyle: "Bold Clean",
    subtitleFontFamily: "Montserrat",
    subtitlePosition: "BOTTOM",
    subtitleMaxLines: 2,
    subtitleSafeMarginPercent: 8
  };
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
    minDuration: toNumberValue(durations.min_seconds) ?? baseDefaults.minDuration,
    maxDuration: toNumberValue(durations.max_seconds) ?? baseDefaults.maxDuration,
    minimumViralScore: toNumberValue(presetConfig.minimum_viral_score) ?? baseDefaults.minimumViralScore,
    hookStyle: toStringValue(presetConfig.hook_style) ?? baseDefaults.hookStyle,
    ctaPreference: toStringValue(presetConfig.cta_preference) ?? baseDefaults.ctaPreference,
    aspectRatio: toStringValue(presetConfig.aspect_ratio) ?? baseDefaults.aspectRatio,
    preferredTopics: toCommaListValue(presetConfig.preferred_topics) ?? baseDefaults.preferredTopics,
    topicsToAvoid: toCommaListValue(presetConfig.topics_to_avoid) ?? baseDefaults.topicsToAvoid,
    sensitiveTopics: toCommaListValue(presetConfig.sensitive_topics) ?? baseDefaults.sensitiveTopics,
    subtitleLanguage: toStringValue(subtitleConfig.language) ?? baseDefaults.subtitleLanguage,
    subtitleStyle: toStringValue(subtitleConfig.style) ?? baseDefaults.subtitleStyle,
    subtitleFontFamily:
      toStringValue(subtitleConfig.font_family) ?? toStringValue(fontConfig.primary) ?? baseDefaults.subtitleFontFamily,
    subtitlePosition:
      toStringValue(subtitlePreset.position) ?? toStringValue(subtitleConfig.position) ?? baseDefaults.subtitlePosition,
    subtitleMaxLines:
      toNumberValue(subtitlePreset.max_lines) ?? toNumberValue(subtitleConfig.max_lines) ?? baseDefaults.subtitleMaxLines,
    subtitleSafeMarginPercent:
      toNumberValue(subtitlePreset.safe_margin_percent) ??
      toNumberValue(safeMarginConfig.bottom_percent) ??
      baseDefaults.subtitleSafeMarginPercent
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
    const [users, jobGroups, recentUsers] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.job.groupBy({ by: ["status"], _count: true }),
      prisma.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10 })
    ]);
    response.render("admin/dashboard", {
      title: "Admin Dashboard",
      users,
      jobCounts: Object.fromEntries(jobGroups.map((item) => [item.status, item._count])),
      recentUsers,
      csrfToken: request.session.csrfToken
    });
  })
);
