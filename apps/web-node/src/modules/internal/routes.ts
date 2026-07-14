import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import {
  createInternalSignedObjectReadUrl,
  createInternalSignedObjectWriteUrl,
  createPublicSignedObjectReadUrl,
  deleteObjectKeys
} from "../../infrastructure/storage/s3.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { validateBody } from "../../shared/http/validate.js";
import { AppError, NotFoundError } from "../../shared/errors/app-error.js";
import { routeParam } from "../../shared/http/route-param.js";
import type { JobProjectionService } from "../jobs/job-projection-service.js";
import { requireInternalService } from "./service-auth.js";

const progressSchema = z.object({
  stage: z.string().min(1).max(100),
  stage_progress: z.number().int().min(0).max(100),
  overall_progress: z.number().int().min(0).max(100),
  event_type: z.string().min(1).max(100).default("job.progress"),
  message: z.string().min(1).max(2000),
  user_message: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  status: z.enum([
    "DRAFT", "UPLOADING", "QUEUED", "RUNNING", "PAUSE_REQUESTED", "PAUSED",
    "CANCEL_REQUESTED", "CANCELED", "FAILED", "COMPLETED", "PARTIALLY_COMPLETED",
    "NEEDS_REVIEW"
  ]).optional(),
  occurred_at: z.string().trim().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "Invalid datetime."
  }).optional()
});

