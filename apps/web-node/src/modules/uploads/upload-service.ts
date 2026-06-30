import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { prisma } from "../../infrastructure/database/prisma.js";
import { s3Internal, s3PublicSigner } from "../../infrastructure/storage/s3.js";
import { temporalClient } from "../../infrastructure/temporal/client.js";
import { env } from "../../config/env.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors/app-error.js";

const extensionByMime: Record<string, readonly string[]> = {
  "video/mp4": ["mp4"],
  "video/quicktime": ["mov"],
  "video/webm": ["webm"],
  "video/x-matroska": ["mkv"],
  "audio/mpeg": ["mp3"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/mp4": ["m4a", "mp4"],
  "audio/webm": ["webm"]
};

function sanitizeName(fileName: string): string {
  const normalized = fileName.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 180) || "source.bin";
}

function validateFile(fileName: string, contentType: string, sizeBytes: number): void {
  if (sizeBytes > env.UPLOAD_MAX_SIZE_BYTES) {
    throw new ValidationError("The file exceeds the maximum upload size.", {
      maximum_size_bytes: env.UPLOAD_MAX_SIZE_BYTES
    });
  }
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!extensionByMime[contentType]?.includes(extension)) {
    throw new ValidationError("The file extension does not match the declared media type.");
  }
}

interface ValidationMetadataInput {
  currentMetadata: unknown;
  uploadSessionId: string;
  checksumSha256?: string;
  requestedAt: Date;
}

interface ValidationWorkflowMetadataInput {
  currentMetadata: unknown;
  workflowId: string;
  queuedAt: Date;
}

interface ValidationTriggerFailureMetadataInput {
  currentMetadata: unknown;
  failedAt: Date;
  reason: string;
}

