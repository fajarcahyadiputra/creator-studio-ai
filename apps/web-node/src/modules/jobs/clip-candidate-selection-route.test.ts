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

describe("clip candidate selection route", () => {
  beforeEach(() => {
    writeAudit.mockReset();
  });

  it("updates candidate selection and writes an audit entry", async () => {
    const updateClipCandidateSelection = vi.fn().mockResolvedValue({
      id: "candidate-row-1",
      candidateExternalId: "candidate-01",
      selected: true,
      rank: 2
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
        { updateClipCandidateSelection } as never,
        {
          on: () => () => undefined
        } as never
      )
    );
    app.use(errorHandler);

    const response = await request(app)
      .post("/api/v1/jobs/job-1/candidates/candidate-row-1/selection")
      .send({ selected: true });

    expect(response.status).toBe(200);
    expect(updateClipCandidateSelection).toHaveBeenCalledWith({
      userId: "user-1",
      jobId: "job-1",
      candidateId: "candidate-row-1",
      selected: true
    });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CLIP_CANDIDATE_SELECTED",
        resourceType: "ClipCandidate",
        resourceId: "candidate-row-1"
      })
    );
    expect(response.body.data).toEqual({
      id: "candidate-row-1",
      selected: true,
      rank: 2,
      message: "Candidate selected for downstream review."
    });
  });
});