const clipOutputResultSchema = z.object({
  quality_status: z.enum(["PENDING", "PASSED", "NEEDS_REVIEW", "FAILED"]),
  preview_object_key: z.string().trim().min(1).max(1000).optional(),
  final_object_key: z.string().trim().min(1).max(1000).optional(),
  metadata_object_key: z.string().trim().min(1).max(1000).optional(),
  thumbnail_object_key: z.string().trim().min(1).max(1000).optional(),
  subtitle_object_key: z.string().trim().min(1).max(1000).optional(),
  subtitle_format: z.string().trim().min(1).max(20).optional(),
  subtitle_language: z.string().trim().min(2).max(20).optional(),
  subtitle_burned_in: z.boolean().optional(),
  quality_report: z.record(z.string(), z.unknown()).default({}),
  duration_ms: z.string().regex(/^\d+$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
});

const mediaAssetValidationSchema = z.object({
  status: z.enum(["READY", "FAILED"]),
  duration_ms: z.string().regex(/^\d+$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frame_rate: z.number().positive().optional(),
  audio_sample_rate: z.number().int().positive().optional(),
  codec_name: z.string().trim().min(1).max(80).optional(),
  audio_codec_name: z.string().trim().min(1).max(80).optional(),
  rotation: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  failure_reason: z.string().trim().min(1).max(2000).optional()
});

const externalSourceImportCreateSchema = z.object({
  job_id: z.uuid(),
  user_id: z.uuid(),
  project_id: z.preprocess((value) => value ?? undefined, z.uuid().optional()),
  source_url: z.url(),
  display_name: z.string().trim().min(1).max(255),
  original_file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(160),
  extension: z.string().trim().min(1).max(20),
});

const externalSourceImportCompleteSchema = z.object({
  status: z.enum(["READY", "FAILED"]),
  size_bytes: z.string().regex(/^\d+$/).optional(),
  checksum_sha256: z.string().trim().length(64).optional(),
  mime_type: z.string().trim().min(1).max(160),
  extension: z.string().trim().min(1).max(20),
  display_name: z.string().trim().min(1).max(255),
  original_file_name: z.string().trim().min(1).max(255),
  duration_ms: z.string().regex(/^\d+$/).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  frame_rate: z.number().positive().optional(),
  audio_sample_rate: z.number().int().positive().optional(),
  codec_name: z.string().trim().min(1).max(80).optional(),
  audio_codec_name: z.string().trim().min(1).max(80).optional(),
  rotation: z.number().int().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  failure_reason: z.string().trim().min(1).max(2000).optional(),
});

const transcriptWordSchema = z.object({
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0),
  text: z.string().trim().min(1).max(120),
  confidence: z.number().min(0).max(1).optional()
}).refine((value) => value.end_seconds > value.start_seconds, "Word end must be greater than start.");

const transcriptSegmentSchema = z.object({
  segment_id: z.string().trim().min(1).max(100),
  start_seconds: z.number().min(0),
  end_seconds: z.number().gt(0),
  text: z.string().trim().min(1).max(5000),
  speaker_label: z.string().trim().max(80).nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  words: z.array(transcriptWordSchema).max(5000).default([])
}).refine((value) => value.end_seconds > value.start_seconds, "Segment end must be greater than start.");

const transcriptionResultSchema = z.object({
  media_asset_id: z.string().trim().min(1).max(64),
  job_id: z.string().trim().min(1).max(64).optional(),
  output_transcript_path: z.string().trim().min(1).max(1000),
  model_identifier: z.string().trim().min(1).max(200).optional(),
  word_timestamps: z.boolean().default(true),
  transcript: z.object({
    language: z.string().trim().min(2).max(20),
    duration_seconds: z.number().gt(0),
    segments: z.array(transcriptSegmentSchema).min(1).max(5000)
  })
});

const ttsSegmentationResultSchema = z.object({
  document: z.object({
    segments: z.array(
      z.object({
        id: z.number().int().positive(),
        text: z.string().trim().min(1).max(2000),
        pause_after: z.number().int().min(0).max(5000),
        emotion: z.string().trim().min(1).max(40),
        speed: z.string().trim().min(1).max(40),
        emphasis: z.string().trim().min(1).max(40),
        volume: z.string().trim().min(1).max(40),
        breath_before: z.boolean(),
        breath_after: z.boolean(),
        fade_in_ms: z.number().int().min(0).max(5000),
        fade_out_ms: z.number().int().min(0).max(5000)
      })
    ).min(1).max(10000)
  }),
  metadata: z.record(z.string(), z.unknown()).default({})
});

const ttsOutputResultSchema = z.object({
  status: z.enum(["READY", "FAILED"]),
  object_key: z.string().trim().min(1).max(1000).optional(),
  mime_type: z.string().trim().min(1).max(160).optional(),
  extension: z.string().trim().min(1).max(20).optional(),
  duration_ms: z.string().regex(/^\d+$/).optional(),
  size_bytes: z.string().regex(/^\d+$/).optional(),
  sample_rate: z.number().int().positive().optional(),
  channels: z.number().int().min(1).max(8).optional(),
  provider_metadata: z.record(z.string(), z.unknown()).default({}),
  failure_reason: z.string().trim().min(1).max(2000).optional()
});

const ttsOutputTargetRequestSchema = z.object({
  preferred_format: z.enum(["wav", "mp3", "ogg"]).default("wav")
});

export function internalRouter(projection: JobProjectionService): Router {
  const router = Router();
  router.get("/internal/v1/health", requireInternalService, (_request, response) => {
    response.json({ data: { status: "ok" } });
  });
  router.post(
    "/internal/v1/jobs/:jobId/events",
    requireInternalService,
    validateBody(progressSchema),
    asyncHandler(async (request, response) => {
      const event = await projection.record(routeParam(request.params.jobId, "jobId"), request.validatedBody as never);
      response.status(201).json({ data: { id: event.id, sequence: event.sequence.toString() } });
    })
  );
  router.post(
    "/internal/v1/external-source-imports",
    requireInternalService,
    validateBody(externalSourceImportCreateSchema),
    asyncHandler(async (request, response) => {
      const body = request.validatedBody as {
        job_id: string;
        user_id: string;
        project_id?: string;
        source_url: string;
        display_name: string;
        original_file_name: string;
        mime_type: string;
        extension: string;
      };

      const extension = sanitizeExtension(body.extension);
      const fileNameBase = sanitizeObjectFileName(body.original_file_name, body.display_name);

      const created = await prisma.$transaction(async (tx) => {
        const job = await tx.job.findUnique({ where: { id: body.job_id }, select: { id: true } });
        if (!job) throw new NotFoundError("Job");

        const mediaAsset = await createExternalSourceImportMediaAsset(tx, {
          userId: body.user_id,
          projectId: body.project_id,
          jobId: body.job_id,
          sourceUrl: body.source_url,
          displayName: body.display_name,
          originalFileName: body.original_file_name,
          mimeType: body.mime_type,
          extension,
          fileNameBase,
        });

        return mediaAsset;
      });

      response.status(201).json({
        data: {
          media_asset_id: created.id,
          job_id: body.job_id,
          user_id: body.user_id,
          project_id: body.project_id ?? null,
          source_url: body.source_url,
          object_key: created.objectKey,
          upload_url: await createInternalSignedObjectWriteUrl(created.objectKey, body.mime_type, 3600),
          read_url: await createInternalSignedObjectReadUrl(created.objectKey, 3600),
          display_name: created.displayName,
          original_file_name: created.originalFileName,
          mime_type: created.mimeType,
          extension: created.extension,
        }
      });
    })
  );
  router.post(
    "/internal/v1/external-source-imports/:mediaAssetId/complete",
    requireInternalService,
    validateBody(externalSourceImportCompleteSchema),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const body = request.validatedBody as {
        status: "READY" | "FAILED";
        size_bytes?: string;
        checksum_sha256?: string;
        mime_type: string;
        extension: string;
        display_name: string;
        original_file_name: string;
        duration_ms?: string;
        width?: number;
        height?: number;
        frame_rate?: number;
        audio_sample_rate?: number;
        codec_name?: string;
        audio_codec_name?: string;
        rotation?: number;
        metadata: Record<string, unknown>;
        failure_reason?: string;
      };

      const existingMediaAsset = await prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
        select: { metadata: true }
      });
      const existingMetadata =
        existingMediaAsset?.metadata && typeof existingMediaAsset.metadata === "object" && !Array.isArray(existingMediaAsset.metadata)
          ? (existingMediaAsset.metadata as Record<string, unknown>)
          : {};

      const updated = await prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          status: body.status,
          displayName: body.display_name,
          originalFileName: body.original_file_name,
          mimeType: body.mime_type,
          extension: sanitizeExtension(body.extension),
          sizeBytes: body.size_bytes ? BigInt(body.size_bytes) : null,
          checksumSha256: body.checksum_sha256,
          durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
          width: body.width,
          height: body.height,
          frameRate: body.frame_rate,
          audioSampleRate: body.audio_sample_rate,
          metadata: {
            ...existingMetadata,
            ...(body.metadata ?? {}),
            validation: {
              codec_name: body.codec_name ?? null,
              audio_codec_name: body.audio_codec_name ?? null,
              rotation: body.rotation ?? null,
              failure_reason: body.failure_reason ?? null,
            },
          } as never
        }
      });

      if (body.status === "READY") {
        const metadata = updated.metadata && typeof updated.metadata === "object" && !Array.isArray(updated.metadata)
          ? (updated.metadata as Record<string, unknown>)
          : {};
        const jobId = typeof metadata.job_id === "string" ? metadata.job_id : null;

        if (jobId) {
          await prisma.$transaction(async (tx) => {
            const job = await tx.job.findUnique({
              where: { id: jobId },
              select: { inputSnapshot: true }
            });
            if (!job) return;

            await tx.job.update({
              where: { id: jobId },
              data: {
                sourceMediaAssetId: updated.id,
                inputSnapshot: replaceJobSourceWithMediaAsset(job.inputSnapshot, updated.id) as never,
              }
            });

            await tx.autoClipRequest.updateMany({
              where: { jobId },
              data: {
                sourceMediaAssetId: updated.id,
              }
            });
          });
        }
      }

      response.json({
        data: {
          media_asset_id: updated.id,
          status: updated.status,
          object_key: updated.objectKey,
        }
      });
    })
  );
  router.get(
    "/internal/v1/media-assets/:mediaAssetId/validation-context",
    requireInternalService,
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const mediaAsset = await prisma.mediaAsset.findFirst({
        where: { id: mediaAssetId, deletedAt: null }
      });
      if (!mediaAsset) throw new NotFoundError("Media asset");
      const downloadUrl = await createInternalSignedObjectReadUrl(mediaAsset.objectKey, 900);

      response.json({
        data: {
          media_asset_id: mediaAsset.id,
          user_id: mediaAsset.userId,
          project_id: mediaAsset.projectId,
          type: mediaAsset.type,
          status: mediaAsset.status,
          object_key: mediaAsset.objectKey,
          display_name: mediaAsset.displayName,
          original_file_name: mediaAsset.originalFileName,
          mime_type: mediaAsset.mimeType,
          extension: mediaAsset.extension,
          size_bytes: mediaAsset.sizeBytes?.toString() ?? null,
          checksum_sha256: mediaAsset.checksumSha256,
          download_url: downloadUrl,
          metadata: mediaAsset.metadata
        }
      });
    })
  );
  router.get(
    "/internal/v1/clip-outputs/:clipOutputId/render-context",
    requireInternalService,
    asyncHandler(async (request, response) => {
      const clipOutputId = routeParam(request.params.clipOutputId, "clipOutputId");
      const clipOutput = await prisma.clipOutput.findFirst({
        where: { id: clipOutputId, deletedAt: null },
        include: {
          candidate: {
            include: {
              transcript: {
                include: {
                  segments: {
                    orderBy: { sequence: "asc" }
                  }
                }
              }
            }
          },
          job: {
            include: {
              sourceMediaAsset: true
            }
          },
          subtitles: {
            orderBy: { createdAt: "desc" },
            take: 1
          }
        }
      });
      if (!clipOutput) throw new NotFoundError("Clip output");
      if (!clipOutput.job.sourceMediaAsset) throw new NotFoundError("Source media asset");

      const sourceMedia = clipOutput.job.sourceMediaAsset;
      const sourceDownloadUrl = await createInternalSignedObjectReadUrl(sourceMedia.objectKey, 3600);
      const previewObjectKey =
        clipOutput.previewObjectKey ?? `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/preview.mp4`;
      const finalObjectKey =
        clipOutput.finalObjectKey ?? `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/final.mp4`;
      const metadataObjectKey =
        clipOutput.metadataObjectKey ?? `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/metadata.json`;
      const subtitleFormat = resolveSubtitleFormat(clipOutput.renderSettings);
      const subtitleObjectKey =
        clipOutput.subtitles[0]?.objectKey
        ?? `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/subtitle.${subtitleFormat}`;
      const subtitleSrtObjectKey = `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/subtitle.srt`;
      const subtitleAssObjectKey = `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/subtitle.ass`;
      const subtitleVttObjectKey = `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/subtitle.vtt`;
      const subtitleJsonObjectKey = `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/subtitle.json`;
      const transcriptWindow = buildClipTranscriptWindow({
        transcript: clipOutput.candidate.transcript,
        clipStartMs: clipOutput.candidate.startMs,
        clipEndMs: clipOutput.candidate.endMs
      });
      const artifactUploads = await Promise.all([
        createArtifactUpload("preview", previewObjectKey, "video/mp4"),
        createArtifactUpload("final", finalObjectKey, "video/mp4"),
        createArtifactUpload("metadata", metadataObjectKey, "application/json"),
        createArtifactUpload("subtitle", subtitleObjectKey, resolveSubtitleMimeType(subtitleFormat)),
        createArtifactUpload("subtitle_srt", subtitleSrtObjectKey, "application/x-subrip"),
        createArtifactUpload("subtitle_ass", subtitleAssObjectKey, "text/x-ssa"),
        createArtifactUpload("subtitle_vtt", subtitleVttObjectKey, "text/vtt"),
        createArtifactUpload("subtitle_json", subtitleJsonObjectKey, "application/json")
      ]);

      response.json({
        data: {
          clip_output_id: clipOutput.id,
          job_id: clipOutput.jobId,
          candidate_id: clipOutput.candidateId,
          version: clipOutput.version,
          quality_status: clipOutput.qualityStatus,
          render_settings: await refreshRenderSettingsForWorker(clipOutput.renderSettings),
          candidate: {
            candidate_id: clipOutput.candidate.candidateExternalId,
            title: clipOutput.candidate.title,
            summary: clipOutput.candidate.summary,
            hook_text: clipOutput.candidate.hookText,
            start_ms: clipOutput.candidate.startMs.toString(),
            end_ms: clipOutput.candidate.endMs.toString(),
            duration_ms: clipOutput.candidate.durationMs.toString()
          },
          source_media: {
            media_asset_id: sourceMedia.id,
            object_key: sourceMedia.objectKey,
            download_url: sourceDownloadUrl,
            mime_type: sourceMedia.mimeType,
            duration_ms: sourceMedia.durationMs?.toString() ?? null,
            width: sourceMedia.width,
            height: sourceMedia.height
          },
          transcript: transcriptWindow,
          output_targets: {
            preview_object_key: previewObjectKey,
            final_object_key: finalObjectKey,
            metadata_object_key: metadataObjectKey,
            subtitle_object_key: subtitleObjectKey
          },
          artifact_uploads: artifactUploads
        }
      });
    })
  );
  router.post(
    "/internal/v1/clip-outputs/:clipOutputId/result",
    requireInternalService,
    validateBody(clipOutputResultSchema),
    asyncHandler(async (request, response) => {
      const clipOutputId = routeParam(request.params.clipOutputId, "clipOutputId");
      const body = request.validatedBody as {
        quality_status: "PENDING" | "PASSED" | "NEEDS_REVIEW" | "FAILED";
        preview_object_key?: string;
        final_object_key?: string;
        metadata_object_key?: string;
        thumbnail_object_key?: string;
        subtitle_object_key?: string;
        subtitle_format?: string;
        subtitle_language?: string;
        subtitle_burned_in?: boolean;
        quality_report: Record<string, unknown>;
        duration_ms?: string;
        width?: number;
        height?: number;
      };

      const updated = await prisma.$transaction(async (tx) => {
        const clipOutput = await tx.clipOutput.findFirst({
          where: { id: clipOutputId, deletedAt: null },
          include: {
            job: {
              select: {
                userId: true,
                projectId: true
              }
            }
          }
        });
        if (!clipOutput) throw new NotFoundError("Clip output");

        const existingQualityReport =
          clipOutput.qualityReport && typeof clipOutput.qualityReport === "object" && !Array.isArray(clipOutput.qualityReport)
            ? (clipOutput.qualityReport as Record<string, unknown>)
            : {};
        const previousQualityStatus =
          typeof existingQualityReport.previous_quality_status === "string"
            ? existingQualityReport.previous_quality_status
            : null;
        const hasExistingRenderableArtifact = Boolean(clipOutput.finalObjectKey || clipOutput.mediaAssetId);
        const shouldPreservePreviousRenderableStatus =
          body.quality_status === "FAILED"
          && !body.final_object_key
          && hasExistingRenderableArtifact;
        const effectiveQualityStatus = shouldPreservePreviousRenderableStatus
          ? (
              previousQualityStatus === "PASSED"
              || previousQualityStatus === "NEEDS_REVIEW"
              || previousQualityStatus === "PENDING"
                ? previousQualityStatus
                : "NEEDS_REVIEW"
            )
          : body.quality_status;
        const mergedQualityReport = shouldPreservePreviousRenderableStatus
          ? {
              ...existingQualityReport,
              latest_attempt: body.quality_report,
              status: previousQualityStatus === "PASSED" ? "completed_with_warning" : "needs_review",
              warning_message: "Latest rerender failed, but the previous rendered video is still available.",
              latest_attempt_failed_at: new Date().toISOString(),
            }
          : body.quality_report;

        const persisted = await tx.clipOutput.update({
          where: { id: clipOutputId },
          data: {
            qualityStatus: effectiveQualityStatus,
            previewObjectKey: body.preview_object_key,
            finalObjectKey: body.final_object_key,
            metadataObjectKey: body.metadata_object_key,
            thumbnailObjectKey: body.thumbnail_object_key,
            qualityReport: mergedQualityReport as never,
            durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
            width: body.width,
            height: body.height
          }
        });

        const finalMediaAssetId = body.final_object_key
          ? await upsertClipOutputMediaArtifact(tx, {
              userId: clipOutput.job.userId,
              projectId: clipOutput.job.projectId,
              clipOutputId: clipOutput.id,
              jobId: clipOutput.jobId,
              objectKey: body.final_object_key,
              type: "VIDEO",
              mimeType: "video/mp4",
              extension: "mp4"
            })
          : null;

        if (body.metadata_object_key) {
          await upsertClipOutputMediaArtifact(tx, {
            userId: clipOutput.job.userId,
            projectId: clipOutput.job.projectId,
            clipOutputId: clipOutput.id,
            jobId: clipOutput.jobId,
            objectKey: body.metadata_object_key,
            type: "DOCUMENT",
            mimeType: "application/json",
            extension: "json"
          });
        }

        if (body.thumbnail_object_key) {
          await upsertClipOutputMediaArtifact(tx, {
            userId: clipOutput.job.userId,
            projectId: clipOutput.job.projectId,
            clipOutputId: clipOutput.id,
            jobId: clipOutput.jobId,
            objectKey: body.thumbnail_object_key,
            type: "THUMBNAIL",
            mimeType: resolveImageMimeType(body.thumbnail_object_key),
            extension: resolveObjectExtension(body.thumbnail_object_key) ?? "jpg"
          });
        }

        if (finalMediaAssetId) {
          await tx.clipOutput.update({
            where: { id: clipOutputId },
            data: {
              mediaAssetId: finalMediaAssetId
            }
          });
        }

        if (body.subtitle_object_key) {
          await upsertSubtitleArtifact(tx, {
            userId: clipOutput.job.userId,
            projectId: clipOutput.job.projectId,
            clipOutputId: clipOutput.id,
            jobId: clipOutput.jobId,
            objectKey: body.subtitle_object_key,
            format: body.subtitle_format?.toLowerCase() ?? "srt",
            language: body.subtitle_language?.toLowerCase() ?? "id",
            isBurnedIn: body.subtitle_burned_in ?? false,
            qualityStatus: effectiveQualityStatus
          });
        }

        const artifactList = Array.isArray(body.quality_report?.artifacts) ? body.quality_report.artifacts : [];
        for (const artifact of artifactList) {
          if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) continue;
          const record = artifact as Record<string, unknown>;
          const artifactType = typeof record.artifact === "string" ? record.artifact : "";
          const objectKey = typeof record.object_key === "string" ? record.object_key : "";
          if (!objectKey || !["subtitle_srt", "subtitle_ass", "subtitle_vtt", "subtitle_json"].includes(artifactType)) {
            continue;
          }

          await upsertSubtitleArtifact(tx, {
            userId: clipOutput.job.userId,
            projectId: clipOutput.job.projectId,
            clipOutputId: clipOutput.id,
            jobId: clipOutput.jobId,
            objectKey,
            format: resolveSubtitleArtifactFormat(artifactType),
            language: body.subtitle_language?.toLowerCase() ?? "id",
            isBurnedIn: artifactType === "subtitle_ass" && (body.subtitle_burned_in ?? false),
            qualityStatus: effectiveQualityStatus
          });
        }

        return persisted;
      });

      await cleanupAutoClipSourceMediaIfEligible(clipOutputId).catch(() => undefined);

      response.json({
        data: {
          clip_output_id: updated.id,
          quality_status: updated.qualityStatus
        }
      });
    })
  );
  router.post(
    "/internal/v1/media-assets/:mediaAssetId/validation-result",
    requireInternalService,
    validateBody(mediaAssetValidationSchema),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const body = request.validatedBody as {
        status: "READY" | "FAILED";
        duration_ms?: string;
        width?: number;
        height?: number;
        frame_rate?: number;
        audio_sample_rate?: number;
        codec_name?: string;
        audio_codec_name?: string;
        rotation?: number;
        metadata: Record<string, unknown>;
        failure_reason?: string;
      };

      const updated = await prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          status: body.status,
          durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
          width: body.width,
          height: body.height,
          frameRate: body.frame_rate,
          audioSampleRate: body.audio_sample_rate,
          metadata: {
            ...(body.metadata ?? {}),
            validation: {
              codec_name: body.codec_name ?? null,
              audio_codec_name: body.audio_codec_name ?? null,
              rotation: body.rotation ?? null,
              failure_reason: body.failure_reason ?? null
            }
          } as never
        }
      });

      response.json({
        data: {
          media_asset_id: updated.id,
          status: updated.status,
          duration_ms: updated.durationMs?.toString() ?? null
        }
      });
    })
  );
  router.post(
    "/internal/v1/jobs/:jobId/tts-segmentation-result",
    requireInternalService,
    validateBody(ttsSegmentationResultSchema),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const body = request.validatedBody as {
        document: {
          segments: Array<{
            id: number;
            text: string;
            pause_after: number;
            emotion: string;
            speed: string;
            emphasis: string;
            volume: string;
            breath_before: boolean;
            breath_after: boolean;
            fade_in_ms: number;
            fade_out_ms: number;
          }>;
        };
        metadata: Record<string, unknown>;
      };

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        include: { ttsRequest: true }
      });
      if (!job) throw new NotFoundError("Job");

      const previousSummary =
        job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
          ? (job.outputSummary as Record<string, unknown>)
          : {};
      const previousOutputConfig =
        job.ttsRequest?.outputConfig && typeof job.ttsRequest.outputConfig === "object" && !Array.isArray(job.ttsRequest.outputConfig)
          ? (job.ttsRequest.outputConfig as Record<string, unknown>)
          : {};
      const segmentCount = body.document.segments.length;
      const totalPauseMs = body.document.segments.reduce((sum, segment) => sum + segment.pause_after, 0);
      const previewSegments = body.document.segments.slice(0, 5).map((segment) => ({
        id: segment.id,
        text: segment.text,
        pause_after: segment.pause_after,
        emotion: segment.emotion,
        speed: segment.speed,
        emphasis: segment.emphasis
      }));

      await prisma.$transaction(async (tx) => {
        await tx.job.update({
          where: { id: jobId },
          data: {
            outputSummary: {
              ...previousSummary,
              tts: {
                segment_count: segmentCount,
                total_pause_ms: totalPauseMs,
                preview_segments: previewSegments,
                document: body.document,
                metadata: body.metadata
              }
            } as never
          }
        });

        if (job.ttsRequest) {
          await tx.ttsRequest.update({
            where: { id: job.ttsRequest.id },
            data: {
              outputConfig: {
                ...previousOutputConfig,
                segmentation_document: body.document,
                segmentation_metadata: body.metadata
              } as never
            }
          });
        }
      });

      response.json({
        data: {
          job_id: jobId,
          segment_count: segmentCount
        }
      });
    })
  );

  router.post(
    "/internal/v1/jobs/:jobId/tts-output-target",
    requireInternalService,
    validateBody(ttsOutputTargetRequestSchema),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const body = request.validatedBody as { preferred_format: "wav" | "mp3" | "ogg" };
      const job = await prisma.job.findUnique({
        where: { id: jobId },
        include: {
          ttsRequest: {
            include: {
              outputs: {
                orderBy: { version: "desc" },
                take: 1
              }
            }
          }
        }
      });
      if (!job || !job.ttsRequest) throw new NotFoundError("TTS job");

      const outputConfig =
        job.ttsRequest.outputConfig && typeof job.ttsRequest.outputConfig === "object" && !Array.isArray(job.ttsRequest.outputConfig)
          ? (job.ttsRequest.outputConfig as Record<string, unknown>)
          : {};
      const configuredFormat = typeof outputConfig.preferred_format === "string"
        ? outputConfig.preferred_format.trim().toLowerCase()
        : "wav";
      const preferredFormat = body.preferred_format ?? (configuredFormat === "mp3" || configuredFormat === "ogg" ? configuredFormat : "wav");
      const extension = resolveTtsAudioExtension(preferredFormat);
      const mimeType = resolveTtsAudioMimeType(preferredFormat);
      const version = job.ttsRequest.outputs[0]?.version ?? 1;
      const objectKey = `users/${job.userId}/jobs/${job.id}/tts/output-v${version}.${extension}`;

      response.json({
        data: {
          job_id: job.id,
          tts_request_id: job.ttsRequest.id,
          version,
          object_key: objectKey,
          mime_type: mimeType,
          extension,
          upload_url: await createInternalSignedObjectWriteUrl(objectKey, mimeType, 3600)
        }
      });
    })
  );

  router.post(
    "/internal/v1/jobs/:jobId/tts-output-result",
    requireInternalService,
    validateBody(ttsOutputResultSchema),
    asyncHandler(async (request, response) => {
      const jobId = routeParam(request.params.jobId, "jobId");
      const body = request.validatedBody as {
        status: "READY" | "FAILED";
        object_key?: string;
        mime_type?: string;
        extension?: string;
        duration_ms?: string;
        size_bytes?: string;
        sample_rate?: number;
        channels?: number;
        provider_metadata: Record<string, unknown>;
        failure_reason?: string;
      };

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        include: {
          ttsRequest: {
            include: {
              outputs: {
                orderBy: { version: "desc" },
                take: 1
              }
            }
          }
        }
      });
      if (!job || !job.ttsRequest) throw new NotFoundError("TTS job");
      const ttsRequest = job.ttsRequest;
      if (body.status === "READY" && !body.object_key) {
        throw new AppError({
          code: "TTS_OUTPUT_OBJECT_KEY_REQUIRED",
          message: "object_key is required when TTS output status is READY.",
          statusCode: 400
        });
      }

      const previousSummary =
        job.outputSummary && typeof job.outputSummary === "object" && !Array.isArray(job.outputSummary)
          ? (job.outputSummary as Record<string, unknown>)
          : {};
      const previousTtsSummary =
        previousSummary.tts && typeof previousSummary.tts === "object" && !Array.isArray(previousSummary.tts)
          ? (previousSummary.tts as Record<string, unknown>)
          : {};
      const previousOutputConfig =
        job.ttsRequest.outputConfig && typeof job.ttsRequest.outputConfig === "object" && !Array.isArray(job.ttsRequest.outputConfig)
          ? (job.ttsRequest.outputConfig as Record<string, unknown>)
          : {};
      const outputVersion = job.ttsRequest.outputs[0]?.version ?? 1;

      const persisted = await prisma.$transaction(async (tx) => {
        let mediaAssetId: string | null = null;

        if (body.status === "READY" && body.object_key) {
          const mediaAsset = await tx.mediaAsset.upsert({
            where: { objectKey: body.object_key },
            update: {
              status: "READY",
              displayName: deriveObjectFileName(body.object_key),
              originalFileName: deriveObjectFileName(body.object_key),
              mimeType: body.mime_type ?? "audio/wav",
              extension: body.extension ?? resolveObjectExtension(body.object_key) ?? "wav",
              sizeBytes: body.size_bytes ? BigInt(body.size_bytes) : null,
              durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
              audioSampleRate: body.sample_rate ?? null,
              metadata: {
                source: "tts-render",
                job_id: job.id,
                tts_request_id: ttsRequest.id,
                channels: body.channels ?? null,
                provider_metadata: body.provider_metadata ?? {}
              } as never
            },
            create: {
              userId: job.userId,
              projectId: job.projectId,
              type: "AUDIO",
              status: "READY",
              displayName: deriveObjectFileName(body.object_key),
              originalFileName: deriveObjectFileName(body.object_key),
              objectKey: body.object_key,
              mimeType: body.mime_type ?? "audio/wav",
              extension: body.extension ?? resolveObjectExtension(body.object_key) ?? "wav",
              sizeBytes: body.size_bytes ? BigInt(body.size_bytes) : null,
              durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
              audioSampleRate: body.sample_rate ?? null,
              metadata: {
                source: "tts-render",
                job_id: job.id,
                tts_request_id: ttsRequest.id,
                channels: body.channels ?? null,
                provider_metadata: body.provider_metadata ?? {}
              } as never
            }
          });
          mediaAssetId = mediaAsset.id;

          await tx.ttsOutput.upsert({
            where: {
              ttsRequestId_version: {
                ttsRequestId: ttsRequest.id,
                version: outputVersion
              }
            },
            update: {
              mediaAssetId,
              status: "READY",
              durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
              providerMetadata: body.provider_metadata as never
            },
            create: {
              ttsRequestId: ttsRequest.id,
              mediaAssetId,
              version: outputVersion,
              status: "READY",
              durationMs: body.duration_ms ? BigInt(body.duration_ms) : null,
              providerMetadata: body.provider_metadata as never
            }
          });
        }

        const audioOutputSummary = {
          status: body.status,
          version: outputVersion,
          media_asset_id: mediaAssetId,
          object_key: body.object_key ?? null,
          mime_type: body.mime_type ?? null,
          extension: body.extension ?? null,
          duration_ms: body.duration_ms ? Number(body.duration_ms) : null,
          size_bytes: body.size_bytes ? Number(body.size_bytes) : null,
          sample_rate: body.sample_rate ?? null,
          channels: body.channels ?? null,
          provider_metadata: body.provider_metadata ?? {},
          failure_reason: body.failure_reason ?? null
        };

        await tx.job.update({
          where: { id: job.id },
          data: {
            outputSummary: {
              ...previousSummary,
              tts: {
                ...previousTtsSummary,
                audio_output: audioOutputSummary
              }
            } as never
          }
        });

        await tx.ttsRequest.update({
          where: { id: ttsRequest.id },
          data: {
            outputConfig: {
              ...previousOutputConfig,
              audio_output: audioOutputSummary
            } as never
          }
        });

        return audioOutputSummary;
      });

      response.json({
        data: {
          job_id: jobId,
          status: persisted.status,
          object_key: persisted.object_key
        }
      });
    })
  );

  router.post(
    "/internal/v1/media-assets/:mediaAssetId/transcription-result",
    requireInternalService,
    validateBody(transcriptionResultSchema),
    asyncHandler(async (request, response) => {
      const mediaAssetId = routeParam(request.params.mediaAssetId, "mediaAssetId");
      const body = request.validatedBody as {
        media_asset_id: string;
        job_id?: string;
        output_transcript_path: string;
        model_identifier?: string;
        word_timestamps: boolean;
        transcript: {
          language: string;
          duration_seconds: number;
          segments: Array<{
            segment_id: string;
            start_seconds: number;
            end_seconds: number;
            text: string;
            speaker_label?: string | null;
            confidence?: number;
            words: Array<{
              start_seconds: number;
              end_seconds: number;
              text: string;
              confidence?: number;
            }>;
          }>;
        };
      };
      if (body.media_asset_id !== mediaAssetId) {
        throw new AppError({
          code: "MEDIA_ASSET_ID_MISMATCH",
          message: "Path media asset id must match the payload media_asset_id.",
          statusCode: 400
        });
      }

      const transcript = await prisma.$transaction(async (tx) => {
        const persisted = await tx.transcript.upsert({
          where: {
            mediaAssetId_version: {
              mediaAssetId,
              version: 1
            }
          },
          update: {
            jobId: body.job_id,
            status: "READY",
            detectedLanguage: body.transcript.language,
            modelIdentifier: body.model_identifier,
            wordTimestamps: body.word_timestamps,
            metadata: {
              source: "faster-whisper",
              duration_seconds: body.transcript.duration_seconds,
              output_transcript_path: body.output_transcript_path,
              segment_count: body.transcript.segments.length
            } as never
          },
          create: {
            mediaAssetId,
            jobId: body.job_id,
            status: "READY",
            detectedLanguage: body.transcript.language,
            modelIdentifier: body.model_identifier,
            wordTimestamps: body.word_timestamps,
            metadata: {
              source: "faster-whisper",
              duration_seconds: body.transcript.duration_seconds,
              output_transcript_path: body.output_transcript_path,
              segment_count: body.transcript.segments.length
            } as never
          }
        });

        await tx.transcriptSegment.deleteMany({
          where: { transcriptId: persisted.id }
        });

        await tx.transcriptSegment.createMany({
          data: body.transcript.segments.map((segment, index) => ({
            transcriptId: persisted.id,
            sequence: index + 1,
            startMs: BigInt(Math.max(0, Math.round(segment.start_seconds * 1000))),
            endMs: BigInt(Math.max(0, Math.round(segment.end_seconds * 1000))),
            speakerLabel: segment.speaker_label ?? null,
            rawText: segment.text,
            normalizedText: segment.text,
            confidence: segment.confidence,
            words: segment.words as never,
            metadata: {
              segment_id: segment.segment_id
            } as never
          }))
        });

        return persisted;
      });

      response.json({
        data: {
          media_asset_id: mediaAssetId,
          transcript_id: transcript.id,
          status: transcript.status,
          segment_count: body.transcript.segments.length
        }
      });
    })
  );
  return router;
}

