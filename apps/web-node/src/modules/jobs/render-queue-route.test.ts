import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";
import { requestContext } from "../../shared/http/request-context.js";

const writeAudit = vi.fn();

vi.mock("../audit/audit-service.js", () => ({
  writeAudit
}));

import { jobsRouter } from "./routes.js";

describe("render queue route", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("queues pending clip outputs for selected candidates", async () => {
    const queueSelectedClipOutputs = vi.fn().mockResolvedValue({
      jobId: "job-1",
      selectedCount: 3,
      createdCount: 2,
      existingCount: 1,
      startedWorkflowCount: 2
    });

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
        { queueSelectedClipOutputs } as never,
        {
          on: () => () => undefined
        } as never
      )
    );
    app.use(errorHandler);

    const response = await request(app).post("/api/v1/jobs/job-1/render-queue").send({});

    expect(response.status).toBe(200);
    expect(queueSelectedClipOutputs).toHaveBeenCalledWith({
      userId: "user-1",
      jobId: "job-1"
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "JOB_RENDER_QUEUE_REQUESTED",
        resourceType: "Job",
        resourceId: "job-1"
      })
    );
    expect(response.body.data).toEqual({
      job_id: "job-1",
      selected_candidate_count: 3,
      created_clip_output_count: 2,
      existing_clip_output_count: 1,
      started_render_workflow_count: 2,
      message: "Queued 2 selected candidate(s) for render preparation."
    });
  });
});
