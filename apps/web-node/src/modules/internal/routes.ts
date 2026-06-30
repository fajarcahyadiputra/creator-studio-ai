import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { createInternalSignedObjectReadUrl, createInternalSignedObjectWriteUrl } from "../../infrastructure/storage/s3.js";
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
  occurred_at: z.iso.datetime().optional()
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
      const thumbnailObjectKey =
        clipOutput.thumbnailObjectKey ?? `jobs/${clipOutput.jobId}/clip-outputs/${clipOutput.id}/thumbnail.jpg`;
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
        createArtifactUpload("thumbnail", thumbnailObjectKey, resolveImageMimeType(thumbnailObjectKey)),
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
          render_settings: clipOutput.renderSettings,
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
            thumbnail_object_key: thumbnailObjectKey,
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

        const persisted = await tx.clipOutput.update({
          where: { id: clipOutputId },
          data: {
            qualityStatus: body.quality_status,
            previewObjectKey: body.preview_object_key,
            finalObjectKey: body.final_object_key,
            metadataObjectKey: body.metadata_object_key,
            thumbnailObjectKey: body.thumbnail_object_key,
            qualityReport: body.quality_report as never,
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
            qualityStatus: body.quality_status
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
            qualityStatus: body.quality_status
          });
        }

        return persisted;
      });

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
      if (typeof format === "string" && format.trim()) return format.trim().toLowerCase();
    }
  }
  return "srt";
}

function resolveImageMimeType(objectKey: string): string {
  const extension = resolveObjectExtension(objectKey);
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
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
