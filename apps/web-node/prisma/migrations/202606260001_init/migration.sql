-- Creator Studio AI baseline migration.
-- Generated from prisma/schema.prisma by infra/scripts/generate-baseline-migration.mjs.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED');

CREATE TYPE "JobStatus" AS ENUM ('DRAFT', 'UPLOADING', 'QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED', 'CANCELED', 'FAILED', 'COMPLETED', 'PARTIALLY_COMPLETED', 'NEEDS_REVIEW');

CREATE TYPE "JobType" AS ENUM ('AUTO_CLIPPING', 'TEXT_TO_SPEECH', 'TRANSCRIPTION', 'MEDIA_INGESTION', 'PUBLISHING');

CREATE TYPE "JobStageStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'PAUSED', 'CANCELED', 'FAILED', 'COMPLETED', 'SKIPPED');

CREATE TYPE "JobAttemptStatus" AS ENUM ('CREATED', 'RUNNING', 'FAILED', 'COMPLETED', 'CANCELED');

CREATE TYPE "ErrorCategory" AS ENUM ('USER_INPUT', 'VALIDATION', 'PROVIDER_TEMPORARY', 'PROVIDER_PERMANENT', 'INFRASTRUCTURE_TEMPORARY', 'MEDIA_PERMANENT', 'INTERNAL_BUG', 'CANCELED');

CREATE TYPE "CredentialScope" AS ENUM ('PLATFORM', 'USER');

CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'DEGRADED', 'REVOKED', 'EXPIRED');

CREATE TYPE "CredentialMode" AS ENUM ('PLATFORM', 'USER_OWNED');

CREATE TYPE "AiCapability" AS ENUM ('CHAT', 'STRUCTURED_OUTPUT', 'TTS', 'STT', 'VISION', 'EMBEDDING', 'IMAGE_GENERATION');

CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TYPE "MediaAssetType" AS ENUM ('VIDEO', 'AUDIO', 'IMAGE', 'TRANSCRIPT', 'SUBTITLE', 'THUMBNAIL', 'DOCUMENT', 'OTHER');

CREATE TYPE "MediaAssetStatus" AS ENUM ('UPLOADING', 'VALIDATING', 'READY', 'QUARANTINED', 'FAILED', 'DELETED');

CREATE TYPE "UploadStatus" AS ENUM ('CREATED', 'UPLOADING', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED', 'FAILED');

CREATE TYPE "ClipQualityStatus" AS ENUM ('PENDING', 'PASSED', 'NEEDS_REVIEW', 'FAILED');

CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELED');

CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'CUSTOM');

CREATE TYPE "NotificationType" AS ENUM ('JOB_COMPLETED', 'JOB_FAILED', 'PUBLISH_COMPLETED', 'PUBLISH_FAILED', 'QUOTA_WARNING', 'SECURITY', 'SYSTEM');

CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'WEBHOOK');

CREATE TYPE "UsageMetric" AS ENUM ('AI_INPUT_TOKENS', 'AI_OUTPUT_TOKENS', 'TRANSCRIPTION_SECONDS', 'RENDER_SECONDS', 'TTS_CHARACTERS', 'TTS_SECONDS', 'STORAGE_BYTES', 'CLIPS_GENERATED', 'SOURCE_SECONDS');

CREATE TYPE "PresetType" AS ENUM ('CLIPPING', 'SUBTITLE', 'TTS', 'BRAND', 'PUBLISHING');

CREATE TYPE "TranscriptStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

CREATE TYPE "TtsOutputStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

CREATE TABLE "User" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "email" VARCHAR(320) NOT NULL UNIQUE,
  "passwordHash" TEXT,
  "displayName" VARCHAR(160) NOT NULL,
  "avatarObjectKey" TEXT,
  "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  "emailVerifiedAt" TIMESTAMP(3),
  "locale" VARCHAR(10) NOT NULL DEFAULT 'id',
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Jakarta',
  "planId" UUID,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMP(3),
  "lastLoginAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Role" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "code" VARCHAR(80) NOT NULL UNIQUE,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT 'false',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Permission" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "code" VARCHAR(120) NOT NULL UNIQUE,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "UserRole" (
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "assignedBy" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "roleId")
);

