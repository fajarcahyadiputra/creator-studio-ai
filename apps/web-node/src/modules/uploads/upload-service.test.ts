import { describe, expect, it } from "vitest";
import {
  buildPendingValidationMetadata,
  buildQueuedValidationMetadata,
  buildTriggerFailedValidationMetadata,
} from "./upload-service.js";

describe("buildPendingValidationMetadata", () => {
  it("adds explicit pending worker validation state after upload completion", () => {
    const metadata = buildPendingValidationMetadata({
      currentMetadata: { original_source: "browser-upload" },
      uploadSessionId: "upload-1",
      checksumSha256: "a".repeat(64),
      requestedAt: new Date("2026-06-28T10:00:00.000Z")
    });

    expect(metadata).toEqual({
      original_source: "browser-upload",
      validation: {
        status: "PENDING_WORKER",
        stage: "POST_UPLOAD_MEDIA_VALIDATION",
        upload_session_id: "upload-1",
        requested_at: "2026-06-28T10:00:00.000Z",
        checksum_sha256_present: true
      }
    });
  });

  it("starts from an empty metadata object when the asset has no prior metadata", () => {
    const metadata = buildPendingValidationMetadata({
      currentMetadata: null,
      uploadSessionId: "upload-2",
      requestedAt: new Date("2026-06-28T11:00:00.000Z")
    });

    expect(metadata).toEqual({
      validation: {
        status: "PENDING_WORKER",
        stage: "POST_UPLOAD_MEDIA_VALIDATION",
        upload_session_id: "upload-2",
        requested_at: "2026-06-28T11:00:00.000Z",
        checksum_sha256_present: false
      }
    });
  });

  it("marks validation as queued after the worker workflow is started", () => {
    const metadata = buildQueuedValidationMetadata({
      currentMetadata: {
        validation: {
          status: "PENDING_WORKER",
          stage: "POST_UPLOAD_MEDIA_VALIDATION",
        },
      },
      workflowId: "media-asset-validation:asset-1",
      queuedAt: new Date("2026-06-28T12:00:00.000Z"),
    });

    expect(metadata).toEqual({
      validation: {
        status: "QUEUED",
        stage: "POST_UPLOAD_MEDIA_VALIDATION",
        workflow_id: "media-asset-validation:asset-1",
        queued_at: "2026-06-28T12:00:00.000Z",
        trigger_failure_reason: null,
      },
    });
  });

  it("marks validation trigger failure without pretending the asset is ready", () => {
    const metadata = buildTriggerFailedValidationMetadata({
      currentMetadata: {
        validation: {
          status: "PENDING_WORKER",
          stage: "POST_UPLOAD_MEDIA_VALIDATION",
        },
      },
      failedAt: new Date("2026-06-28T12:05:00.000Z"),
      reason: "Temporal unavailable",
    });

    expect(metadata).toEqual({
      validation: {
        status: "TRIGGER_FAILED",
        stage: "POST_UPLOAD_MEDIA_VALIDATION",
        trigger_failed_at: "2026-06-28T12:05:00.000Z",
        trigger_failure_reason: "Temporal unavailable",
      },
    });
  });
});
