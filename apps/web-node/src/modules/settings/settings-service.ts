import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError
} from "../../shared/errors/app-error.js";
import { encryptCredentialPayload, maskCredentialPayload } from "../admin/credential-crypto.js";
import { hashPassword, verifyPassword } from "../auth/password.js";

interface SettingsServiceDeps {
  prisma: typeof prisma;
}

interface ProfileInput {
  display_name: string;
  locale: string;
  timezone: string;
  default_content_niche?: string;
  default_audience?: string;
}

interface AiPreferenceInput {
  credential_mode: "PLATFORM" | "USER_OWNED";
  provider_id?: string;
  analysis_model_id?: string;
  text_model_id?: string;
  tts_model_id?: string;
  base_url_override?: string;
  organization_id?: string;
  project_id?: string;
  label?: string;
  payload_json?: Record<string, unknown>;
  rotate_payload_json?: Record<string, unknown>;
}

interface NotificationInput {
  email_job_completed: boolean;
  email_job_failed: boolean;
  email_quota_warning: boolean;
  in_app_job_completed: boolean;
  in_app_job_failed: boolean;
  in_app_publish_completed: boolean;
}

export class SettingsService {
  public constructor(private readonly deps: SettingsServiceDeps = { prisma }) {}

  public async getSettingsPageData(userId: string, currentSessionId?: string) {
    const [user, setting, preference, providers, sessions] = await Promise.all([
      this.deps.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: { plan: true }
      }),
      this.deps.prisma.userSetting.findUnique({ where: { userId } }),
      this.deps.prisma.userAiPreference.findUnique({
        where: { userId_toolType: { userId, toolType: "AUTO_CLIPPING" } },
        include: {
          credential: true
        }
      }),
      this.deps.prisma.aiProvider.findMany({
        where: { enabled: true },
        include: {
          models: {
            where: { enabled: true },
            include: { capabilities: { where: { enabled: true } } },
            orderBy: { displayName: "asc" }
          },
          credentials: {
            where: { scope: "PLATFORM", status: "ACTIVE" },
            orderBy: { createdAt: "desc" }
          }
        },
        orderBy: { displayName: "asc" }
      }),
      this.deps.prisma.session.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "desc" }
      })
    ]);

    return {
      user,
      profile: {
        displayName: user.displayName,
        locale: user.locale,
        timezone: user.timezone,
        defaultContentNiche: setting?.defaultContentNiche ?? "",
        defaultAudience: setting?.defaultAudience ?? ""
      },
      aiPreference: {
        credentialMode: preference?.credentialMode ?? "PLATFORM",
        providerId: preference?.providerId ?? "",
        credentialLabel: preference?.credential?.label ?? "",
        maskedSecret: preference?.credential?.maskedHint ?? "",
        lastConnectionStatus: preference?.credential?.lastConnectionStatus ?? "",
        baseUrlOverride: preference?.baseUrlOverride ?? "",
        organizationId: preference?.organizationId ?? "",
        projectId: preference?.projectId ?? "",
        analysisModelId: preference?.analysisModelId ?? "",
        textModelId: preference?.textModelId ?? "",
        ttsModelId: preference?.ttsModelId ?? ""
      },
      providers: providers.map((provider) => ({
        id: provider.id,
        code: provider.code,
        displayName: provider.displayName,
        platformCredentialCount: provider.credentials.length,
        models: provider.models.map((model) => ({
          id: model.id,
          displayName: model.displayName
        }))
      })),
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        impersonatedUserId: session.impersonatedUserId,
        isCurrent: currentSessionId ? session.id === currentSessionId : false
      })),
      notifications: normalizeNotifications(setting?.notificationSettings)
    };
  }

  public async updateProfile(userId: string, input: ProfileInput) {
    return this.deps.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          displayName: input.display_name,
          locale: input.locale,
          timezone: input.timezone
        }
      });

      return tx.userSetting.upsert({
        where: { userId },
        update: {
          defaultContentNiche: input.default_content_niche,
          defaultAudience: input.default_audience,
          version: { increment: 1 }
        },
        create: {
          userId,
          defaultContentNiche: input.default_content_niche,
          defaultAudience: input.default_audience
        }
      });
    });
  }

  public async updateAiPreference(userId: string, input: AiPreferenceInput) {
    await this.ensureProviderAndModels(input);

    const existing = await this.deps.prisma.userAiPreference.findUnique({
      where: { userId_toolType: { userId, toolType: "AUTO_CLIPPING" } },
      include: { credential: true }
    });

    const credentialId =
      input.credential_mode === "USER_OWNED"
        ? await this.upsertUserCredential(userId, input, existing?.credentialId ?? undefined)
        : null;

    return this.deps.prisma.userAiPreference.upsert({
      where: { userId_toolType: { userId, toolType: "AUTO_CLIPPING" } },
      update: {
        credentialMode: input.credential_mode,
        providerId: input.provider_id ?? null,
        credentialId,
        analysisModelId: input.analysis_model_id ?? null,
        textModelId: input.text_model_id ?? null,
        ttsModelId: input.tts_model_id ?? null,
        baseUrlOverride: input.base_url_override,
        organizationId: input.organization_id,
        projectId: input.project_id
      },
      create: {
        userId,
        toolType: "AUTO_CLIPPING",
        credentialMode: input.credential_mode,
        providerId: input.provider_id ?? null,
        credentialId,
        analysisModelId: input.analysis_model_id ?? null,
        textModelId: input.text_model_id ?? null,
        ttsModelId: input.tts_model_id ?? null,
        baseUrlOverride: input.base_url_override,
        organizationId: input.organization_id,
        projectId: input.project_id
      }
    });
  }

  public async updateNotifications(userId: string, input: NotificationInput) {
    return this.deps.prisma.userSetting.upsert({
      where: { userId },
      update: { notificationSettings: input as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
      create: { userId, notificationSettings: input as unknown as Prisma.InputJsonValue }
    });
  }

  public async changePassword(userId: string, currentSessionId: string | undefined, currentPassword: string, newPassword: string) {
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) {
      throw new ConflictError("PASSWORD_CHANGE_NOT_AVAILABLE", "Password login is not configured for this account.");
    }

    const valid = await verifyPassword(user.passwordHash, currentPassword);
    if (!valid) throw new UnauthorizedError("Current password is incorrect.");

    const passwordHash = await hashPassword(newPassword);
    await this.deps.prisma.$transaction([
      this.deps.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, version: { increment: 1 } }
      }),
      this.deps.prisma.session.updateMany({
        where: { userId, revokedAt: null, ...(currentSessionId ? { id: { not: currentSessionId } } : {}) },
        data: { revokedAt: new Date() }
      })
    ]);
  }

  public async revokeSession(userId: string, sessionId: string, currentSessionId?: string) {
    if (currentSessionId && sessionId === currentSessionId) {
      throw new ForbiddenError("Use logout to end the current session.");
    }

    const result = await this.deps.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    if (result.count === 0) throw new NotFoundError("Session");
    return result;
  }

  private async ensureProviderAndModels(input: AiPreferenceInput) {
    if (!input.provider_id) return;

    const provider = await this.deps.prisma.aiProvider.findUnique({ where: { id: input.provider_id } });
    if (!provider || !provider.enabled) {
      throw new ValidationError("Selected provider is invalid.", {
        fields: [{ path: "provider_id", message: "Choose an enabled provider." }]
      });
    }

    const modelIds = [input.analysis_model_id, input.text_model_id, input.tts_model_id].filter(
      (value): value is string => Boolean(value)
    );
    if (!modelIds.length) return;

    const models = await this.deps.prisma.aiModel.findMany({
      where: { id: { in: modelIds }, providerId: input.provider_id, enabled: true },
      select: { id: true }
    });
    if (models.length !== modelIds.length) {
      throw new ValidationError("Selected model is invalid.", {
        fields: [{ path: "analysis_model_id", message: "Selected models must belong to the chosen provider." }]
      });
    }
  }

  private async upsertUserCredential(userId: string, input: AiPreferenceInput, existingCredentialId?: string) {
    if (!input.provider_id) {
      throw new ValidationError("Provider is required when using your own credential.", {
        fields: [{ path: "provider_id", message: "Choose a provider first." }]
      });
    }

    const payload = input.rotate_payload_json ?? input.payload_json;
    const label = input.label ?? "My provider credential";

    if (existingCredentialId) {
      if (!payload) return existingCredentialId;
      const encrypted = encryptCredentialPayload(payload);
      const updated = await this.deps.prisma.encryptedCredential.updateMany({
        where: { id: existingCredentialId, ownerUserId: userId, scope: "USER" },
        data: {
          providerId: input.provider_id,
          label,
          encryptedPayload: encrypted.encryptedPayload,
          encryptedDataKey: encrypted.encryptedDataKey,
          keyVersion: encrypted.keyVersion,
          maskedHint: maskCredentialPayload(payload),
          lastConnectionStatus: "ROTATED",
          status: "ACTIVE",
          version: { increment: 1 }
        }
      });
      if (updated.count === 0) throw new NotFoundError("User credential");
      return existingCredentialId;
    }

    if (!payload) {
      throw new ValidationError("Secret payload is required for a new user-owned credential.", {
        fields: [{ path: "payload_json", message: "Provide encrypted credential payload data." }]
      });
    }

    const encrypted = encryptCredentialPayload(payload);
    const credential = await this.deps.prisma.encryptedCredential.create({
      data: {
        providerId: input.provider_id,
        ownerUserId: userId,
        scope: "USER",
        label,
        encryptedPayload: encrypted.encryptedPayload,
        encryptedDataKey: encrypted.encryptedDataKey,
        keyVersion: encrypted.keyVersion,
        maskedHint: maskCredentialPayload(payload),
        status: "ACTIVE",
        lastConnectionStatus: "SAVED"
      }
    });
    return credential.id;
  }
}

function normalizeNotifications(raw: unknown) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    email_job_completed: data.email_job_completed === true,
    email_job_failed: data.email_job_failed !== false,
    email_quota_warning: data.email_quota_warning !== false,
    in_app_job_completed: data.in_app_job_completed !== false,
    in_app_job_failed: data.in_app_job_failed !== false,
    in_app_publish_completed: data.in_app_publish_completed === true
  };
}
