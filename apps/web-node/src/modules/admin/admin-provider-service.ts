import type { Prisma } from "../../generated/prisma/client.js";
import { AiCapability } from "../../generated/prisma/enums.js";
import { NotFoundError, ValidationError } from "../../shared/errors/app-error.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { encryptCredentialPayload, maskCredentialPayload } from "./credential-crypto.js";

const CAPABILITY_ORDER = [
  "CHAT",
  "STRUCTURED_OUTPUT",
  "TTS",
  "STT",
  "VISION",
  "EMBEDDING",
  "IMAGE_GENERATION"
] as const;

interface AdminProviderServiceDeps {
  prisma: typeof prisma;
}

interface ProviderInput {
  code: string;
  display_name: string;
  adapter_type: string;
  base_url?: string;
  enabled: boolean;
  health_status: string;
  timeout_ms: number;
  retry_policy_json: Record<string, unknown>;
  rate_limit_config_json: Record<string, unknown>;
  metadata_json: Record<string, unknown>;
}

interface ModelInput {
  provider_id?: string;
  identifier: string;
  display_name: string;
  enabled: boolean;
  context_limit?: number;
  input_price_per_million?: number;
  output_price_per_million?: number;
  capabilities_csv: string[];
  metadata_json: Record<string, unknown>;
}

interface CredentialInput {
  provider_id: string;
  label: string;
  status: "ACTIVE" | "DEGRADED" | "REVOKED" | "EXPIRED";
  payload_json: Record<string, unknown>;
  allowed_tools_csv: string[];
  allowed_model_ids_csv: string[];
  usage_limit_config_json: Record<string, unknown>;
  last_connection_status?: string;
  expires_at?: string;
}

interface UpdateCredentialInput {
  label: string;
  status: "ACTIVE" | "DEGRADED" | "REVOKED" | "EXPIRED";
  rotate_payload_json?: Record<string, unknown>;
  allowed_tools_csv: string[];
  allowed_model_ids_csv: string[];
  usage_limit_config_json: Record<string, unknown>;
  last_connection_status?: string;
  expires_at?: string;
}

export class AdminProviderService {
  public constructor(private readonly deps: AdminProviderServiceDeps = { prisma }) {}

  public async getProviderManagementPageData() {
    const providers = await this.deps.prisma.aiProvider.findMany({
      include: {
        models: {
          include: {
            capabilities: {
              where: { enabled: true },
              orderBy: { capability: "asc" }
            }
          },
          orderBy: { displayName: "asc" }
        },
        credentials: {
          where: { scope: "PLATFORM" },
          orderBy: { createdAt: "desc" },
          take: 5
        },
        _count: {
          select: { credentials: true, models: true }
        }
      },
      orderBy: { displayName: "asc" }
    });

    return {
      capabilities: [...CAPABILITY_ORDER],
      providers: providers.map((provider) => ({
        id: provider.id,
        code: provider.code,
        displayName: provider.displayName,
        adapterType: provider.adapterType,
        baseUrl: provider.baseUrl,
        enabled: provider.enabled,
        healthStatus: provider.healthStatus,
        timeoutMs: provider.timeoutMs,
        retryPolicyJson: formatJson(provider.retryPolicy),
        rateLimitConfigJson: formatJson(provider.rateLimitConfig),
        metadataJson: formatJson(provider.metadata),
        modelCount: provider._count.models,
        credentialCount: provider._count.credentials,
        recentPlatformCredentials: provider.credentials.map((credential) => ({
          id: credential.id,
          label: credential.label,
          status: credential.status,
          maskedHint: credential.maskedHint,
          lastConnectionStatus: credential.lastConnectionStatus,
          allowedToolsCsv: formatArray(credential.allowedTools),
          allowedModelIdsCsv: formatArray(credential.allowedModelIds),
          usageLimitConfigJson: formatJson(credential.usageLimitConfig),
          expiresAt: credential.expiresAt?.toISOString() ?? ""
        })),
        models: provider.models.map((model) => ({
          id: model.id,
          identifier: model.identifier,
          displayName: model.displayName,
          enabled: model.enabled,
          contextLimit: model.contextLimit,
          inputPricePerMillion: model.inputPricePerMillion?.toString() ?? "",
          outputPricePerMillion: model.outputPricePerMillion?.toString() ?? "",
          metadataJson: formatJson(model.metadata),
          capabilities: model.capabilities.map((capability) => capability.capability)
        }))
      }))
    };
  }

  public async createProvider(input: ProviderInput) {
    return this.deps.prisma.aiProvider.create({
      data: {
        code: input.code,
        displayName: input.display_name,
        adapterType: input.adapter_type,
        baseUrl: input.base_url,
        enabled: input.enabled,
        healthStatus: input.health_status,
        timeoutMs: input.timeout_ms,
        retryPolicy: input.retry_policy_json as Prisma.InputJsonValue,
        rateLimitConfig: input.rate_limit_config_json as Prisma.InputJsonValue,
        metadata: input.metadata_json as Prisma.InputJsonValue
      }
    });
  }

  public async updateProvider(providerId: string, input: ProviderInput) {
    await this.requireProvider(providerId);
    return this.deps.prisma.aiProvider.update({
      where: { id: providerId },
      data: {
        code: input.code,
        displayName: input.display_name,
        adapterType: input.adapter_type,
        baseUrl: input.base_url,
        enabled: input.enabled,
        healthStatus: input.health_status,
        timeoutMs: input.timeout_ms,
        retryPolicy: input.retry_policy_json as Prisma.InputJsonValue,
        rateLimitConfig: input.rate_limit_config_json as Prisma.InputJsonValue,
        metadata: input.metadata_json as Prisma.InputJsonValue
      }
    });
  }