export class UploadService {
  public async create(params: {
    userId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    projectId?: string;
  }) {
    validateFile(params.fileName, params.contentType, params.sizeBytes);
    if (params.projectId) {
      const project = await prisma.project.findFirst({
        where: { id: params.projectId, userId: params.userId, deletedAt: null }
      });
      if (!project) throw new NotFoundError("Project");
    }

    const uploadPublicId = randomUUID();
    const safeName = sanitizeName(params.fileName);
    const objectKey = `users/${params.userId}/uploads/${uploadPublicId}/source/${safeName}`;
    const partSize = env.UPLOAD_PART_SIZE_BYTES;
    const partCount = Math.ceil(params.sizeBytes / partSize);
    if (partCount > 10_000) throw new ValidationError("The upload requires too many parts.");

    const initiated = await s3Internal.send(
      new CreateMultipartUploadCommand({
        Bucket: env.S3_BUCKET_MEDIA,
        Key: objectKey,
        ContentType: params.contentType,
        Metadata: { user_id: params.userId, original_file_name: safeName }
      })
    );
    if (!initiated.UploadId) {
      throw new AppError({ code: "MULTIPART_INIT_FAILED", message: "Object storage did not return an upload ID.", statusCode: 502, retryable: true });
    }

    try {
      const assetType = params.contentType.startsWith("video/") ? "VIDEO" : "AUDIO";
      const session = await prisma.$transaction(async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            userId: params.userId,
            projectId: params.projectId,
            type: assetType,
            status: "UPLOADING",
            displayName: params.fileName,
            originalFileName: params.fileName,
            objectKey,
            mimeType: params.contentType,
            extension: safeName.split(".").pop()?.toLowerCase(),
            sizeBytes: BigInt(params.sizeBytes)
          }
        });
        return tx.uploadSession.create({
          data: {
            userId: params.userId,
            mediaAssetId: asset.id,
            objectKey,
            multipartUploadId: initiated.UploadId!,
            status: "UPLOADING",
            expectedSizeBytes: BigInt(params.sizeBytes),
            partSizeBytes: partSize,
            contentType: params.contentType,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
          }
        });
      });

      const parts = await Promise.all(
        Array.from({ length: partCount }, async (_, index) => {
          const partNumber = index + 1;
          const command = new UploadPartCommand({
            Bucket: env.S3_BUCKET_MEDIA,
            Key: objectKey,
            UploadId: initiated.UploadId,
            PartNumber: partNumber
          });
          const url = await getSignedUrl(s3PublicSigner, command, {
            expiresIn: env.SIGNED_URL_TTL_SECONDS
          });
          return { part_number: partNumber, url };
        })
      );

      return {
        upload_id: session.id,
        media_asset_id: session.mediaAssetId,
        object_key: objectKey,
        part_size_bytes: partSize,
        expires_at: session.expiresAt.toISOString(),
        parts
      };
    } catch (error) {
      await s3Internal.send(new AbortMultipartUploadCommand({
        Bucket: env.S3_BUCKET_MEDIA,
        Key: objectKey,
        UploadId: initiated.UploadId
      }));
      throw error;
    }
  }

  public async complete(params: {
    userId: string;
    uploadId: string;
    parts: Array<{ part_number: number; etag: string }>;
    checksumSha256?: string;
  }) {
    const session = await prisma.uploadSession.findFirst({
      where: { id: params.uploadId, userId: params.userId },
      include: { mediaAsset: true }
    });
    if (!session) throw new NotFoundError("Upload session");
    if (session.status === "COMPLETED") return session.mediaAsset;
    if (!["UPLOADING", "CREATED"].includes(session.status)) {
      throw new ConflictError("UPLOAD_NOT_COMPLETABLE", `Upload status ${session.status} cannot be completed.`);
    }
    if (session.expiresAt <= new Date()) {
      throw new ConflictError("UPLOAD_EXPIRED", "The upload session has expired.");
    }

    const unique = new Set(params.parts.map((part) => part.part_number));
    if (unique.size !== params.parts.length) throw new ValidationError("Duplicate upload part numbers were supplied.");
    const sorted = [...params.parts].sort((a, b) => a.part_number - b.part_number);

    await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "COMPLETING" } });
    try {
      await s3Internal.send(new CompleteMultipartUploadCommand({
        Bucket: env.S3_BUCKET_MEDIA,
        Key: session.objectKey,
        UploadId: session.multipartUploadId,
        MultipartUpload: {
          Parts: sorted.map((part) => ({ ETag: part.etag, PartNumber: part.part_number }))
        }
      }));
      const asset = await prisma.$transaction(async (tx) => {
        const validationRequestedAt = new Date();
        await tx.uploadSession.update({
          where: { id: session.id },
          data: { status: "COMPLETED", completedAt: new Date(), completedParts: sorted }
        });
        return tx.mediaAsset.update({
          where: { id: session.mediaAssetId },
          data: {
            status: "VALIDATING",
            checksumSha256: params.checksumSha256?.toLowerCase(),
            metadata: buildPendingValidationMetadata({
              currentMetadata: session.mediaAsset.metadata,
              uploadSessionId: session.id,
              checksumSha256: params.checksumSha256,
              requestedAt: validationRequestedAt
            }) as never
          }
        });
      });
      return this.startMediaValidationWorkflow(asset.id);
    } catch (error) {
      await prisma.uploadSession.update({ where: { id: session.id }, data: { status: "FAILED" } });
      throw new AppError({
        code: "MULTIPART_COMPLETE_FAILED",
        message: "The multipart upload could not be completed.",
        statusCode: 502,
        retryable: true,
        cause: error
      });
    }
  }

  public async abort(userId: string, uploadId: string): Promise<void> {
    const session = await prisma.uploadSession.findFirst({ where: { id: uploadId, userId } });
    if (!session) throw new NotFoundError("Upload session");
    if (session.status === "COMPLETED") {
      throw new ConflictError("UPLOAD_ALREADY_COMPLETED", "A completed upload cannot be aborted.");
    }
    await s3Internal.send(new AbortMultipartUploadCommand({
      Bucket: env.S3_BUCKET_MEDIA,
      Key: session.objectKey,
      UploadId: session.multipartUploadId
    }));
    await prisma.$transaction([
      prisma.uploadSession.update({ where: { id: session.id }, data: { status: "ABORTED" } }),
      prisma.mediaAsset.update({ where: { id: session.mediaAssetId }, data: { status: "FAILED" } })
    ]);
  }

  private async startMediaValidationWorkflow(mediaAssetId: string) {
    const workflowId = `media-asset-validation:${mediaAssetId}`;

    try {
      const client = await temporalClient();
      await client.workflow.start("MediaAssetValidationWorkflow", {
        taskQueue: env.TEMPORAL_AUTO_CLIP_TASK_QUEUE,
        workflowId,
        args: [{ media_asset_id: mediaAssetId }],
      });

      return prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          metadata: buildQueuedValidationMetadata({
            currentMetadata: await this.getCurrentMetadata(mediaAssetId),
            workflowId,
            queuedAt: new Date(),
          }) as never,
        },
      });
    } catch (error) {
      return prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: {
          metadata: buildTriggerFailedValidationMetadata({
            currentMetadata: await this.getCurrentMetadata(mediaAssetId),
            failedAt: new Date(),
            reason: error instanceof Error ? error.message : String(error),
          }) as never,
        },
      });
    }
  }

  private async getCurrentMetadata(mediaAssetId: string): Promise<unknown> {
    const asset = await prisma.mediaAsset.findUnique({
      where: { id: mediaAssetId },
      select: { metadata: true },
    });
    return asset?.metadata;
  }
}