function deriveObjectFileName(objectKey: string): string {
  const parts = objectKey.split("/");
  return parts[parts.length - 1] || "artifact";
}

function resolveObjectExtension(objectKey: string): string | null {
  const fileName = deriveObjectFileName(objectKey);
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot < 0 || lastDot === fileName.length - 1) return null;
  return fileName.slice(lastDot + 1).toLowerCase();
}

function resolveSubtitleMimeType(format: string | undefined): string {
  const normalized = format?.trim().toLowerCase();
  if (normalized === "ass") return "text/x-ssa";
  if (normalized === "vtt") return "text/vtt";
  if (normalized === "json") return "application/json";
  return "application/x-subrip";
}

function resolveSubtitleFormat(renderSettings: unknown): string {
  if (renderSettings && typeof renderSettings === "object" && !Array.isArray(renderSettings)) {
    const subtitle = (renderSettings as Record<string, unknown>).subtitle;
    if (subtitle && typeof subtitle === "object" && !Array.isArray(subtitle)) {
      const format = (subtitle as Record<string, unknown>).format;
      if (typeof format === "string") {
        const normalized = format.trim().toLowerCase();
        if (["srt", "ass", "vtt", "json"].includes(normalized)) return normalized;
      }
    }
  }
  return "srt";
}