  public async createModel(input: ModelInput) {
    const providerId = input.provider_id;
    if (!providerId) {
      throw new ValidationError("Provider is required.", {
        fields: [{ path: "provider_id", message: "Provider is required." }]
      });
    }
    await this.requireProvider(providerId);
    return this.deps.prisma.$transaction(async (tx) => {
      const model = await tx.aiModel.create({
        data: {
          providerId,
          identifier: input.identifier,
          displayName: input.display_name,
          enabled: input.enabled,
          contextLimit: input.context_limit,
          inputPricePerMillion: input.input_price_per_million,
          outputPricePerMillion: input.output_price_per_million,
          metadata: input.metadata_json as Prisma.InputJsonValue
        }
      });
      if (input.capabilities_csv.length) {
        await tx.aiModelCapability.createMany({
          data: normalizeCapabilities(input.capabilities_csv).map((capability) => ({
            modelId: model.id,
            capability,
            enabled: true
          }))
        });
      }
      return model;
    });
  }

  public async updateModel(modelId: string, input: ModelInput) {
    const existing = await this.requireModel(modelId);
    const providerId = input.provider_id ?? existing.providerId;
    await this.requireProvider(providerId);

    return this.deps.prisma.$transaction(async (tx) => {
      await tx.aiModelCapability.deleteMany({ where: { modelId } });
      const model = await tx.aiModel.update({
        where: { id: modelId },
        data: {
          providerId,
          identifier: input.identifier,
          displayName: input.display_name,
          enabled: input.enabled,
          contextLimit: input.context_limit,
          inputPricePerMillion: input.input_price_per_million,
          outputPricePerMillion: input.output_price_per_million,
          metadata: input.metadata_json as Prisma.InputJsonValue
        }
      });
      if (input.capabilities_csv.length) {
        await tx.aiModelCapability.createMany({
          data: normalizeCapabilities(input.capabilities_csv).map((capability) => ({
            modelId,
            capability,
            enabled: true
          }))
        });
      }
      return model;
    });
  }

  public async createCredential(input: CredentialInput) {
    await this.requireProvider(input.provider_id);
    await this.ensureModelsBelongToProvider(input.provider_id, input.allowed_model_ids_csv);
    const encrypted = encryptCredentialPayload(input.payload_json);

    return this.deps.prisma.encryptedCredential.create({
      data: {
        providerId: input.provider_id,
        scope: "PLATFORM",
        label: input.label,
        encryptedPayload: encrypted.encryptedPayload,
        encryptedDataKey: encrypted.encryptedDataKey,
        keyVersion: encrypted.keyVersion,
        maskedHint: maskCredentialPayload(input.payload_json),
        status: input.status,
        allowedTools: input.allowed_tools_csv,
        allowedModelIds: input.allowed_model_ids_csv,
        usageLimitConfig: input.usage_limit_config_json as Prisma.InputJsonValue,
        lastConnectionStatus: input.last_connection_status,
        expiresAt: parseOptionalDate(input.expires_at)
      }
    });
  }

  public async updateCredential(credentialId: string, input: UpdateCredentialInput) {
    const credential = await this.requireCredential(credentialId);
    await this.ensureModelsBelongToProvider(credential.providerId, input.allowed_model_ids_csv);
    const rotatedPayload = input.rotate_payload_json;
    const rotated = rotatedPayload ? encryptCredentialPayload(rotatedPayload) : null;

    return this.deps.prisma.encryptedCredential.update({
      where: { id: credentialId },
      data: {
        label: input.label,
        status: input.status,
        ...(rotated
          ? {
              encryptedPayload: rotated.encryptedPayload,
              encryptedDataKey: rotated.encryptedDataKey,
              keyVersion: rotated.keyVersion,
              maskedHint: maskCredentialPayload(rotatedPayload!)
            }
          : {}),
        allowedTools: input.allowed_tools_csv,
        allowedModelIds: input.allowed_model_ids_csv,
        usageLimitConfig: input.usage_limit_config_json as Prisma.InputJsonValue,
        lastConnectionStatus: input.last_connection_status,
        expiresAt: parseOptionalDate(input.expires_at),
        version: { increment: 1 },
        lastTestedAt: rotated ? new Date() : undefined
      }
    });
  }

  private async requireProvider(providerId: string) {
    const provider = await this.deps.prisma.aiProvider.findUnique({ where: { id: providerId } });
    if (!provider) throw new NotFoundError("AI provider");
    return provider;
  }

  private async requireModel(modelId: string) {
    const model = await this.deps.prisma.aiModel.findUnique({ where: { id: modelId } });
    if (!model) throw new NotFoundError("AI model");
    return model;
  }

  private async requireCredential(credentialId: string) {
    const credential = await this.deps.prisma.encryptedCredential.findUnique({ where: { id: credentialId } });
    if (!credential) throw new NotFoundError("Encrypted credential");
    return credential;
  }

  private async ensureModelsBelongToProvider(providerId: string, modelIds: string[]) {
    if (!modelIds.length) return;
    const models = await this.deps.prisma.aiModel.findMany({
      where: { id: { in: modelIds }, providerId },
      select: { id: true }
    });
    if (models.length !== modelIds.length) {
      throw new ValidationError("Selected models are invalid for this provider.", {
        fields: [{ path: "allowed_model_ids_csv", message: "One or more model IDs do not belong to the selected provider." }]
      });
    }
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatArray(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join(",") : "";
}

function parseOptionalDate(value?: string): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError("Credential expiry is invalid.", {
      fields: [{ path: "expires_at", message: "Invalid date value." }]
    });
  }
  return parsed;
}

function normalizeCapabilities(values: string[]): AiCapability[] {
  return values.filter((value): value is AiCapability => value in AiCapability);
}