CREATE TABLE "RolePermission" (
  "roleId" UUID NOT NULL,
  "permissionId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionId")
);

CREATE TABLE "Session" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "sessionId" VARCHAR(160) NOT NULL UNIQUE,
  "ipAddress" VARCHAR(64),
  "userAgent" TEXT,
  "deviceName" VARCHAR(160),
  "impersonatedUserId" UUID,
  "impersonationReason" TEXT,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "OAuthAccount" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "provider" VARCHAR(50) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320),
  "accessTokenCipher" TEXT,
  "refreshTokenCipher" TEXT,
  "tokenExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "PasswordResetToken" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "EmailVerificationToken" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "UserSetting" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL UNIQUE,
  "defaultContentNiche" VARCHAR(120),
  "defaultAudience" VARCHAR(255),
  "notificationSettings" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "preferences" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AiProvider" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "code" VARCHAR(80) NOT NULL UNIQUE,
  "displayName" VARCHAR(120) NOT NULL,
  "adapterType" VARCHAR(100) NOT NULL,
  "baseUrl" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "healthStatus" VARCHAR(40) NOT NULL DEFAULT 'UNKNOWN',
  "timeoutMs" INTEGER NOT NULL DEFAULT 60000,
  "retryPolicy" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "rateLimitConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AiModel" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "providerId" UUID NOT NULL,
  "identifier" VARCHAR(200) NOT NULL,
  "displayName" VARCHAR(160) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "contextLimit" INTEGER,
  "inputPricePerMillion" DECIMAL(14,6),
  "outputPricePerMillion" DECIMAL(14,6),
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AiModelCapability" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "modelId" UUID NOT NULL,
  "capability" "AiCapability" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "config" JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE "EncryptedCredential" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "providerId" UUID NOT NULL,
  "ownerUserId" UUID,
  "scope" "CredentialScope" NOT NULL,
  "label" VARCHAR(120) NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "encryptedDataKey" TEXT NOT NULL,
  "keyVersion" VARCHAR(80) NOT NULL,
  "maskedHint" VARCHAR(40),
  "status" "CredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "allowedTools" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "allowedModelIds" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "usageLimitConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "lastTestedAt" TIMESTAMP(3),
  "lastConnectionStatus" VARCHAR(40),
  "expiresAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "UserAiPreference" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "toolType" "JobType" NOT NULL,
  "credentialMode" "CredentialMode" NOT NULL DEFAULT 'PLATFORM',
  "providerId" UUID,
  "credentialId" UUID,
  "analysisModelId" UUID,
  "textModelId" UUID,
  "ttsModelId" UUID,
  "baseUrlOverride" TEXT,
  "organizationId" VARCHAR(160),
  "projectId" VARCHAR(160),
  "settings" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Project" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "description" TEXT,
  "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "MediaAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "projectId" UUID,
  "type" "MediaAssetType" NOT NULL,
  "status" "MediaAssetStatus" NOT NULL DEFAULT 'UPLOADING',
  "displayName" VARCHAR(255) NOT NULL,
  "originalFileName" VARCHAR(255),
  "objectKey" TEXT NOT NULL UNIQUE,
  "mimeType" VARCHAR(160),
  "extension" VARCHAR(20),
  "sizeBytes" BIGINT,
  "checksumSha256" CHAR(64),
  "durationMs" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "frameRate" DECIMAL(10,4),
  "audioSampleRate" INTEGER,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "retentionExpiresAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "UploadSession" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "mediaAssetId" UUID NOT NULL UNIQUE,
  "objectKey" TEXT NOT NULL UNIQUE,
  "multipartUploadId" TEXT NOT NULL UNIQUE,
  "status" "UploadStatus" NOT NULL DEFAULT 'CREATED',
  "expectedSizeBytes" BIGINT NOT NULL,
  "partSizeBytes" INTEGER NOT NULL,
  "contentType" VARCHAR(160) NOT NULL,
  "checksumAlgorithm" VARCHAR(20) NOT NULL DEFAULT 'SHA256',
  "completedParts" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "projectId" UUID,
  "sourceMediaAssetId" UUID,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'DRAFT',
  "currentStage" VARCHAR(100),
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "eventSequence" BIGINT NOT NULL DEFAULT 0,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "operationKey" VARCHAR(100) NOT NULL,
  "workflowId" TEXT,
  "workflowRunId" TEXT,
  "inputSnapshot" JSONB NOT NULL,
  "outputSummary" JSONB,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "cancelRequestedAt" TIMESTAMP(3),
  "pauseRequestedAt" TIMESTAMP(3),
  "pausedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "retentionExpiresAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "JobStage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "status" "JobStageStatus" NOT NULL DEFAULT 'PENDING',
  "stageVersion" INTEGER NOT NULL DEFAULT 1,
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "progressWeight" DECIMAL(5,2) NOT NULL,
  "activityId" VARCHAR(255),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "checkpointObjectKey" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "JobEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "sequence" BIGINT NOT NULL,
  "stage" VARCHAR(100),
  "stageProgress" INTEGER,
  "overallProgress" INTEGER,
  "eventType" VARCHAR(100) NOT NULL,
  "message" TEXT NOT NULL,
  "userMessage" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "JobAttempt" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" "JobAttemptStatus" NOT NULL DEFAULT 'CREATED',
  "requestedStage" VARCHAR(100),
  "reason" TEXT,
  "workflowId" TEXT UNIQUE,
  "workflowRunId" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "JobError" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "jobStageId" UUID,
  "technicalErrorId" VARCHAR(100) NOT NULL UNIQUE,
  "code" VARCHAR(120) NOT NULL,
  "category" "ErrorCategory" NOT NULL,
  "retryable" BOOLEAN NOT NULL DEFAULT 'false',
  "message" TEXT NOT NULL,
  "userMessage" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "stackObjectKey" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3)
);