export function buildPendingValidationMetadata(input: ValidationMetadataInput): Record<string, unknown> {
  const metadata =
    input.currentMetadata && typeof input.currentMetadata === "object" && !Array.isArray(input.currentMetadata)
      ? { ...(input.currentMetadata as Record<string, unknown>) }
      : {};

  return {
    ...metadata,
    validation: {
      status: "PENDING_WORKER",
      stage: "POST_UPLOAD_MEDIA_VALIDATION",
      upload_session_id: input.uploadSessionId,
      requested_at: input.requestedAt.toISOString(),
      checksum_sha256_present: Boolean(input.checksumSha256)
    }
  };
}

export function buildQueuedValidationMetadata(input: ValidationWorkflowMetadataInput): Record<string, unknown> {
  const metadata =
    input.currentMetadata && typeof input.currentMetadata === "object" && !Array.isArray(input.currentMetadata)
      ? { ...(input.currentMetadata as Record<string, unknown>) }
      : {};
  const currentValidation =
    metadata.validation && typeof metadata.validation === "object" && !Array.isArray(metadata.validation)
      ? (metadata.validation as Record<string, unknown>)
      : {};

  return {
    ...metadata,
    validation: {
      ...currentValidation,
      status: "QUEUED",
      workflow_id: input.workflowId,
      queued_at: input.queuedAt.toISOString(),
      trigger_failure_reason: null,
    },
  };
}

export function buildTriggerFailedValidationMetadata(input: ValidationTriggerFailureMetadataInput): Record<string, unknown> {
  const metadata =
    input.currentMetadata && typeof input.currentMetadata === "object" && !Array.isArray(input.currentMetadata)
      ? { ...(input.currentMetadata as Record<string, unknown>) }
      : {};
  const currentValidation =
    metadata.validation && typeof metadata.validation === "object" && !Array.isArray(metadata.validation)
      ? (metadata.validation as Record<string, unknown>)
      : {};

  return {
    ...metadata,
    validation: {
      ...currentValidation,
      status: "TRIGGER_FAILED",
      trigger_failed_at: input.failedAt.toISOString(),
      trigger_failure_reason: input.reason,
    },
  };
}
