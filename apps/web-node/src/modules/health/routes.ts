import { Router } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";
import { prisma } from "../../infrastructure/database/prisma.js";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: "creator_web_" });

export const httpRequestCounter = new Counter({
  name: "creator_web_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [metricsRegistry]
});

export const httpRequestDuration = new Histogram({
  name: "creator_web_http_request_duration_seconds",
  help: "HTTP request duration",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry]
});

export const healthRouter = Router();

healthRouter.get("/health/live", (_request, response) => {
  response.json({ status: "ok" });
});

healthRouter.get("/health/ready", async (_request, response, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.json({ status: "ready" });
  } catch (error) {
    next(error);
  }
});

healthRouter.get("/metrics", async (_request, response) => {
  response.setHeader("Content-Type", metricsRegistry.contentType);
  response.end(await metricsRegistry.metrics());
});