async function refreshRenderSettingsForWorker(renderSettings: unknown) {
  if (!renderSettings || typeof renderSettings !== "object" || Array.isArray(renderSettings)) {
    return renderSettings;
  }

  const snapshot = { ...(renderSettings as Record<string, unknown>) };
  const visual =
    snapshot.visual && typeof snapshot.visual === "object" && !Array.isArray(snapshot.visual)
      ? { ...(snapshot.visual as Record<string, unknown>) }
      : null;
  if (!visual) return snapshot;

  const visualSettings =
    visual.settings && typeof visual.settings === "object" && !Array.isArray(visual.settings)
      ? { ...(visual.settings as Record<string, unknown>) }
      : null;
  if (!visualSettings) {
    return {
      ...snapshot,
      visual
    };
  }

  const branding =
    visualSettings.branding && typeof visualSettings.branding === "object" && !Array.isArray(visualSettings.branding)
      ? { ...(visualSettings.branding as Record<string, unknown>) }
      : null;
  if (!branding) {
    return {
      ...snapshot,
      visual: {
        ...visual,
        settings: visualSettings
      }
    };
  }

  const logoObjectKey =
    typeof branding.logo_object_key === "string" && branding.logo_object_key.trim().length > 0
      ? branding.logo_object_key.trim()
      : null;
  if (logoObjectKey) {
    branding.logo_internal_url = await createInternalSignedObjectReadUrl(logoObjectKey);
    branding.logo_url = await createPublicSignedObjectReadUrl(logoObjectKey);
  }

  return {
    ...snapshot,
    visual: {
      ...visual,
      settings: {
        ...visualSettings,
        branding
      }
    }
  };
}

