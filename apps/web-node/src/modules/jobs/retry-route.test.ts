import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";
import { jobsRouter } from "./routes.js";

describe("retry job route", () => {
  it("requires an idempotency key", async () => {
    const retry = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(requestContext);
    app.use((request, _response, next) => {
      request.identity = {
        actorUserId: "user-1",
        effectiveUserId: "user-1",
        permissions: new Set<string>(),
        isImpersonating: false
      };
      next();
    });
    app.use(
      jobsRouter(
        { retry } as never,
        {
          on: () => () => undefined
        } as never
      )
    );
    app.use(errorHandler);

    const response = await request(app).post("/api/v1/jobs/job-1/retry").send({ reason: "retry later" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(retry).not.toHaveBeenCalled();
  });
});
