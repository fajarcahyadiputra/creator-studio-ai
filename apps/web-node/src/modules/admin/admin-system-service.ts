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

    const mappedFeatureFlags = featureFlags.map((flag) => ({
      id: flag.id,
      key: flag.key,
      category: classifyAdminSettingKey(flag.key),
      description: flag.description,
      enabled: flag.enabled,
      rulesJson: formatJson(flag.rules),
      version: flag.version,
      updatedAt: flag.updatedAt
    }));
    const mappedSystemSettings = systemSettings.map((setting) => ({
      id: setting.id,
      key: setting.key,
      category: classifyAdminSettingKey(setting.key),
      description: setting.description,
      isSecret: setting.isSecret,
      valueJson: setting.isSecret ? "{\n  \"redacted\": true\n}" : formatJson(setting.value),
      version: setting.version,
      updatedAt: setting.updatedAt
    }));

    return {
      featureFlags: mappedFeatureFlags,
      systemSettings: mappedSystemSettings,
      summary: {
        featureFlagCount: mappedFeatureFlags.length,
        enabledFeatureFlagCount: mappedFeatureFlags.filter((flag) => flag.enabled).length,
        systemSettingCount: mappedSystemSettings.length,
        secretSettingCount: mappedSystemSettings.filter((setting) => setting.isSecret).length
      },
      featureFlagCategories: groupAdminSettingsByCategory(mappedFeatureFlags),
      systemSettingCategories: groupAdminSettingsByCategory(mappedSystemSettings),
      featureFlagTemplates: FEATURE_FLAG_TEMPLATES,
      systemSettingTemplates: SYSTEM_SETTING_TEMPLATES
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

type AdminSettingCategory =
  | "platform"
  | "provider-routing"
  | "ingestion"
  | "rendering"
  | "security"
  | "notifications"
  | "moderation"
  | "billing"
  | "observability"
  | "other";

function classifyAdminSettingKey(key: string): AdminSettingCategory {
  const normalized = key.trim().toLowerCase();
  if (normalized.includes("provider") || normalized.includes("routing") || normalized.includes("model")) {
    return "provider-routing";
  }
  if (normalized.includes("upload") || normalized.includes("ingestion") || normalized.includes("download")) {
    return "ingestion";
  }
  if (normalized.includes("render") || normalized.includes("subtitle") || normalized.includes("clip")) {
    return "rendering";
  }
  if (normalized.includes("auth") || normalized.includes("session") || normalized.includes("password") || normalized.includes("csrf")) {
    return "security";
  }
  if (normalized.includes("email") || normalized.includes("smtp") || normalized.includes("notification") || normalized.includes("webhook")) {
    return "notifications";
  }
  if (normalized.includes("moderation") || normalized.includes("safety") || normalized.includes("policy")) {
    return "moderation";
  }
  if (normalized.includes("billing") || normalized.includes("quota") || normalized.includes("plan") || normalized.includes("payment")) {
    return "billing";
  }
  if (normalized.includes("metric") || normalized.includes("otel") || normalized.includes("trace") || normalized.includes("log")) {
    return "observability";
  }
  if (normalized.includes("platform") || normalized.includes("maintenance") || normalized.includes("feature")) {
    return "platform";
  }
  return "other";
}

function groupAdminSettingsByCategory<T extends { category: AdminSettingCategory }>(items: T[]) {
  const labels: Record<AdminSettingCategory, string> = {
    platform: "Platform controls",
    "provider-routing": "Provider routing",
    ingestion: "Ingestion and uploads",
    rendering: "Render and subtitle pipeline",
    security: "Security and access",
    notifications: "Notifications and webhooks",
    moderation: "Moderation and policy",
    billing: "Billing and quota",
    observability: "Observability",
    other: "Other"
  };

  return Object.entries(
    items.reduce<Record<string, T[]>>((groups, item) => {
      const bucket = groups[item.category] ?? [];
      bucket.push(item);
      groups[item.category] = bucket;
      return groups;
    }, {})
  )
    .map(([key, groupedItems]) => ({
      key,
      label: labels[key as AdminSettingCategory] ?? key,
      count: groupedItems.length,
      items: groupedItems
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

const FEATURE_FLAG_TEMPLATES = [
  {
    key: "maintenance_mode",
    description: "Block new job creation while keeping admin review access available.",
    enabled: false,
    rules_json: { allow_admin_only: true, message: "Platform maintenance in progress." }
  },
  {
    key: "auto_clipping_regenerate_enabled",
    description: "Allow users to regenerate completed auto-clipping jobs in place.",
    enabled: true,
    rules_json: { tool: "AUTO_CLIPPING", audience: "all" }
  },
  {
    key: "tts_local_preview_enabled",
    description: "Expose local Piper preview actions on the TTS workspace.",
    enabled: true,
    rules_json: { tool: "TEXT_TO_SPEECH", audience: "all" }
  },
  {
    key: "admin_impersonation_lockdown",
    description: "Require extra caution before admin view-as-user access.",
    enabled: false,
    rules_json: { require_reason_length: 20, notify_audit: true }
  }
] as const;

const SYSTEM_SETTING_TEMPLATES = [
  {
    key: "provider_routing",
    description: "Primary provider routing and fallback order per tool.",
    is_secret: false,
    value_json: {
      auto_clipping: ["OPENAI"],
      text_to_speech: ["LOCAL_PIPER"],
      fallback_policy: "sequential"
    }
  },
  {
    key: "upload_limits",
    description: "Central upload, ingestion, and file size guardrails.",
    is_secret: false,
    value_json: {
      max_size_bytes: 10737418240,
      allowed_source_hosts: ["youtube.com", "www.youtube.com", "youtu.be"],
      part_size_bytes: 16777216
    }
  },
  {
    key: "render_pipeline_defaults",
    description: "Default render controls for auto-clipping outputs.",
    is_secret: false,
    value_json: {
      aspect_ratio: "9:16",
      crop_strategy: "AUTO_REFRAME",
      subtitle_primary_format: "ASS",
      burn_in_default: false
    }
  },
  {
    key: "webhook_notifications",
    description: "Outgoing webhook destinations for job lifecycle notifications.",
    is_secret: true,
    value_json: {
      enabled: false,
      endpoint: "https://example.com/webhooks/jobs",
      signing_secret: "replace-me"
    }
  }
] as const;
