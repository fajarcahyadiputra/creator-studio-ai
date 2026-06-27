import { Router } from "express";
import { prisma } from "../../infrastructure/database/prisma.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { requireAuth, requirePermission } from "../auth/identity-middleware.js";

export const dashboardRouter = Router();

dashboardRouter.get(
  "/app/dashboard",
  requireAuth,
  asyncHandler(async (request, response) => {
    const userId = request.identity!.effectiveUserId;
    const [user, jobs, recent] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.job.groupBy({ by: ["status"], where: { userId, deletedAt: null }, _count: true }),
      prisma.job.findMany({ where: { userId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10 })
    ]);
    const counts = Object.fromEntries(jobs.map((item) => [item.status, item._count]));
    response.render("app/dashboard", {
      title: "Dashboard",
      user,
      counts,
      recent,
      csrfToken: request.session.csrfToken
    });
  })
);

dashboardRouter.get(
  "/app/jobs",
  requireAuth,
  asyncHandler(async (request, response) => {
    const jobs = await prisma.job.findMany({
      where: { userId: request.identity!.effectiveUserId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    response.render("app/jobs", { title: "Jobs", jobs, csrfToken: request.session.csrfToken });
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
        attempts: { orderBy: { attemptNumber: "desc" } },
        errors: { orderBy: { occurredAt: "desc" } },
        stages: { orderBy: { createdAt: "asc" } },
        clipCandidates: { orderBy: [{ rank: "asc" }, { createdAt: "asc" }] },
        clipOutputs: { orderBy: { createdAt: "asc" } }
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
        suggestedCaption: typeof metadataSuggestions.suggested_caption === "string" ? metadataSuggestions.suggested_caption : null
      };
    });

    response.render("app/job-detail", {
      title: `Job ${job.id.slice(0, 8)}`,
      job,
      events,
      candidates,
      clipOutputs: job.clipOutputs,
      outputSummary: {
        sourceSummary: typeof outputSummary?.source_summary === "string" ? outputSummary.source_summary : null,
        analysisVersion: typeof outputSummary?.analysis_version === "string" ? outputSummary.analysis_version : null,
        candidateCount: typeof outputSummary?.candidate_count === "number" ? outputSummary.candidate_count : candidates.length,
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
    const assets = await prisma.mediaAsset.findMany({
      where: { userId: request.identity!.effectiveUserId, status: "READY", deletedAt: null, type: "VIDEO" },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    response.render("app/auto-clipping", { title: "Auto Clipping", assets, csrfToken: request.session.csrfToken });
  })
);

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
