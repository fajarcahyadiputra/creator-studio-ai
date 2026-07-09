import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../shared/http/error-handler.js";

const prisma = {
  $transaction: vi.fn(),
  clipOutput: {
    findFirst: vi.fn(),
    update: vi.fn()
  },
  mediaAsset: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn()
  },
  subtitleAsset: {
    upsert: vi.fn()
  },
  transcript: {
    upsert: vi.fn()
  },
  transcriptSegment: {
    deleteMany: vi.fn(),
    createMany: vi.fn()
  }
};

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma
}));

vi.mock("../../infrastructure/storage/s3.js", () => ({
  createInternalSignedObjectReadUrl: vi.fn().mockResolvedValue("http://minio:9000/signed-read-url"),
  createInternalSignedObjectWriteUrl: vi.fn().mockImplementation(async (objectKey: string) => `http://minio:9000/upload/${objectKey}`)
}));

describe("internal clip output routes", () => {
  beforeEach(() => {
    prisma.$transaction.mockReset();
    prisma.clipOutput.findFirst.mockReset();
    prisma.clipOutput.update.mockReset();
    prisma.mediaAsset.findFirst.mockReset();
    prisma.mediaAsset.findUnique.mockReset();
    prisma.mediaAsset.upsert.mockReset();
    prisma.mediaAsset.update.mockReset();
    prisma.subtitleAsset.upsert.mockReset();
    prisma.transcript.upsert.mockReset();
    prisma.transcriptSegment.deleteMany.mockReset();
    prisma.transcriptSegment.createMany.mockReset();
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
  });

  it("returns validation context for a media asset", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.mediaAsset.findFirst.mockResolvedValue({
      id: "asset-1",
      userId: "user-1",
      projectId: "project-1",
      type: "VIDEO",
      status: "VALIDATING",
      objectKey: "users/user-1/uploads/u1/source/video.mp4",
      displayName: "video.mp4",
      originalFileName: "video.mp4",
      mimeType: "video/mp4",
      extension: "mp4",
      sizeBytes: 123456789n,
      checksumSha256: "a".repeat(64),
      metadata: {
        validation: {
          status: "PENDING_WORKER",
          stage: "POST_UPLOAD_MEDIA_VALIDATION"
        }
      }
    });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .get("/internal/v1/media-assets/asset-1/validation-context")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      media_asset_id: "asset-1",
      user_id: "user-1",
      project_id: "project-1",
      type: "VIDEO",
      status: "VALIDATING",
      object_key: "users/user-1/uploads/u1/source/video.mp4",
      display_name: "video.mp4",
      original_file_name: "video.mp4",
      mime_type: "video/mp4",
      extension: "mp4",
      size_bytes: "123456789",
      checksum_sha256: "a".repeat(64),
      download_url: "http://minio:9000/signed-read-url",
      metadata: {
        validation: {
          status: "PENDING_WORKER",
          stage: "POST_UPLOAD_MEDIA_VALIDATION"
        }
      }
    });
  });

  it("returns render context for a clip output", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.clipOutput.findFirst.mockResolvedValue({
      id: "output-1",
      jobId: "job-1",
      candidateId: "candidate-row-1",
      version: 1,
      qualityStatus: "PENDING",
      renderSettings: { visual: { aspect_ratio: "9:16" } },
      previewObjectKey: null,
      finalObjectKey: null,
      metadataObjectKey: null,
      thumbnailObjectKey: null,
      candidate: {
        candidateExternalId: "candidate-01",
        title: "Candidate title",
        summary: "Candidate summary",
        hookText: "Hook",
        startMs: 12000n,
        endMs: 30000n,
        durationMs: 18000n,
        transcript: {
          detectedLanguage: "id",
          segments: [
            {
              id: "segment-1",
              startMs: 10000n,
              endMs: 18000n,
              normalizedText: "Halo semuanya",
              speakerLabel: null,
              confidence: 0.92,
              words: [
                {
                  start_seconds: 10,
                  end_seconds: 10.5,
                  text: "Halo",
                  confidence: 0.98
                }
              ]
            }
          ]
        }
      },
      subtitles: [],
      job: {
        sourceMediaAsset: {
          id: "asset-1",
          objectKey: "users/user-1/uploads/u1/source/video.mp4",
          mimeType: "video/mp4",
          durationMs: 65000n,
          width: 1920,
          height: 1080
        }
      }
    });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .get("/internal/v1/clip-outputs/output-1/render-context")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      job_id: "job-1",
      candidate_id: "candidate-row-1",
      version: 1,
      quality_status: "PENDING",
      render_settings: { visual: { aspect_ratio: "9:16" } },
      candidate: {
        candidate_id: "candidate-01",
        title: "Candidate title",
        summary: "Candidate summary",
        hook_text: "Hook",
        start_ms: "12000",
        end_ms: "30000",
        duration_ms: "18000"
      },
      source_media: {
        media_asset_id: "asset-1",
        object_key: "users/user-1/uploads/u1/source/video.mp4",
        download_url: "http://minio:9000/signed-read-url",
        mime_type: "video/mp4",
        duration_ms: "65000",
        width: 1920,
        height: 1080
      },
      transcript: {
        language: "id",
        segments: [
          {
            segment_id: "segment-1",
            start_seconds: 10,
            end_seconds: 18,
            text: "Halo semuanya",
            speaker_label: null,
            confidence: 0.92,
            words: [
              {
                start_seconds: 10,
                end_seconds: 10.5,
                text: "Halo",
                confidence: 0.98
              }
            ]
          }
        ]
      },
      output_targets: {
        preview_object_key: "jobs/job-1/clip-outputs/output-1/preview.mp4",
        final_object_key: "jobs/job-1/clip-outputs/output-1/final.mp4",
        metadata_object_key: "jobs/job-1/clip-outputs/output-1/metadata.json",
        thumbnail_object_key: "jobs/job-1/clip-outputs/output-1/thumbnail.jpg",
        subtitle_object_key: "jobs/job-1/clip-outputs/output-1/subtitle.srt"
      },
      artifact_uploads: [
        {
          artifact: "preview",
          object_key: "jobs/job-1/clip-outputs/output-1/preview.mp4",
          content_type: "video/mp4",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/preview.mp4"
        },
        {
          artifact: "final",
          object_key: "jobs/job-1/clip-outputs/output-1/final.mp4",
          content_type: "video/mp4",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/final.mp4"
        },
        {
          artifact: "metadata",
          object_key: "jobs/job-1/clip-outputs/output-1/metadata.json",
          content_type: "application/json",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/metadata.json"
        },
        {
          artifact: "thumbnail",
          object_key: "jobs/job-1/clip-outputs/output-1/thumbnail.jpg",
          content_type: "image/jpeg",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/thumbnail.jpg"
        },
        {
          artifact: "subtitle",
          object_key: "jobs/job-1/clip-outputs/output-1/subtitle.srt",
          content_type: "application/x-subrip",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/subtitle.srt"
        },
        {
          artifact: "subtitle_vtt",
          object_key: "jobs/job-1/clip-outputs/output-1/subtitle.vtt",
          content_type: "text/vtt",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/subtitle.vtt"
        },
        {
          artifact: "subtitle_json",
          object_key: "jobs/job-1/clip-outputs/output-1/subtitle.json",
          content_type: "application/json",
          upload_url: "http://minio:9000/upload/jobs/job-1/clip-outputs/output-1/subtitle.json"
        }
      ]
    });
  });

  it("updates clip output result fields and persists subtitle artifacts", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.clipOutput.findFirst.mockResolvedValue({
      id: "output-1",
      jobId: "job-1",
      job: {
        userId: "user-1",
        projectId: "project-1"
      }
    });
    prisma.clipOutput.update.mockResolvedValue({
      id: "output-1",
      qualityStatus: "PASSED"
    });
    prisma.mediaAsset.upsert
      .mockResolvedValueOnce({ id: "video-asset-1" })
      .mockResolvedValueOnce({ id: "metadata-asset-1" })
      .mockResolvedValueOnce({ id: "thumbnail-asset-1" })
      .mockResolvedValueOnce({ id: "media-srt-1" })
      .mockResolvedValueOnce({ id: "media-vtt-1" })
      .mockResolvedValueOnce({ id: "media-json-1" });
    prisma.subtitleAsset.upsert.mockResolvedValue({ id: "subtitle-1" });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .post("/internal/v1/clip-outputs/output-1/result")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters")
      .send({
        quality_status: "PASSED",
        preview_object_key: "users/u/jobs/j/previews/c1.mp4",
        final_object_key: "users/u/jobs/j/final/c1.mp4",
        metadata_object_key: "users/u/jobs/j/meta/c1.json",
        thumbnail_object_key: "users/u/jobs/j/thumb/c1.jpg",
        subtitle_object_key: "users/u/jobs/j/subtitles/c1.srt",
        subtitle_format: "srt",
        subtitle_language: "id",
        subtitle_burned_in: false,
        quality_report: {
          score: 9.1,
          artifacts: [
            {
              artifact: "subtitle_vtt",
              object_key: "users/u/jobs/j/subtitles/c1.vtt"
            },
            {
              artifact: "subtitle_json",
              object_key: "users/u/jobs/j/subtitles/c1.json"
            }
          ]
        },
        duration_ms: "18000",
        width: 1080,
        height: 1920
      });

    expect(response.status).toBe(200);
    expect(prisma.clipOutput.update).toHaveBeenNthCalledWith(1, {
      where: { id: "output-1" },
      data: {
        qualityStatus: "PASSED",
        previewObjectKey: "users/u/jobs/j/previews/c1.mp4",
        finalObjectKey: "users/u/jobs/j/final/c1.mp4",
        metadataObjectKey: "users/u/jobs/j/meta/c1.json",
        thumbnailObjectKey: "users/u/jobs/j/thumb/c1.jpg",
        qualityReport: {
          score: 9.1,
          artifacts: [
            {
              artifact: "subtitle_vtt",
              object_key: "users/u/jobs/j/subtitles/c1.vtt"
            },
            {
              artifact: "subtitle_json",
              object_key: "users/u/jobs/j/subtitles/c1.json"
            }
          ]
        },
        durationMs: 18000n,
        width: 1080,
        height: 1920
      }
    });
    expect(prisma.clipOutput.update).toHaveBeenNthCalledWith(2, {
      where: { id: "output-1" },
      data: {
        mediaAssetId: "video-asset-1"
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(1, {
      where: { objectKey: "users/u/jobs/j/final/c1.mp4" },
      update: {
        status: "READY",
        displayName: "c1.mp4",
        originalFileName: "c1.mp4",
        mimeType: "video/mp4",
        extension: "mp4",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "VIDEO",
        status: "READY",
        displayName: "c1.mp4",
        originalFileName: "c1.mp4",
        objectKey: "users/u/jobs/j/final/c1.mp4",
        mimeType: "video/mp4",
        extension: "mp4",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(2, {
      where: { objectKey: "users/u/jobs/j/meta/c1.json" },
      update: {
        status: "READY",
        displayName: "c1.json",
        originalFileName: "c1.json",
        mimeType: "application/json",
        extension: "json",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "DOCUMENT",
        status: "READY",
        displayName: "c1.json",
        originalFileName: "c1.json",
        objectKey: "users/u/jobs/j/meta/c1.json",
        mimeType: "application/json",
        extension: "json",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(3, {
      where: { objectKey: "users/u/jobs/j/thumb/c1.jpg" },
      update: {
        status: "READY",
        displayName: "c1.jpg",
        originalFileName: "c1.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "THUMBNAIL",
        status: "READY",
        displayName: "c1.jpg",
        originalFileName: "c1.jpg",
        objectKey: "users/u/jobs/j/thumb/c1.jpg",
        mimeType: "image/jpeg",
        extension: "jpg",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(4, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.srt" },
      update: {
        status: "READY",
        displayName: "c1.srt",
        originalFileName: "c1.srt",
        mimeType: "application/x-subrip",
        extension: "srt",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "SUBTITLE",
        status: "READY",
        displayName: "c1.srt",
        originalFileName: "c1.srt",
        objectKey: "users/u/jobs/j/subtitles/c1.srt",
        mimeType: "application/x-subrip",
        extension: "srt",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(5, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.vtt" },
      update: {
        status: "READY",
        displayName: "c1.vtt",
        originalFileName: "c1.vtt",
        mimeType: "text/vtt",
        extension: "vtt",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "SUBTITLE",
        status: "READY",
        displayName: "c1.vtt",
        originalFileName: "c1.vtt",
        objectKey: "users/u/jobs/j/subtitles/c1.vtt",
        mimeType: "text/vtt",
        extension: "vtt",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.mediaAsset.upsert).toHaveBeenNthCalledWith(6, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.json" },
      update: {
        status: "READY",
        displayName: "c1.json",
        originalFileName: "c1.json",
        mimeType: "application/json",
        extension: "json",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      },
      create: {
        userId: "user-1",
        projectId: "project-1",
        type: "SUBTITLE",
        status: "READY",
        displayName: "c1.json",
        originalFileName: "c1.json",
        objectKey: "users/u/jobs/j/subtitles/c1.json",
        mimeType: "application/json",
        extension: "json",
        metadata: {
          source: "clip-output-render",
          clip_output_id: "output-1",
          job_id: "job-1"
        }
      }
    });
    expect(prisma.subtitleAsset.upsert).toHaveBeenNthCalledWith(1, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.srt" },
      update: {
        mediaAssetId: "media-srt-1",
        clipOutputId: "output-1",
        format: "srt",
        language: "id",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      },
      create: {
        mediaAssetId: "media-srt-1",
        clipOutputId: "output-1",
        format: "srt",
        language: "id",
        objectKey: "users/u/jobs/j/subtitles/c1.srt",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      }
    });
    expect(prisma.subtitleAsset.upsert).toHaveBeenNthCalledWith(2, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.vtt" },
      update: {
        mediaAssetId: "media-vtt-1",
        clipOutputId: "output-1",
        format: "vtt",
        language: "id",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      },
      create: {
        mediaAssetId: "media-vtt-1",
        clipOutputId: "output-1",
        format: "vtt",
        language: "id",
        objectKey: "users/u/jobs/j/subtitles/c1.vtt",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      }
    });
    expect(prisma.subtitleAsset.upsert).toHaveBeenNthCalledWith(3, {
      where: { objectKey: "users/u/jobs/j/subtitles/c1.json" },
      update: {
        mediaAssetId: "media-json-1",
        clipOutputId: "output-1",
        format: "json",
        language: "id",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      },
      create: {
        mediaAssetId: "media-json-1",
        clipOutputId: "output-1",
        format: "json",
        language: "id",
        objectKey: "users/u/jobs/j/subtitles/c1.json",
        isBurnedIn: false,
        styleSnapshot: {
          source: "clip-output-render",
          quality_status: "PASSED"
        }
      }
    });
    expect(response.body.data).toEqual({
      clip_output_id: "output-1",
      quality_status: "PASSED"
    });
  });

  it("updates media asset validation metadata", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.mediaAsset.update.mockResolvedValue({
      id: "asset-1",
      status: "READY",
      durationMs: 65432n
    });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .post("/internal/v1/media-assets/asset-1/validation-result")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters")
      .send({
        status: "READY",
        duration_ms: "65432",
        width: 1920,
        height: 1080,
        frame_rate: 29.97,
        audio_sample_rate: 48000,
        codec_name: "h264",
        audio_codec_name: "aac",
        rotation: 90,
        metadata: { source: "ffprobe" }
      });

    expect(response.status).toBe(200);
    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: {
        status: "READY",
        durationMs: 65432n,
        width: 1920,
        height: 1080,
        frameRate: 29.97,
        audioSampleRate: 48000,
        metadata: {
          source: "ffprobe",
          validation: {
            codec_name: "h264",
            audio_codec_name: "aac",
            rotation: 90,
            failure_reason: null
          }
        }
      }
    });
    expect(response.body.data).toEqual({
      media_asset_id: "asset-1",
      status: "READY",
      duration_ms: "65432"
    });
  });

  it("preserves external import metadata before linking the ready source media back to the job", async () => {
    const { internalRouter } = await import("./routes.js");
    const tx = {
      ...prisma,
      job: {
        findUnique: vi.fn().mockResolvedValue({
          inputSnapshot: {
            source: {
              type: "EXTERNAL_URL",
              url: "https://www.youtube.com/watch?v=abc123"
            }
          }
        }),
        update: vi.fn().mockResolvedValue({})
      },
      autoClipRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 })
      }
    };
    prisma.mediaAsset.findUnique.mockResolvedValue({
      metadata: {
        source: "external-url-import",
        source_url: "https://www.youtube.com/watch?v=abc123",
        job_id: "job-1"
      }
    });
    prisma.mediaAsset.update.mockResolvedValue({
      id: "asset-1",
      status: "READY",
      objectKey: "users/user-1/imports/job-1/source/video.mp4",
      metadata: {
        source: "external-url-import",
        source_url: "https://www.youtube.com/watch?v=abc123",
        job_id: "job-1",
        validation: {
          codec_name: "h264"
        }
      }
    });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .post("/internal/v1/external-source-imports/asset-1/complete")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters")
      .send({
        status: "READY",
        mime_type: "video/mp4",
        extension: "mp4",
        display_name: "Video source",
        original_file_name: "video.mp4",
        duration_ms: "65432",
        metadata: { source: "ffprobe" },
        codec_name: "h264"
      });

    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-1" },
      data: {
        status: "READY",
        displayName: "Video source",
        originalFileName: "video.mp4",
        mimeType: "video/mp4",
        extension: "mp4",
        sizeBytes: null,
        checksumSha256: undefined,
        durationMs: 65432n,
        width: undefined,
        height: undefined,
        frameRate: undefined,
        audioSampleRate: undefined,
        metadata: {
          source: "ffprobe",
          source_url: "https://www.youtube.com/watch?v=abc123",
          job_id: "job-1",
          validation: {
            codec_name: "h264",
            audio_codec_name: null,
            rotation: null,
            failure_reason: null
          }
        }
      }
    });
    expect(tx.job.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: {
        sourceMediaAssetId: "asset-1",
        inputSnapshot: {
          source: {
            type: "MEDIA_ASSET",
            media_asset_id: "asset-1"
          }
        }
      }
    });
    expect(tx.autoClipRequest.updateMany).toHaveBeenCalledWith({
      where: { jobId: "job-1" },
      data: {
        sourceMediaAssetId: "asset-1"
      }
    });
    expect(response.body.data).toEqual({
      media_asset_id: "asset-1",
      status: "READY",
      object_key: "users/user-1/imports/job-1/source/video.mp4"
    });
  });

  it("upserts transcript rows and replaces transcript segments", async () => {
    const { internalRouter } = await import("./routes.js");
    prisma.transcript.upsert.mockResolvedValue({
      id: "transcript-1",
      status: "READY"
    });
    prisma.transcriptSegment.deleteMany.mockResolvedValue({ count: 1 });
    prisma.transcriptSegment.createMany.mockResolvedValue({ count: 1 });

    const app = express();
    app.use(express.json());
    app.use(internalRouter({ record: vi.fn() } as never));
    app.use(errorHandler);

    const response = await request(app)
      .post("/internal/v1/media-assets/asset-1/transcription-result")
      .set("authorization", "Bearer replace-with-at-least-32-random-characters")
      .send({
        media_asset_id: "asset-1",
        job_id: "job-1",
        output_transcript_path: "/tmp/creator-studio/user-1/asset-1/transcript.json",
        model_identifier: "faster-whisper:small",
        word_timestamps: true,
        transcript: {
          language: "id",
          duration_seconds: 18,
          segments: [
            {
              segment_id: "segment-0001",
              start_seconds: 0,
              end_seconds: 18,
              text: "Halo semuanya, hari ini kita bahas retention.",
              speaker_label: null,
              confidence: 0.91,
              words: [
                {
                  start_seconds: 0,
                  end_seconds: 0.4,
                  text: "Halo",
                  confidence: 0.98
                }
              ]
            }
          ]
        }
      });

    expect(response.status).toBe(200);
    expect(prisma.transcript.upsert).toHaveBeenCalledWith({
      where: {
        mediaAssetId_version: {
          mediaAssetId: "asset-1",
          version: 1
        }
      },
      update: {
        jobId: "job-1",
        status: "READY",
        detectedLanguage: "id",
        modelIdentifier: "faster-whisper:small",
        wordTimestamps: true,
        metadata: {
          source: "faster-whisper",
          duration_seconds: 18,
          output_transcript_path: "/tmp/creator-studio/user-1/asset-1/transcript.json",
          segment_count: 1
        }
      },
      create: {
        mediaAssetId: "asset-1",
        jobId: "job-1",
        status: "READY",
        detectedLanguage: "id",
        modelIdentifier: "faster-whisper:small",
        wordTimestamps: true,
        metadata: {
          source: "faster-whisper",
          duration_seconds: 18,
          output_transcript_path: "/tmp/creator-studio/user-1/asset-1/transcript.json",
          segment_count: 1
        }
      }
    });
    expect(prisma.transcriptSegment.deleteMany).toHaveBeenCalledWith({
      where: { transcriptId: "transcript-1" }
    });
    expect(prisma.transcriptSegment.createMany).toHaveBeenCalledWith({
      data: [
        {
          transcriptId: "transcript-1",
          sequence: 1,
          startMs: 0n,
          endMs: 18000n,
          speakerLabel: null,
          rawText: "Halo semuanya, hari ini kita bahas retention.",
          normalizedText: "Halo semuanya, hari ini kita bahas retention.",
          confidence: 0.91,
          words: [
            {
              start_seconds: 0,
              end_seconds: 0.4,
              text: "Halo",
              confidence: 0.98
            }
          ],
          metadata: {
            segment_id: "segment-0001"
          }
        }
      ]
    });
    expect(response.body.data).toEqual({
      media_asset_id: "asset-1",
      transcript_id: "transcript-1",
      status: "READY",
      segment_count: 1
    });
  });
});
