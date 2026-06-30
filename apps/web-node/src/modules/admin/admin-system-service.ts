import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { NotFoundError } from "../../shared/errors/app-error.js";

interface AdminSystemServiceDeps {
  prisma: typeof prisma;
}

interface FeatureFlagInput {
  key: string;
  description?: string;
  enabled: boolean;
  rules_json: Record<string, unknown>;
}

interface SystemSettingInput {
  key: string;
  description?: string;
  is_secret: boolean;
  value_json: Record<string, unknown>;
}

export class AdminSystemService {
  public constructor(private readonly deps: AdminSystemServiceDeps = { prisma }) {}

  public async getSystemManagementPageData() {
    const [featureFlags, systemSettings] = await Promise.all([
      this.deps.prisma.featureFlag.findMany({ orderBy: { key: "asc" } }),
      this.deps.prisma.systemSetting.findMany({ orderBy: { key: "asc" } })
    ]);

    return {
      featureFlags: featureFlags.map((flag) => ({
        id: flag.id,
        key: flag.key,
        description: flag.description,
        enabled: flag.enabled,
        rulesJson: formatJson(flag.rules),
        version: flag.version,
        updatedAt: flag.updatedAt
      })),
      systemSettings: systemSettings.map((setting) => ({
        id: setting.id,
        key: setting.key,
        description: setting.description,
        isSecret: setting.isSecret,
        valueJson: setting.isSecret ? "{\n  \"redacted\": true\n}" : formatJson(setting.value),
        version: setting.version,
        updatedAt: setting.updatedAt
      }))
    };
  }

  public async createFeatureFlag(input: FeatureFlagInput) {
    return this.deps.prisma.featureFlag.create({
      data: {
        key: input.key,
        description: input.description,
        enabled: input.enabled,
        rules: input.rules_json as Prisma.InputJsonValue
      }
    });
  }

  public async updateFeatureFlag(featureFlagId: string, input: FeatureFlagInput) {
    await this.requireFeatureFlag(featureFlagId);
    return this.deps.prisma.featureFlag.update({
      where: { id: featureFlagId },
      data: {
        key: input.key,
        description: input.description,
        enabled: input.enabled,
        rules: input.rules_json as Prisma.InputJsonValue,
        version: { increment: 1 }
      }
    });
  }

  public async createSystemSetting(input: SystemSettingInput) {
    return this.deps.prisma.systemSetting.create({
      data: {
        key: input.key,
        description: input.description,
        isSecret: input.is_secret,
        value: input.value_json as Prisma.InputJsonValue
      }
    });
  }

  public async updateSystemSetting(systemSettingId: string, input: SystemSettingInput) {
    await this.requireSystemSetting(systemSettingId);
    return this.deps.prisma.systemSetting.update({
      where: { id: systemSettingId },
      data: {
        key: input.key,
        description: input.description,
        isSecret: input.is_secret,
        value: input.value_json as Prisma.InputJsonValue,
        version: { increment: 1 }
      }
    });
  }

  private async requireFeatureFlag(featureFlagId: string) {
    const featureFlag = await this.deps.prisma.featureFlag.findUnique({ where: { id: featureFlagId } });
    if (!featureFlag) throw new NotFoundError("Feature flag");
    return featureFlag;
  }

  private async requireSystemSetting(systemSettingId: string) {
    const systemSetting = await this.deps.prisma.systemSetting.findUnique({ where: { id: systemSettingId } });
    if (!systemSetting) throw new NotFoundError("System setting");
    return systemSetting;
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}