CREATE TABLE "AutoClipRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL UNIQUE,
  "sourceMediaAssetId" UUID,
  "sourceType" VARCHAR(40) NOT NULL,
  "sourceUrl" TEXT,
  "sourceLanguage" VARCHAR(20),
  "speakerCount" INTEGER,
  "contentTitle" VARCHAR(255),
  "contentContext" TEXT,
  "topic" VARCHAR(255),
  "customVocabulary" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "rightsConfirmedAt" TIMESTAMP(3) NOT NULL,
  "strategyConfig" JSONB NOT NULL,
  "visualConfig" JSONB NOT NULL,
  "subtitleConfig" JSONB NOT NULL,
  "providerConfigSnapshot" JSONB NOT NULL,
  "promptVersion" VARCHAR(80),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ClipCandidate" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "transcriptId" UUID,
  "candidateExternalId" VARCHAR(160) NOT NULL,
  "startMs" BIGINT NOT NULL,
  "endMs" BIGINT NOT NULL,
  "durationMs" BIGINT NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "hookText" TEXT NOT NULL,
  "endingText" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "whyItWorks" JSONB NOT NULL,
  "contentCategory" VARCHAR(40) NOT NULL,
  "scoreBreakdown" JSONB NOT NULL,
  "baseViralScore" DECIMAL(4,2) NOT NULL,
  "finalViralScore" DECIMAL(4,2) NOT NULL,
  "contextComplete" BOOLEAN NOT NULL,
  "safetyNotes" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "metadataSuggestions" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "speakerIds" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "sceneIds" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "analyzerMetadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "selected" BOOLEAN NOT NULL DEFAULT 'false',
  "rank" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "ClipOutput" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL,
  "candidateId" UUID NOT NULL,
  "mediaAssetId" UUID,
  "version" INTEGER NOT NULL DEFAULT 1,
  "qualityStatus" "ClipQualityStatus" NOT NULL DEFAULT 'PENDING',
  "previewObjectKey" TEXT,
  "finalObjectKey" TEXT,
  "metadataObjectKey" TEXT,
  "thumbnailObjectKey" TEXT,
  "renderSettings" JSONB NOT NULL,
  "qualityReport" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "durationMs" BIGINT,
  "width" INTEGER,
  "height" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Transcript" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "mediaAssetId" UUID NOT NULL,
  "jobId" UUID,
  "status" "TranscriptStatus" NOT NULL DEFAULT 'PROCESSING',
  "detectedLanguage" VARCHAR(20),
  "languageConfidence" DECIMAL(6,5),
  "modelIdentifier" VARCHAR(200),
  "wordTimestamps" BOOLEAN NOT NULL DEFAULT 'false',
  "diarizationEnabled" BOOLEAN NOT NULL DEFAULT 'false',
  "rawObjectKey" TEXT,
  "normalizedObjectKey" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "TranscriptSegment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "transcriptId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "startMs" BIGINT NOT NULL,
  "endMs" BIGINT NOT NULL,
  "speakerLabel" VARCHAR(80),
  "rawText" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "confidence" DECIMAL(6,5),
  "words" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE TABLE "SubtitleAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "mediaAssetId" UUID NOT NULL,
  "clipOutputId" UUID,
  "format" VARCHAR(20) NOT NULL,
  "language" VARCHAR(20) NOT NULL,
  "objectKey" TEXT NOT NULL UNIQUE,
  "isBurnedIn" BOOLEAN NOT NULL DEFAULT 'false',
  "styleSnapshot" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "TtsRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL UNIQUE,
  "script" TEXT NOT NULL,
  "language" VARCHAR(20) NOT NULL,
  "providerId" UUID,
  "modelId" UUID,
  "voiceIdentifier" VARCHAR(200),
  "speakingStyle" VARCHAR(80),
  "emotion" VARCHAR(80),
  "speakingSpeed" DECIMAL(5,2),
  "pitch" DECIMAL(5,2),
  "pauseIntensity" DECIMAL(5,2),
  "targetDurationMs" BIGINT,
  "pronunciationDictionary" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "outputConfig" JSONB NOT NULL,
  "customVoiceConsentId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "TtsOutput" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "ttsRequestId" UUID NOT NULL,
  "mediaAssetId" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "TtsOutputStatus" NOT NULL DEFAULT 'PROCESSING',
  "durationMs" BIGINT,
  "providerMetadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "TranscriptionRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID NOT NULL UNIQUE,
  "sourceMediaAssetId" UUID NOT NULL,
  "language" VARCHAR(20),
  "modelPreset" VARCHAR(100),
  "wordTimestamps" BOOLEAN NOT NULL DEFAULT 'true',
  "diarization" BOOLEAN NOT NULL DEFAULT 'false',
  "expectedSpeakers" INTEGER,
  "customVocabulary" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "removeFillerWords" BOOLEAN NOT NULL DEFAULT 'false',
  "profanityHandling" VARCHAR(40),
  "subtitleConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "translationConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "SocialConnection" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "platform" "SocialPlatform" NOT NULL,
  "externalAccountId" VARCHAR(255) NOT NULL,
  "displayName" VARCHAR(255),
  "encryptedAccessToken" TEXT NOT NULL,
  "encryptedRefreshToken" TEXT,
  "encryptedDataKey" TEXT NOT NULL,
  "keyVersion" VARCHAR(80) NOT NULL,
  "tokenExpiresAt" TIMESTAMP(3),
  "scopes" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "status" VARCHAR(40) NOT NULL DEFAULT 'ACTIVE',
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3)
);