function resolveImageMimeType(objectKey: string): string {
  const extension = resolveObjectExtension(objectKey);
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

function resolveTtsAudioExtension(format: string | undefined): string {
  const normalized = format?.trim().toLowerCase();
  if (normalized === "mp3") return "mp3";
  if (normalized === "ogg") return "ogg";
  return "wav";
}

function resolveTtsAudioMimeType(format: string | undefined): string {
  const normalized = format?.trim().toLowerCase();
  if (normalized === "mp3") return "audio/mpeg";
  if (normalized === "ogg") return "audio/ogg";
  return "audio/wav";
}

async function upsertClipOutputMediaArtifact(
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">,
  input: {
    userId: string;
    projectId: string | null;
    clipOutputId: string;
    jobId: string;
    objectKey: string;
    type: "VIDEO" | "DOCUMENT" | "THUMBNAIL";
    mimeType: string;
    extension: string;
  }
) {
  const mediaAsset = await tx.mediaAsset.upsert({
    where: { objectKey: input.objectKey },
    update: {
      status: "READY",
      displayName: deriveObjectFileName(input.objectKey),
      originalFileName: deriveObjectFileName(input.objectKey),
      mimeType: input.mimeType,
      extension: input.extension,
      metadata: {
        source: "clip-output-render",
        clip_output_id: input.clipOutputId,
        job_id: input.jobId
      } as never
    },
    create: {
      userId: input.userId,
      projectId: input.projectId,
      type: input.type,
      status: "READY",
      displayName: deriveObjectFileName(input.objectKey),
      originalFileName: deriveObjectFileName(input.objectKey),
      objectKey: input.objectKey,
      mimeType: input.mimeType,
      extension: input.extension,
      metadata: {
        source: "clip-output-render",
        clip_output_id: input.clipOutputId,
        job_id: input.jobId
      } as never
    }
  });
  return mediaAsset.id;
}

async function createArtifactUpload(
  artifact:
    | "preview"
    | "final"
    | "metadata"
    | "thumbnail"
    | "subtitle"
    | "subtitle_srt"
    | "subtitle_ass"
    | "subtitle_vtt"
    | "subtitle_json",
  objectKey: string,
  contentType: string,
) {
  return {
    artifact,
    object_key: objectKey,
    content_type: contentType,
    upload_url: await createInternalSignedObjectWriteUrl(objectKey, contentType, 3600)
  };
}

function resolveSubtitleArtifactFormat(artifact: string): "srt" | "ass" | "vtt" | "json" {
  if (artifact === "subtitle_ass") return "ass";
  if (artifact === "subtitle_vtt") return "vtt";
  if (artifact === "subtitle_json") return "json";
  return "srt";
}

async function upsertSubtitleArtifact(
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">,
  input: {
    userId: string;
    projectId: string | null;
    clipOutputId: string;
    jobId: string;
    objectKey: string;
    format: string;
    language: string;
    isBurnedIn: boolean;
    qualityStatus: "PENDING" | "PASSED" | "NEEDS_REVIEW" | "FAILED";
  }
) {
  const mediaAsset = await tx.mediaAsset.upsert({
    where: { objectKey: input.objectKey },
    update: {
      status: "READY",
      displayName: deriveObjectFileName(input.objectKey),
      originalFileName: deriveObjectFileName(input.objectKey),
      mimeType: resolveSubtitleMimeType(input.format),
      extension: input.format.toLowerCase(),
      metadata: {
        source: "clip-output-render",
        clip_output_id: input.clipOutputId,
        job_id: input.jobId
      } as never
    },
    create: {
      userId: input.userId,
      projectId: input.projectId,
      type: "SUBTITLE",
      status: "READY",
      displayName: deriveObjectFileName(input.objectKey),
      originalFileName: deriveObjectFileName(input.objectKey),
      objectKey: input.objectKey,
      mimeType: resolveSubtitleMimeType(input.format),
      extension: input.format.toLowerCase(),
      metadata: {
        source: "clip-output-render",
        clip_output_id: input.clipOutputId,
        job_id: input.jobId
      } as never
    }
  });

  await tx.subtitleAsset.upsert({
    where: { objectKey: input.objectKey },
    update: {
      mediaAssetId: mediaAsset.id,
      clipOutputId: input.clipOutputId,
      format: input.format,
      language: input.language,
      isBurnedIn: input.isBurnedIn,
      styleSnapshot: {
        source: "clip-output-render",
        quality_status: input.qualityStatus
      } as never
    },
    create: {
      mediaAssetId: mediaAsset.id,
      clipOutputId: input.clipOutputId,
      format: input.format,
      language: input.language,
      objectKey: input.objectKey,
      isBurnedIn: input.isBurnedIn,
      styleSnapshot: {
        source: "clip-output-render",
        quality_status: input.qualityStatus
      } as never
    }
  });
}

async function cleanupAutoClipSourceMediaIfEligible(clipOutputId: string) {
  const clipOutput = await prisma.clipOutput.findFirst({
    where: { id: clipOutputId, deletedAt: null },
    select: { jobId: true }
  });
  if (!clipOutput) return;

  const job = await prisma.job.findUnique({
    where: { id: clipOutput.jobId },
    select: {
      id: true,
      type: true,
      status: true,
      sourceMediaAssetId: true,
      autoClipRequest: {
        select: {
          id: true,
          sourceMediaAssetId: true
        }
      },
      clipOutputs: {
        where: { deletedAt: null },
        select: {
          id: true,
          finalObjectKey: true,
          qualityStatus: true
        }
      },
      sourceMediaAsset: {
        select: {
          id: true,
          objectKey: true,
          sourceJobs: {
            select: { id: true },
            take: 2
          },
          transcripts: {
            select: {
              rawObjectKey: true,
              normalizedObjectKey: true
            }
          }
        }
      }
    }
  });
  if (!job || job.type !== "AUTO_CLIPPING") return;
  if (!["COMPLETED", "PARTIALLY_COMPLETED"].includes(job.status)) return;
  if (!job.sourceMediaAssetId || !job.sourceMediaAsset) return;
  if (job.sourceMediaAsset.sourceJobs.length > 1) return;
  if (job.clipOutputs.length === 0) return;

  const allClipOutputsReady = job.clipOutputs.every(
    (item) => typeof item.finalObjectKey === "string" && item.finalObjectKey.trim().length > 0
  );
  if (!allClipOutputsReady) return;

  const sourceMediaAssetId = job.sourceMediaAssetId;
  const objectKeysToDelete = [
    job.sourceMediaAsset.objectKey,
    ...job.sourceMediaAsset.transcripts.flatMap((transcript) => [
      transcript.rawObjectKey,
      transcript.normalizedObjectKey
    ])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  await prisma.$transaction(async (tx) => {
    await tx.job.update({
      where: { id: job.id },
      data: {
        sourceMediaAssetId: null
      }
    });

    if (job.autoClipRequest?.id) {
      await tx.autoClipRequest.update({
        where: { id: job.autoClipRequest.id },
        data: {
          sourceMediaAssetId: null
        }
      });
    }

    await tx.mediaAsset.delete({
      where: { id: sourceMediaAssetId }
    });
  });

  await deleteObjectKeys([...new Set(objectKeysToDelete)]);
}

function buildClipTranscriptWindow(input: {
  transcript: {
    detectedLanguage: string | null;
    segments: Array<{
      id: string;
      startMs: bigint;
      endMs: bigint;
      normalizedText: string;
      speakerLabel: string | null;
      confidence: unknown;
      words: unknown;
    }>;
  } | null;
  clipStartMs: bigint;
  clipEndMs: bigint;
}) {
  if (!input.transcript) return null;

  const segments = input.transcript.segments
    .filter((segment) => segment.endMs > input.clipStartMs && segment.startMs < input.clipEndMs)
    .map((segment) => ({
      segment_id: segment.id,
      start_seconds: Number(segment.startMs) / 1000,
      end_seconds: Number(segment.endMs) / 1000,
      text: segment.normalizedText,
      speaker_label: segment.speakerLabel,
      confidence: typeof segment.confidence === "number" ? segment.confidence : null,
      words: Array.isArray(segment.words) ? segment.words : []
    }));

  return {
    language: input.transcript.detectedLanguage ?? "id",
    segments
  };
}

function replaceJobSourceWithMediaAsset(
  inputSnapshot: unknown,
  mediaAssetId: string,
): Record<string, unknown> {
  const snapshot =
    inputSnapshot && typeof inputSnapshot === "object" && !Array.isArray(inputSnapshot)
      ? { ...(inputSnapshot as Record<string, unknown>) }
      : {};
  const existingSource =
    snapshot.source && typeof snapshot.source === "object" && !Array.isArray(snapshot.source)
      ? { ...(snapshot.source as Record<string, unknown>) }
      : {};
  const preservedUrl =
    typeof existingSource.url === "string" && existingSource.url.trim().length > 0
      ? existingSource.url.trim()
      : undefined;

  return {
    ...snapshot,
    source: {
      ...existingSource,
      type: preservedUrl ? "EXTERNAL_URL" : "MEDIA_ASSET",
      url: preservedUrl,
      media_asset_id: mediaAssetId,
    }
  };
}

async function createExternalSourceImportMediaAsset(
  tx: Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$use" | "$extends">,
  input: {
    userId: string;
    projectId?: string;
    jobId: string;
    sourceUrl: string;
    displayName: string;
    originalFileName: string;
    mimeType: string;
    extension: string;
    fileNameBase: string;
  }
) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const importAttemptKey = `${Date.now()}-${randomUUID().slice(0, 8)}-${attempt}`;
    const objectKey =
      `users/${input.userId}/imports/${input.jobId}/source/` +
      `${importAttemptKey}-${input.fileNameBase}.${input.extension}`;

    try {
      return await tx.mediaAsset.create({
        data: {
          userId: input.userId,
          projectId: input.projectId,
          type: "VIDEO",
          status: "UPLOADING",
          displayName: input.displayName,
          originalFileName: input.originalFileName,
          objectKey,
          mimeType: input.mimeType,
          extension: input.extension,
          metadata: {
            source: "external-url-import",
            source_url: input.sourceUrl,
            job_id: input.jobId,
          } as never,
        }
      });
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      if (code === "P2002" && attempt < maxAttempts) {
        continue;
      }
      throw error;
    }
  }

  throw new AppError({
    code: "EXTERNAL_SOURCE_IMPORT_KEY_EXHAUSTED",
    message: "Could not allocate a unique object key for the imported source media.",
    statusCode: 500
  });
}

function sanitizeExtension(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized || "mp4";
}

function sanitizeObjectFileName(originalFileName: string, fallbackName: string) {
  const source = originalFileName.trim() || fallbackName.trim() || `external-source-${randomUUID().slice(0, 8)}`;
  const withoutExtension = source.replace(/\.[A-Za-z0-9]+$/, "");
  const normalized = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return (normalized || `external-source-${randomUUID().slice(0, 8)}`).slice(0, 120);
}
