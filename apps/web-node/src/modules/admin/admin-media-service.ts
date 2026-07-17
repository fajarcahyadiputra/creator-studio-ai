import type { Prisma } from "../../generated/prisma/client.js";
import { MediaAssetStatus, MediaAssetType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { createPublicSignedObjectReadUrl, deleteObjectKeys } from "../../infrastructure/storage/s3.js";
import { NotFoundError } from "../../shared/errors/app-error.js";

interface AdminMediaServiceDeps {
  prisma: typeof prisma;
}

interface AdminMediaFilters {
  q?: string;
  type?: string;
  status?: string;
  kind?: string;
  family?: string;
  userId?: string;
  view?: string;
  deleted?: string;
}

interface ResolvedAdminMediaFilters {
  includeDeleted: boolean;
  search: string;
  type: string;
  status: string;
  kind: string;
  family: string;
  userId: string;
  view: string;
}

type AdminMediaKind =
  | "IMPORTED_SOURCE"
  | "CLIP_RESULT"
  | "TTS_OUTPUT"
  | "SUBTITLE_ARTIFACT"
  | "OTHER";

type AdminMediaFamily = "SOURCE_ONLY" | "OUTPUTS_ONLY" | "OTHER_ONLY";
type AdminMediaPreviewKind = "video" | "audio" | "image" | "none";
type AdminMediaAssetSummary = {
  id: string;
  kind: AdminMediaKind;
  family: AdminMediaFamily;
  type: MediaAssetType;
  status: MediaAssetStatus;
  displayName: string;
  originalFileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  retentionExpiresAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  projectName: string | null;
  objectKey: string;
  objectPathPreview: {
    storageRoot: string;
    storageNote: string;
  };
  preview: {
    kind: AdminMediaPreviewKind;
    url: string | null;
  };
  userId: string;
  userEmail: string;
  userDisplayName: string;
  sourceLabels: string[];
};
type AdminMediaUserSummary = {
  userId: string;
  displayName: string;
  email: string;
  importedSourceCount: number;
  clipResultCount: number;
  ttsOutputCount: number;
  subtitleArtifactCount: number;
  otherCount: number;
  totalAssets: number;
  totalStorageBytes: number;
};

const ADMIN_MEDIA_KINDS: AdminMediaKind[] = [
  "IMPORTED_SOURCE",
  "CLIP_RESULT",
  "TTS_OUTPUT",
  "SUBTITLE_ARTIFACT",
  "OTHER"
];

const ADMIN_MEDIA_FAMILIES: AdminMediaFamily[] = ["SOURCE_ONLY", "OUTPUTS_ONLY", "OTHER_ONLY"];

export class AdminMediaService {
  public constructor(private readonly deps: AdminMediaServiceDeps = { prisma }) {}

  public async getMediaManagementPageData(filters: AdminMediaFilters) {
    const resolvedFilters = resolveAdminMediaFilters(filters);
    const includeDeleted = resolvedFilters.includeDeleted;
    const search = resolvedFilters.search;
    const userId = resolvedFilters.userId;

    const assets = await this.deps.prisma.mediaAsset.findMany({
      where: {
        ...(includeDeleted ? {} : { deletedAt: null }),
        ...(userId ? { userId } : {}),
        ...(isMediaAssetType(filters.type) ? { type: filters.type } : {}),
        ...(isMediaAssetStatus(filters.status) ? { status: filters.status } : {}),
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: "insensitive" as const } },
                { originalFileName: { contains: search, mode: "insensitive" as const } },
                { objectKey: { contains: search, mode: "insensitive" as const } },
                { user: { email: { contains: search, mode: "insensitive" as const } } },
                { user: { displayName: { contains: search, mode: "insensitive" as const } } }
              ]
            }
          : {})
      },
      include: {
        user: { select: { id: true, email: true, displayName: true } },
        project: { select: { id: true, name: true } },
        sourceJobs: { select: { id: true }, take: 1 },
        transcripts: { select: { id: true }, take: 1 },
        subtitleAssets: { select: { id: true }, take: 1 },
        ttsOutputs: { select: { id: true }, take: 1 },
        clipOutputs: { select: { id: true }, take: 1 }
      },
      orderBy: [{ createdAt: "desc" }],
      take: 300
    });

    const classifiedAssets = await Promise.all(assets.map(async (asset): Promise<AdminMediaAssetSummary> => {
        const kind = classifyMediaAsset(asset);
        const preview = await buildMediaPreview(asset.objectKey, asset.mimeType, asset.type);
        return {
          id: asset.id,
          kind,
          family: classifyMediaFamily(kind),
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
          objectKey: asset.objectKey,
          objectPathPreview: buildObjectPathPreview(asset.objectKey, kind),
          preview,
          userId: asset.user.id,
          userEmail: asset.user.email,
          userDisplayName: asset.user.displayName,
          sourceLabels: buildMediaSourceLabels(asset, kind)
        };
      }));
    const filteredAssets = classifiedAssets
      .filter((asset) => (isAdminMediaKind(filters.kind) ? asset.kind === filters.kind : true))
      .filter((asset) => (isAdminMediaFamily(filters.family) ? asset.family === filters.family : true));

    const storageBytes = filteredAssets
      .filter((asset) => !asset.deletedAt)
      .reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);

    const visibleUsers = new Map(
      filteredAssets.map((asset) => [
        asset.userId,
        { id: asset.userId, displayName: asset.userDisplayName, email: asset.userEmail }
      ])
    );

    const kindCounts = ADMIN_MEDIA_KINDS.map((kind) => ({
      kind,
      count: filteredAssets.filter((asset) => asset.kind === kind).length
    }));

    const userSummaries: AdminMediaUserSummary[] = [...new Map(
      filteredAssets.map((asset) => [asset.userId, {
        userId: asset.userId,
        displayName: asset.userDisplayName,
        email: asset.userEmail,
        importedSourceCount: 0,
        clipResultCount: 0,
        ttsOutputCount: 0,
        subtitleArtifactCount: 0,
        otherCount: 0,
        totalAssets: 0,
        totalStorageBytes: 0
      }])
    ).values()]
      .map((summary) => {
        const userAssets = filteredAssets.filter((asset) => asset.userId === summary.userId);
        return {
          ...summary,
          importedSourceCount: userAssets.filter((asset) => asset.kind === "IMPORTED_SOURCE").length,
          clipResultCount: userAssets.filter((asset) => asset.kind === "CLIP_RESULT").length,
          ttsOutputCount: userAssets.filter((asset) => asset.kind === "TTS_OUTPUT").length,
          subtitleArtifactCount: userAssets.filter((asset) => asset.kind === "SUBTITLE_ARTIFACT").length,
          otherCount: userAssets.filter((asset) => asset.kind === "OTHER").length,
          totalAssets: userAssets.length,
          totalStorageBytes: userAssets.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0)
        };
      })
      .sort((left, right) => right.totalStorageBytes - left.totalStorageBytes);

    return {
      filters: {
        q: search,
        type: resolvedFilters.type,
        status: resolvedFilters.status,
        kind: resolvedFilters.kind,
        family: resolvedFilters.family,
        userId,
        view: resolvedFilters.view,
        deleted: includeDeleted
      },
      typeOptions: [...new Set(assets.map((asset) => asset.type))].sort(),
      statusOptions: [...new Set(assets.map((asset) => asset.status))].sort(),
      kindOptions: ADMIN_MEDIA_KINDS,
      familyOptions: ADMIN_MEDIA_FAMILIES,
      userOptions: [...visibleUsers.values()].sort((left, right) => left.displayName.localeCompare(right.displayName)),
      kindCounts,
      userSummaries,
      storageBytes,
      assets: filteredAssets
    };
  }

  public async createAdminDownloadUrl(mediaAssetId: string) {
    const asset = await this.requireAsset(mediaAssetId);
    return createPublicSignedObjectReadUrl(asset.objectKey);
  }

  public async hardDelete(mediaAssetId: string) {
    const asset = await this.deps.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId },
      include: {
        transcripts: {
          select: {
            id: true,
            rawObjectKey: true,
            normalizedObjectKey: true
          }
        }
      }
    });
    if (!asset) throw new NotFoundError("Media asset");

    const objectKeysToDelete = [
      asset.objectKey,
      ...asset.transcripts.flatMap((transcript) => [transcript.rawObjectKey, transcript.normalizedObjectKey])
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    await this.deps.prisma.$transaction(async (tx) => {
      await tx.clipOutput.updateMany({
        where: { previewObjectKey: asset.objectKey },
        data: { previewObjectKey: null }
      });
      await tx.clipOutput.updateMany({
        where: { finalObjectKey: asset.objectKey },
        data: { finalObjectKey: null, mediaAssetId: null }
      });
      await tx.clipOutput.updateMany({
        where: { metadataObjectKey: asset.objectKey },
        data: { metadataObjectKey: null }
      });
      await tx.clipOutput.updateMany({
        where: { thumbnailObjectKey: asset.objectKey },
        data: { thumbnailObjectKey: null }
      });
      await tx.subtitleAsset.deleteMany({
        where: { objectKey: asset.objectKey }
      });
      await tx.mediaAsset.delete({
        where: { id: asset.id }
      });
    });

    await deleteObjectKeys(objectKeysToDelete);

    return {
      id: asset.id,
      userId: asset.userId,
      objectKey: asset.objectKey,
      deletedObjectCount: [...new Set(objectKeysToDelete)].length
    };
  }

  public async bulkHardDelete(filters: AdminMediaFilters) {
    const resolvedFilters = resolveAdminMediaFilters(filters);
    const page = await this.getMediaManagementPageData(filters);
    const deletableAssets = page.assets.filter((asset) => !asset.deletedAt).slice(0, 100);

    for (const asset of deletableAssets) {
      await this.hardDelete(asset.id);
    }

    return {
      deletedAssetCount: deletableAssets.length,
      matchedAssetCount: page.assets.filter((asset) => !asset.deletedAt).length,
      filters: resolvedFilters
    };
  }

  private async requireAsset(mediaAssetId: string) {
    const asset = await this.deps.prisma.mediaAsset.findFirst({
      where: { id: mediaAssetId }
    });
    if (!asset) throw new NotFoundError("Media asset");
    return asset;
  }
}