CREATE TABLE "PublishDestination" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "socialConnectionId" UUID NOT NULL,
  "externalId" VARCHAR(255) NOT NULL,
  "displayName" VARCHAR(255) NOT NULL,
  "destinationType" VARCHAR(80) NOT NULL,
  "capabilities" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "PublishJob" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "jobId" UUID,
  "clipOutputId" UUID NOT NULL,
  "socialConnectionId" UUID NOT NULL,
  "destinationId" UUID NOT NULL,
  "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
  "caption" TEXT,
  "hashtags" JSONB NOT NULL DEFAULT '[]'::JSONB,
  "thumbnailObjectKey" TEXT,
  "scheduledAt" TIMESTAMP(3),
  "externalPublishId" VARCHAR(255),
  "responseMetadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "publishedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Preset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID,
  "projectId" UUID,
  "type" "PresetType" NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "description" TEXT,
  "config" JSONB NOT NULL,
  "isSystem" BOOLEAN NOT NULL DEFAULT 'false',
  "isDefault" BOOLEAN NOT NULL DEFAULT 'false',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "BrandKit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "logoObjectKey" TEXT,
  "introObjectKey" TEXT,
  "outroObjectKey" TEXT,
  "fontConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "colorConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "safeMarginConfig" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "subtitlePreset" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "isDefault" BOOLEAN NOT NULL DEFAULT 'false',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3)
);

