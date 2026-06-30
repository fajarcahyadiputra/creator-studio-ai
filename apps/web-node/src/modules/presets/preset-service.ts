import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { NotFoundError } from "../../shared/errors/app-error.js";

interface PresetServiceDeps {
  prisma: typeof prisma;
}

interface PresetInput {
  name: string;
  description?: string;
  type: "CLIPPING" | "SUBTITLE" | "TTS" | "BRAND" | "PUBLISHING";
  is_default: boolean;
  config_json: Record<string, unknown>;
}

interface BrandKitInput {
  name: string;
  is_default: boolean;
  font_config_json: Record<string, unknown>;
  color_config_json: Record<string, unknown>;
  safe_margin_config_json: Record<string, unknown>;
  subtitle_preset_json: Record<string, unknown>;
}

export class PresetService {
  public constructor(private readonly deps: PresetServiceDeps = { prisma }) {}

  public async getPresetsPageData(userId: string) {
    const [presets, brandKits] = await Promise.all([
      this.deps.prisma.preset.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ type: "asc" }, { createdAt: "desc" }]
      }),
      this.deps.prisma.brandKit.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" }
      })
    ]);

    return {
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description,
        type: preset.type,
        isDefault: preset.isDefault,
        configJson: JSON.stringify(preset.config, null, 2),
        updatedAt: preset.updatedAt
      })),
      brandKits: brandKits.map((brandKit) => ({
        id: brandKit.id,
        name: brandKit.name,
        isDefault: brandKit.isDefault,
        fontConfigJson: JSON.stringify(brandKit.fontConfig, null, 2),
        colorConfigJson: JSON.stringify(brandKit.colorConfig, null, 2),
        safeMarginConfigJson: JSON.stringify(brandKit.safeMarginConfig, null, 2),
        subtitlePresetJson: JSON.stringify(brandKit.subtitlePreset, null, 2),
        updatedAt: brandKit.updatedAt
      }))
    };
  }

  public async createPreset(userId: string, input: PresetInput) {
    if (input.is_default) {
      await this.deps.prisma.preset.updateMany({
        where: { userId, type: input.type, deletedAt: null },
        data: { isDefault: false }
      });
    }
    return this.deps.prisma.preset.create({
      data: {
        userId,
        type: input.type,
        name: input.name,
        description: input.description,
        config: input.config_json as Prisma.InputJsonValue,
        isDefault: input.is_default
      }
    });
  }

  public async updatePreset(userId: string, presetId: string, input: PresetInput) {
    const preset = await this.requirePreset(userId, presetId);
    if (input.is_default) {
      await this.deps.prisma.preset.updateMany({
        where: { userId, type: input.type, deletedAt: null, id: { not: preset.id } },
        data: { isDefault: false }
      });
    }
    return this.deps.prisma.preset.update({
      where: { id: preset.id },
      data: {
        type: input.type,
        name: input.name,
        description: input.description,
        config: input.config_json as Prisma.InputJsonValue,
        isDefault: input.is_default,
        version: { increment: 1 }
      }
    });
  }

  public async createBrandKit(userId: string, input: BrandKitInput) {
    if (input.is_default) {
      await this.deps.prisma.brandKit.updateMany({
        where: { userId, deletedAt: null },
        data: { isDefault: false }
      });
    }
    return this.deps.prisma.brandKit.create({
      data: {
        userId,
        name: input.name,
        isDefault: input.is_default,
        fontConfig: input.font_config_json as Prisma.InputJsonValue,
        colorConfig: input.color_config_json as Prisma.InputJsonValue,
        safeMarginConfig: input.safe_margin_config_json as Prisma.InputJsonValue,
        subtitlePreset: input.subtitle_preset_json as Prisma.InputJsonValue
      }
    });
  }

  public async updateBrandKit(userId: string, brandKitId: string, input: BrandKitInput) {
    const brandKit = await this.requireBrandKit(userId, brandKitId);
    if (input.is_default) {
      await this.deps.prisma.brandKit.updateMany({
        where: { userId, deletedAt: null, id: { not: brandKit.id } },
        data: { isDefault: false }
      });
    }
    return this.deps.prisma.brandKit.update({
      where: { id: brandKit.id },
      data: {
        name: input.name,
        isDefault: input.is_default,
        fontConfig: input.font_config_json as Prisma.InputJsonValue,
        colorConfig: input.color_config_json as Prisma.InputJsonValue,
        safeMarginConfig: input.safe_margin_config_json as Prisma.InputJsonValue,
        subtitlePreset: input.subtitle_preset_json as Prisma.InputJsonValue,
        version: { increment: 1 }
      }
    });
  }

  private async requirePreset(userId: string, presetId: string) {
    const preset = await this.deps.prisma.preset.findFirst({
      where: { id: presetId, userId, deletedAt: null }
    });
    if (!preset) throw new NotFoundError("Preset");
    return preset;
  }

  private async requireBrandKit(userId: string, brandKitId: string) {
    const brandKit = await this.deps.prisma.brandKit.findFirst({
      where: { id: brandKitId, userId, deletedAt: null }
    });
    if (!brandKit) throw new NotFoundError("Brand kit");
    return brandKit;
  }
}