function resolveAdminMediaFilters(filters: AdminMediaFilters): ResolvedAdminMediaFilters {
  return {
    includeDeleted: filters.deleted === "true",
    search: filters.q?.trim() ?? "",
    type: filters.type ?? "ALL",
    status: filters.status ?? "ALL",
    kind: isAdminMediaKind(filters.kind) ? filters.kind : "ALL",
    family: isAdminMediaFamily(filters.family) ? filters.family : "ALL",
    userId: filters.userId?.trim() ?? "",
    view: filters.view === "grid" ? "grid" : "list"
  };
}

function isMediaAssetType(value: string | undefined): value is MediaAssetType {
  return typeof value === "string" && value in MediaAssetType;
}

function isMediaAssetStatus(value: string | undefined): value is MediaAssetStatus {
  return typeof value === "string" && value in MediaAssetStatus;
}

function isAdminMediaKind(value: string | undefined): value is AdminMediaKind {
  return typeof value === "string" && ADMIN_MEDIA_KINDS.includes(value as AdminMediaKind);
}

function isAdminMediaFamily(value: string | undefined): value is AdminMediaFamily {
  return typeof value === "string" && ADMIN_MEDIA_FAMILIES.includes(value as AdminMediaFamily);
}

function classifyMediaAsset(
  asset: Prisma.MediaAssetGetPayload<{
    include: {
      sourceJobs: { select: { id: true }; take: 1 };
      transcripts: { select: { id: true }; take: 1 };
      subtitleAssets: { select: { id: true }; take: 1 };
      ttsOutputs: { select: { id: true }; take: 1 };
      clipOutputs: { select: { id: true }; take: 1 };
    };
  }>
): AdminMediaKind {
  const metadata = toJsonRecord(asset.metadata);
  const source = typeof metadata?.source === "string" ? metadata.source : null;

  if (asset.subtitleAssets.length > 0 || asset.type === "SUBTITLE") return "SUBTITLE_ARTIFACT";
  if (asset.clipOutputs.length > 0 || source === "clip-output-render") return "CLIP_RESULT";
  if (asset.ttsOutputs.length > 0 || source === "tts-render") return "TTS_OUTPUT";
  if (
    asset.sourceJobs.length > 0
    || asset.transcripts.length > 0
    || source === "external-url-import"
    || typeof metadata?.original_source === "string"
  ) {
    return "IMPORTED_SOURCE";
  }
  return "OTHER";
}