CREATE TABLE "Plan" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "code" VARCHAR(80) NOT NULL UNIQUE,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "priceMonthly" DECIMAL(14,2),
  "currency" CHAR(3) NOT NULL DEFAULT 'IDR',
  "limits" JSONB NOT NULL,
  "features" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "Quota" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID,
  "planId" UUID,
  "metric" "UsageMetric" NOT NULL,
  "limitValue" DECIMAL(20,4) NOT NULL,
  "usedValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "reservedValue" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "UsageRecord" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "jobId" UUID,
  "metric" "UsageMetric" NOT NULL,
  "quantity" DECIMAL(20,4) NOT NULL,
  "unit" VARCHAR(40) NOT NULL,
  "providerId" UUID,
  "modelId" UUID,
  "estimatedCost" DECIMAL(18,6),
  "currency" CHAR(3),
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Notification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "message" TEXT NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "readAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "WebhookEndpoint" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "userId" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "encryptedSecret" TEXT NOT NULL,
  "encryptedDataKey" TEXT NOT NULL,
  "keyVersion" VARCHAR(80) NOT NULL,
  "eventTypes" JSONB NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT 'true',
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "lastDeliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "AuditLog" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "actorUserId" UUID,
  "targetUserId" UUID,
  "action" VARCHAR(120) NOT NULL,
  "resourceType" VARCHAR(100),
  "resourceId" VARCHAR(160),
  "reason" TEXT,
  "requestId" VARCHAR(100),
  "ipAddress" VARCHAR(64),
  "userAgent" TEXT,
  "beforeData" JSONB,
  "afterData" JSONB,
  "metadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "FeatureFlag" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "key" VARCHAR(120) NOT NULL UNIQUE,
  "description" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT 'false',
  "rules" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "SystemSetting" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "key" VARCHAR(160) NOT NULL UNIQUE,
  "value" JSONB NOT NULL,
  "isSecret" BOOLEAN NOT NULL DEFAULT 'false',
  "description" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE INDEX "User_status_createdAt_idx" ON "User" ("status", "createdAt");
