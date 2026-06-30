import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import helmet from "helmet";
import passport from "passport";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { createRedisClient, type RedisClient } from "./infrastructure/redis/client.js";
import { createSessionMiddleware } from "./infrastructure/session/session.js";
import { closeTemporalClient } from "./infrastructure/temporal/client.js";
import { impersonationRouter } from "./modules/admin/impersonation-routes.js";
import { AdminProviderService } from "./modules/admin/admin-provider-service.js";
import { AdminSystemService } from "./modules/admin/admin-system-service.js";
import { AdminUserService } from "./modules/admin/admin-user-service.js";
import { AdminObservabilityService } from "./modules/admin/admin-observability-service.js";
import { AdminJobService } from "./modules/admin/admin-job-service.js";
import { adminJobRouter } from "./modules/admin/job-management-routes.js";
import { adminObservabilityRouter } from "./modules/admin/observability-routes.js";
import { adminProviderRouter } from "./modules/admin/provider-management-routes.js";
import { adminSystemRouter } from "./modules/admin/system-management-routes.js";
import { adminUserRouter } from "./modules/admin/user-management-routes.js";
import { AuthService } from "./modules/auth/auth-service.js";
import { attachCsrfToken, verifyCsrf } from "./modules/auth/csrf.js";
import { loadIdentity } from "./modules/auth/identity-middleware.js";
import { configurePassport } from "./modules/auth/passport.js";
import { authRouter } from "./modules/auth/routes.js";
import { dashboardRouter } from "./modules/dashboard/routes.js";
import {
  healthRouter,
  httpRequestCounter,
  httpRequestDuration
} from "./modules/health/routes.js";
import { internalRouter } from "./modules/internal/routes.js";
import { JobEventBus } from "./modules/jobs/job-event-bus.js";
import { JobProjectionService } from "./modules/jobs/job-projection-service.js";
import { JobService } from "./modules/jobs/job-service.js";
import { jobsRouter } from "./modules/jobs/routes.js";
import { mediaRouter } from "./modules/media/routes.js";
import { MediaService } from "./modules/media/media-service.js";
import { PresetService } from "./modules/presets/preset-service.js";
import { presetsRouter } from "./modules/presets/routes.js";
import { settingsRouter } from "./modules/settings/routes.js";
import { SettingsService } from "./modules/settings/settings-service.js";
import { uploadsRouter } from "./modules/uploads/routes.js";
import { UploadService } from "./modules/uploads/upload-service.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { requestContext } from "./shared/http/request-context.js";
import { logger } from "./shared/logging/logger.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ApplicationRuntime {
  app: Express;
  close: () => Promise<void>;
}

export async function createApplication(): Promise<ApplicationRuntime> {
  const redis = createRedisClient();
  await redis.connect();
  const eventBus = new JobEventBus(redis);
  await eventBus.start();

  const authService = new AuthService();
  const jobService = new JobService();
  const mediaService = new MediaService({ prisma });
  const presetService = new PresetService({ prisma });
  const settingsService = new SettingsService({ prisma });
  const adminJobService = new AdminJobService({ prisma, jobService });
  const adminObservabilityService = new AdminObservabilityService({ prisma });
  const adminProviderService = new AdminProviderService({ prisma });
  const adminSystemService = new AdminSystemService({ prisma });
  const adminUserService = new AdminUserService({ prisma, authService });
  const projectionService = new JobProjectionService(eventBus);
  const uploadService = new UploadService();
  configurePassport(authService);

  const app = express();
  if (env.TRUST_PROXY) app.set("trust proxy", 1);
  app.set("view engine", "ejs");
  app.set("views", path.join(dirname, "views"));

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      customProps: (request) => ({ requestId: request.requestId }),
      serializers: {
        req: (request) => ({ method: request.method, url: request.url, remoteAddress: request.remoteAddress }),
        res: (response) => ({ statusCode: response.statusCode })
      }
    })
  );
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", "https://cdn.jsdelivr.net"]
        }
      },
      crossOriginResourcePolicy: { policy: "cross-origin" }
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(createSessionMiddleware(redis));
  app.use(attachCsrfToken);
  app.use(passport.initialize());
  app.use(loadIdentity);

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (request) => request.identity?.actorUserId ?? ipKeyGenerator(request.ip ?? "unknown")
    })
  );
  app.use(
    ["/api/v1/auth/login", "/api/v1/auth/forgot-password", "/api/v1/auth/reset-password"],
    rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false })
  );

  app.use((request, response, next) => {
    const end = httpRequestDuration.startTimer({ method: request.method });
    response.on("finish", () => {
      const route = request.route?.path ? String(request.route.path) : request.path;
      const status = String(response.statusCode);
      httpRequestCounter.inc({ method: request.method, route, status });
      end({ route, status });
    });
    next();
  });

  app.use(express.static(path.join(dirname, "public"), { maxAge: env.NODE_ENV === "production" ? "1d" : 0 }));
  app.use(verifyCsrf);
  app.use((request, response, next) => {
    response.locals.appName = env.APP_NAME;
    response.locals.path = request.path;
    response.locals.impersonation = request.session.impersonation;
    response.locals.csrfToken = request.session.csrfToken;
    next();
  });

  app.get("/", (request, response) => {
    if (!request.identity) {
      response.render("public/home", { title: "AI Content Workflow untuk Creator Indonesia" });
      return;
    }
    if (request.identity.permissions.has("admin.dashboard.view")) return response.redirect("/admin/dashboard");
    return response.redirect("/app/dashboard");
  });

  app.use(healthRouter);
  app.use(authRouter(authService));
  app.use(impersonationRouter);
  app.use(adminJobRouter(adminJobService));
  app.use(adminObservabilityRouter(adminObservabilityService));
  app.use(adminProviderRouter(adminProviderService));
  app.use(adminSystemRouter(adminSystemService));
  app.use(adminUserRouter(adminUserService));
  app.use(uploadsRouter(uploadService));
  app.use(jobsRouter(jobService, eventBus));
  app.use(mediaRouter(mediaService));
  app.use(presetsRouter(presetService));
  app.use(settingsRouter(settingsService));
  app.use(internalRouter(projectionService));
  app.use(dashboardRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return {
    app,
    close: async () => {
      await eventBus.close();
      await closeRedis(redis);
      await closeTemporalClient();
      await prisma.$disconnect();
    }
  };
}

async function closeRedis(redis: RedisClient): Promise<void> {
  if (redis.isOpen) await redis.quit();
}
