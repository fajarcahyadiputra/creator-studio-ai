import type { Prisma } from "../../generated/prisma/client.js";
import { MediaAssetStatus, MediaAssetType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { createPublicSignedObjectReadUrl } from "../../infrastructure/storage/s3.js";
import { NotFoundError } from "../../shared/errors/app-error.js";

interface MediaServiceDeps {
  prisma: typeof prisma;
}

interface MediaFilters {
  q?: string;
  type?: string;
  status?: string;
  view?: string;
  deleted?: string;
}

export class MediaService {
  public constructor(private readonly deps: MediaServiceDeps = { prisma }) {}

  public async getMediaLibraryPageData(userId: string, filters: MediaFilters) {
    const includeDeleted = filters.deleted === "true";
    const assets = await this.deps.prisma.mediaAsset.findMany({
      where: {
        userId,
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(isMediaAssetType(filters.type) ? { type: filters.type } : {}),
        ...(isMediaAssetStatus(filters.status) ? { status: filters.status } : {}),
        ...(filters.q
          ? {
              OR: [
                { displayName: { contains: filters.q, mode: "insensitive" as const } },
                { originalFileName: { contains: filters.q, mode: "insensitive" as const } },
                { objectKey: { contains: filters.q, mode: "insensitive" as const } }
              ]
            }
          : {})
      },
      include: {
        project: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });

    const storageBytes = assets
      .filter((asset) => !asset.deletedAt)
      .reduce((sum, asset) => sum + Number(asset.sizeBytes ?? 0n), 0);

    return {
      filters: {
        q: filters.q?.trim() ?? "",
        type: filters.type ?? "ALL",
        status: filters.status ?? "ALL",
        view: filters.view === "grid" ? "grid" : "list",
        deleted: includeDeleted
      },
      typeOptions: [...new Set(assets.map((asset) => asset.type))].sort(),
      statusOptions: [...new Set(assets.map((asset) => asset.status))].sort(),
      storageBytes,
      assets: assets.map((asset) => ({
        id: asset.id,
        type: asset.type,
        status: asset.status,
        displayName: asset.displayName,
        originalFileName: asset.originalFileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes ? Number(asset.sizeBytes) : null,
        durationMs: asset.durationMs ? Number(asset.durationMs) : null,
        width: asset.width,
        height: asset.height,
        retentionExpiresAt: asset.retentionExpiresAt,
        deletedAt: asset.deletedAt,
        createdAt: asset.createdAt,
        projectName: asset.project?.name ?? null,
        objectKey: asset.objectKey
      }))
    };
  }

  public async rename(userId: string, mediaAssetId: string, displayName: string) {
    const asset = await this.requireAsset(userId, mediaAssetId);
    return this.deps.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { displayName }
    });
  }

  public async softDelete(userId: string, mediaAssetId: string) {
    const asset = await this.requireAsset(userId, mediaAssetId);
    return this.deps.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { deletedAt: new Date(), status: "DELETED" }
    });
  }

  public async restore(userId: string, mediaAssetId: string) {
    const asset = await this.deps.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, userId }
    });
    if (!asset) throw new NotFoundError("Media asset");

    return this.deps.prisma.mediaAsset.update({
      where: { id: asset.id },
      data: {
        deletedAt: null,
        status: asset.mimeType?.startsWith("video/") || asset.mimeType?.startsWith("audio/") ? "READY" : "READY"
      }
    });
  }

  public async createDownloadUrl(userId: string, mediaAssetId: string) {
    const asset = await this.requireAsset(userId, mediaAssetId);
    return createPublicSignedObjectReadUrl(asset.objectKey);
  }

  private async requireAsset(userId: string, mediaAssetId: string) {
    const asset = await this.deps.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId, userId, deletedAt: null }
    });
    if (!asset) throw new NotFoundError("Media asset");
    return asset;
  }
}

function isMediaAssetType(value: string | undefined): value is MediaAssetType {
  return typeof value === "string" && value in MediaAssetType;
}

function isMediaAssetStatus(value: string | undefined): value is MediaAssetStatus {
  return typeof value === "string" && value in MediaAssetStatus;
}