function buildMediaSourceLabels(
  asset: Prisma.MediaAssetGetPayload<{
    include: {
      sourceJobs: { select: { id: true }; take: 1 };
      transcripts: { select: { id: true }; take: 1 };
      subtitleAssets: { select: { id: true }; take: 1 };
      ttsOutputs: { select: { id: true }; take: 1 };
      clipOutputs: { select: { id: true }; take: 1 };
    };
  }>,
  kind: AdminMediaKind
) {
  const metadata = toJsonRecord(asset.metadata);
  const source = typeof metadata?.source === "string" ? metadata.source : null;
  const originalSource = typeof metadata?.original_source === "string" ? metadata.original_source : null;
  return [kind.replaceAll("_", " ").toLowerCase(), source, originalSource]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function classifyMediaFamily(kind: AdminMediaKind): AdminMediaFamily {
  if (kind === "IMPORTED_SOURCE") return "SOURCE_ONLY";
  if (kind === "CLIP_RESULT" || kind === "TTS_OUTPUT" || kind === "SUBTITLE_ARTIFACT") return "OUTPUTS_ONLY";
  return "OTHER_ONLY";
}

function buildObjectPathPreview(objectKey: string, kind: AdminMediaKind) {
  const segments = objectKey.split("/").filter(Boolean);
  const userIndex = segments.indexOf("users");
  const jobsIndex = segments.indexOf("jobs");
  const importsIndex = segments.indexOf("imports");
  const settingsIndex = segments.indexOf("settings");
  const clipOutputsIndex = segments.indexOf("clip-outputs");

  if (userIndex >= 0 && importsIndex >= 0) {
    const userFolder = segments.slice(userIndex, importsIndex + 2).join("/");
    return {
      storageRoot: userFolder,
      storageNote:
        kind === "IMPORTED_SOURCE"
          ? "Folder source import user"
          : "Asset berada di bawah import folder user"
    };
  }

  if (userIndex >= 0 && jobsIndex >= 0) {
    const usesGroupedJobLayout = clipOutputsIndex === jobsIndex + 1;
    const endIndex = clipOutputsIndex >= 0
      ? clipOutputsIndex + (usesGroupedJobLayout ? 3 : 2)
      : Math.min(segments.length, jobsIndex + 4);
    return {
      storageRoot: segments.slice(userIndex, endIndex).join("/"),
      storageNote: "Folder hasil job user"
    };
  }

  if (userIndex >= 0 && settingsIndex >= 0) {
    return {
      storageRoot: segments.slice(userIndex, Math.min(segments.length, settingsIndex + 3)).join("/"),
      storageNote: "Folder settings user"
    };
  }

  return {
    storageRoot: segments.slice(0, Math.min(segments.length, 5)).join("/"),
    storageNote: "Path lain / perlu audit manual"
  };
}

async function buildMediaPreview(objectKey: string, mimeType: string | null, type: MediaAssetType) {
  const previewKind = resolvePreviewKind(objectKey, mimeType, type);
  if (previewKind === "none") {
    return {
      kind: previewKind,
      url: null
    };
  }

  return {
    kind: previewKind,
    url: await createPublicSignedObjectReadUrl(objectKey)
  };
}

function resolvePreviewKind(
  objectKey: string,
  mimeType: string | null,
  type: MediaAssetType
): AdminMediaPreviewKind {
  const normalizedMimeType = mimeType?.trim().toLowerCase() ?? "";
  const normalizedObjectKey = objectKey.trim().toLowerCase();

  if (
    type === "VIDEO"
    || normalizedMimeType.startsWith("video/")
    || normalizedObjectKey.endsWith(".mp4")
    || normalizedObjectKey.endsWith(".webm")
    || normalizedObjectKey.endsWith(".mov")
  ) {
    return "video";
  }

  if (
    type === "AUDIO"
    || normalizedMimeType.startsWith("audio/")
    || normalizedObjectKey.endsWith(".mp3")
    || normalizedObjectKey.endsWith(".wav")
    || normalizedObjectKey.endsWith(".ogg")
    || normalizedObjectKey.endsWith(".m4a")
  ) {
    return "audio";
  }

  if (
    normalizedMimeType.startsWith("image/")
    || normalizedObjectKey.endsWith(".png")
    || normalizedObjectKey.endsWith(".jpg")
    || normalizedObjectKey.endsWith(".jpeg")
    || normalizedObjectKey.endsWith(".webp")
  ) {
    return "image";
  }

  return "none";
}

function toJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