CREATE INDEX "User_planId_idx" ON "User" ("planId");
CREATE INDEX "User_deletedAt_idx" ON "User" ("deletedAt");
CREATE INDEX "UserRole_roleId_idx" ON "UserRole" ("roleId");
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission" ("permissionId");
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session" ("userId", "revokedAt");
CREATE INDEX "Session_expiresAt_idx" ON "Session" ("expiresAt");
CREATE UNIQUE INDEX "OAuthAccount_provider_providerAccountId_key" ON "OAuthAccount" ("provider", "providerAccountId");
CREATE INDEX "OAuthAccount_userId_idx" ON "OAuthAccount" ("userId");
CREATE INDEX "PasswordResetToken_userId_expiresAt_idx" ON "PasswordResetToken" ("userId", "expiresAt");
CREATE INDEX "EmailVerificationToken_userId_expiresAt_idx" ON "EmailVerificationToken" ("userId", "expiresAt");
CREATE INDEX "AiProvider_enabled_healthStatus_idx" ON "AiProvider" ("enabled", "healthStatus");
CREATE UNIQUE INDEX "AiModel_providerId_identifier_key" ON "AiModel" ("providerId", "identifier");
CREATE INDEX "AiModel_providerId_enabled_idx" ON "AiModel" ("providerId", "enabled");
CREATE UNIQUE INDEX "AiModelCapability_modelId_capability_key" ON "AiModelCapability" ("modelId", "capability");
CREATE INDEX "AiModelCapability_capability_enabled_idx" ON "AiModelCapability" ("capability", "enabled");
CREATE INDEX "EncryptedCredential_providerId_scope_status_idx" ON "EncryptedCredential" ("providerId", "scope", "status");
CREATE INDEX "EncryptedCredential_ownerUserId_status_idx" ON "EncryptedCredential" ("ownerUserId", "status");
CREATE UNIQUE INDEX "UserAiPreference_userId_toolType_key" ON "UserAiPreference" ("userId", "toolType");
CREATE INDEX "UserAiPreference_providerId_idx" ON "UserAiPreference" ("providerId");
CREATE INDEX "UserAiPreference_credentialId_idx" ON "UserAiPreference" ("credentialId");
CREATE INDEX "Project_userId_status_createdAt_idx" ON "Project" ("userId", "status", "createdAt");
CREATE INDEX "Project_deletedAt_idx" ON "Project" ("deletedAt");
CREATE INDEX "MediaAsset_userId_status_createdAt_idx" ON "MediaAsset" ("userId", "status", "createdAt");
CREATE INDEX "MediaAsset_projectId_type_idx" ON "MediaAsset" ("projectId", "type");
CREATE INDEX "MediaAsset_retentionExpiresAt_idx" ON "MediaAsset" ("retentionExpiresAt");
CREATE INDEX "MediaAsset_deletedAt_idx" ON "MediaAsset" ("deletedAt");
CREATE INDEX "UploadSession_userId_status_createdAt_idx" ON "UploadSession" ("userId", "status", "createdAt");
CREATE INDEX "UploadSession_expiresAt_status_idx" ON "UploadSession" ("expiresAt", "status");
CREATE UNIQUE INDEX "Job_userId_operationKey_idempotencyKey_key" ON "Job" ("userId", "operationKey", "idempotencyKey");
CREATE UNIQUE INDEX "Job_workflowId_key" ON "Job" ("workflowId");
CREATE INDEX "Job_userId_status_createdAt_idx" ON "Job" ("userId", "status", "createdAt");
CREATE INDEX "Job_type_status_createdAt_idx" ON "Job" ("type", "status", "createdAt");
CREATE INDEX "Job_projectId_idx" ON "Job" ("projectId");
CREATE INDEX "Job_sourceMediaAssetId_idx" ON "Job" ("sourceMediaAssetId");
CREATE INDEX "Job_retentionExpiresAt_idx" ON "Job" ("retentionExpiresAt");
CREATE UNIQUE INDEX "JobStage_jobId_name_stageVersion_key" ON "JobStage" ("jobId", "name", "stageVersion");
CREATE INDEX "JobStage_jobId_status_idx" ON "JobStage" ("jobId", "status");
CREATE UNIQUE INDEX "JobEvent_jobId_sequence_key" ON "JobEvent" ("jobId", "sequence");
CREATE INDEX "JobEvent_jobId_occurredAt_idx" ON "JobEvent" ("jobId", "occurredAt");
CREATE UNIQUE INDEX "JobAttempt_jobId_attemptNumber_key" ON "JobAttempt" ("jobId", "attemptNumber");
CREATE INDEX "JobAttempt_jobId_status_idx" ON "JobAttempt" ("jobId", "status");
CREATE INDEX "JobError_jobId_occurredAt_idx" ON "JobError" ("jobId", "occurredAt");
CREATE INDEX "JobError_category_retryable_idx" ON "JobError" ("category", "retryable");
CREATE INDEX "AutoClipRequest_sourceMediaAssetId_idx" ON "AutoClipRequest" ("sourceMediaAssetId");
CREATE UNIQUE INDEX "ClipCandidate_jobId_candidateExternalId_key" ON "ClipCandidate" ("jobId", "candidateExternalId");
CREATE INDEX "ClipCandidate_jobId_selected_rank_idx" ON "ClipCandidate" ("jobId", "selected", "rank");
CREATE INDEX "ClipCandidate_jobId_finalViralScore_idx" ON "ClipCandidate" ("jobId", "finalViralScore");
CREATE UNIQUE INDEX "ClipOutput_candidateId_version_key" ON "ClipOutput" ("candidateId", "version");
CREATE INDEX "ClipOutput_jobId_qualityStatus_idx" ON "ClipOutput" ("jobId", "qualityStatus");
CREATE INDEX "ClipOutput_mediaAssetId_idx" ON "ClipOutput" ("mediaAssetId");
CREATE INDEX "ClipOutput_deletedAt_idx" ON "ClipOutput" ("deletedAt");
CREATE UNIQUE INDEX "Transcript_mediaAssetId_version_key" ON "Transcript" ("mediaAssetId", "version");
CREATE INDEX "Transcript_jobId_status_idx" ON "Transcript" ("jobId", "status");
CREATE UNIQUE INDEX "TranscriptSegment_transcriptId_sequence_key" ON "TranscriptSegment" ("transcriptId", "sequence");
CREATE INDEX "TranscriptSegment_transcriptId_startMs_idx" ON "TranscriptSegment" ("transcriptId", "startMs");
CREATE INDEX "SubtitleAsset_clipOutputId_format_idx" ON "SubtitleAsset" ("clipOutputId", "format");
CREATE UNIQUE INDEX "TtsOutput_ttsRequestId_version_key" ON "TtsOutput" ("ttsRequestId", "version");
CREATE INDEX "TtsOutput_mediaAssetId_idx" ON "TtsOutput" ("mediaAssetId");
CREATE INDEX "TranscriptionRequest_sourceMediaAssetId_idx" ON "TranscriptionRequest" ("sourceMediaAssetId");
CREATE UNIQUE INDEX "SocialConnection_platform_externalAccountId_userId_key" ON "SocialConnection" ("platform", "externalAccountId", "userId");
CREATE INDEX "SocialConnection_userId_platform_status_idx" ON "SocialConnection" ("userId", "platform", "status");
CREATE UNIQUE INDEX "PublishDestination_socialConnectionId_externalId_key" ON "PublishDestination" ("socialConnectionId", "externalId");
CREATE INDEX "PublishDestination_socialConnectionId_enabled_idx" ON "PublishDestination" ("socialConnectionId", "enabled");
CREATE INDEX "PublishJob_status_scheduledAt_idx" ON "PublishJob" ("status", "scheduledAt");
CREATE INDEX "PublishJob_clipOutputId_idx" ON "PublishJob" ("clipOutputId");
CREATE INDEX "PublishJob_socialConnectionId_idx" ON "PublishJob" ("socialConnectionId");
CREATE INDEX "Preset_userId_type_deletedAt_idx" ON "Preset" ("userId", "type", "deletedAt");
CREATE INDEX "Preset_isSystem_type_idx" ON "Preset" ("isSystem", "type");
CREATE INDEX "BrandKit_userId_deletedAt_idx" ON "BrandKit" ("userId", "deletedAt");
CREATE INDEX "Quota_userId_metric_periodStart_periodEnd_idx" ON "Quota" ("userId", "metric", "periodStart", "periodEnd");
CREATE INDEX "Quota_planId_metric_idx" ON "Quota" ("planId", "metric");
CREATE INDEX "UsageRecord_userId_metric_occurredAt_idx" ON "UsageRecord" ("userId", "metric", "occurredAt");
CREATE INDEX "UsageRecord_jobId_idx" ON "UsageRecord" ("jobId");
CREATE INDEX "UsageRecord_providerId_modelId_occurredAt_idx" ON "UsageRecord" ("providerId", "modelId", "occurredAt");
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification" ("userId", "readAt", "createdAt");
CREATE INDEX "Notification_type_createdAt_idx" ON "Notification" ("type", "createdAt");
CREATE INDEX "WebhookEndpoint_userId_enabled_idx" ON "WebhookEndpoint" ("userId", "enabled");
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog" ("actorUserId", "createdAt");
CREATE INDEX "AuditLog_targetUserId_createdAt_idx" ON "AuditLog" ("targetUserId", "createdAt");
CREATE INDEX "AuditLog_resourceType_resourceId_createdAt_idx" ON "AuditLog" ("resourceType", "resourceId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog" ("action", "createdAt");

ALTER TABLE "User" ADD CONSTRAINT "User_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OAuthAccount" ADD CONSTRAINT "OAuthAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSetting" ADD CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiModel" ADD CONSTRAINT "AiModel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiModelCapability" ADD CONSTRAINT "AiModelCapability_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiModel" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EncryptedCredential" ADD CONSTRAINT "EncryptedCredential_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EncryptedCredential" ADD CONSTRAINT "EncryptedCredential_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProvider" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "EncryptedCredential" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_analysisModelId_fkey" FOREIGN KEY ("analysisModelId") REFERENCES "AiModel" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_textModelId_fkey" FOREIGN KEY ("textModelId") REFERENCES "AiModel" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UserAiPreference" ADD CONSTRAINT "UserAiPreference_ttsModelId_fkey" FOREIGN KEY ("ttsModelId") REFERENCES "AiModel" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_sourceMediaAssetId_fkey" FOREIGN KEY ("sourceMediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JobStage" ADD CONSTRAINT "JobStage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobError" ADD CONSTRAINT "JobError_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutoClipRequest" ADD CONSTRAINT "AutoClipRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipCandidate" ADD CONSTRAINT "ClipCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipCandidate" ADD CONSTRAINT "ClipCandidate_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ClipOutput" ADD CONSTRAINT "ClipOutput_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipOutput" ADD CONSTRAINT "ClipOutput_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ClipCandidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipOutput" ADD CONSTRAINT "ClipOutput_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Transcript" ADD CONSTRAINT "Transcript_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubtitleAsset" ADD CONSTRAINT "SubtitleAsset_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SubtitleAsset" ADD CONSTRAINT "SubtitleAsset_clipOutputId_fkey" FOREIGN KEY ("clipOutputId") REFERENCES "ClipOutput" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TtsRequest" ADD CONSTRAINT "TtsRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TtsOutput" ADD CONSTRAINT "TtsOutput_ttsRequestId_fkey" FOREIGN KEY ("ttsRequestId") REFERENCES "TtsRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TtsOutput" ADD CONSTRAINT "TtsOutput_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TranscriptionRequest" ADD CONSTRAINT "TranscriptionRequest_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SocialConnection" ADD CONSTRAINT "SocialConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishDestination" ADD CONSTRAINT "PublishDestination_socialConnectionId_fkey" FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_clipOutputId_fkey" FOREIGN KEY ("clipOutputId") REFERENCES "ClipOutput" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_socialConnectionId_fkey" FOREIGN KEY ("socialConnectionId") REFERENCES "SocialConnection" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublishJob" ADD CONSTRAINT "PublishJob_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "PublishDestination" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Preset" ADD CONSTRAINT "Preset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Preset" ADD CONSTRAINT "Preset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BrandKit" ADD CONSTRAINT "BrandKit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quota" ADD CONSTRAINT "Quota_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quota" ADD CONSTRAINT "Quota_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
