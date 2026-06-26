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
