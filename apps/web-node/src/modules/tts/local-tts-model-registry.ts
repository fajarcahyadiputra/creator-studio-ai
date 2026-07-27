import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../config/env.js";

export interface LocalTtsModelSummary {
  key: string;
  fileName: string;
  displayName: string;
  languageCode: string;
  localeGroup: string;
  voiceName: string;
  quality: string | null;
  sampleRate: number | null;
  speakerCount: number | null;
  phonemeType: string | null;
  dataset: string | null;
  defaultSampleText: string;
  engine: "piper";
  baseModelKey: string;
  profileKind: "derived" | "checkpoint";
  description: string;
  gender: string | null;
  ageGroup: string | null;
  character: string | null;
  intonation: string | null;
  speakingStyle: string | null;
  licenseName: string | null;
  licenseUrl: string | null;
  available: boolean;
}

export interface LocalTtsRegistryOptions {
  directory?: string;
  catalogPath?: string;
}

interface PiperModelConfig {
  audio?: {
    sample_rate?: unknown;
    quality?: unknown;
  };
  dataset?: unknown;
  phoneme_type?: unknown;
  num_speakers?: unknown;
}

interface VoiceProfileCatalog {
  profiles?: unknown;
}

interface VoiceProfile {
  key: string;
  modelKey: string;
  displayName: string;
  languageCode: string;
  profileKind: "derived";
  gender: string;
  ageGroup: string;
  character: string;
  intonation: string;
  speakingStyle: string;
  description: string;
  sampleText: string;
  licenseName: string | null;
  licenseUrl: string | null;
}

const catalogFileName = "tts-voice-profiles.json";

export async function listLocalTtsModels(
  options: LocalTtsRegistryOptions = {}
): Promise<LocalTtsModelSummary[]> {
  const directory = options.directory ?? env.TTS_MODEL_DIR;
  const entries = await readDirectory(directory);
  const modelFiles = entries.filter((entry) => entry.endsWith(".onnx")).sort();
  const checkpointSummaries = (
    await Promise.all(modelFiles.map((fileName) => buildCheckpointSummary(directory, fileName)))
  ).filter((summary): summary is LocalTtsModelSummary => summary !== null);
  const checkpointsByKey = new Map(checkpointSummaries.map((model) => [model.key, model]));
  const profiles = await loadVoiceProfiles(options.catalogPath);
  const profileSummaries = profiles.map((profile) =>
    buildProfileSummary(profile, checkpointsByKey.get(profile.modelKey))
  );

  return [...profileSummaries, ...checkpointSummaries];
}

export async function findLocalTtsModel(
  modelKey: string,
  options: LocalTtsRegistryOptions = {}
): Promise<LocalTtsModelSummary | null> {
  const normalized = modelKey.trim();
  if (!normalized) return null;
  return (await listLocalTtsModels(options)).find((model) => model.key === normalized) ?? null;
}

async function readDirectory(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}

async function buildCheckpointSummary(
  directory: string,
  fileName: string
): Promise<LocalTtsModelSummary | null> {
  const baseName = fileName.replace(/\.onnx$/i, "");
  const configPath = path.join(directory, `${fileName}.json`);
  let config: PiperModelConfig = {};

  try {
    config = JSON.parse(await fs.readFile(configPath, "utf-8")) as PiperModelConfig;
  } catch {
    config = {};
  }

  const [localeGroup, ...voiceParts] = baseName.split("-");
  if (!localeGroup || voiceParts.length === 0) return null;
  const voiceName = voiceParts.join("-");
  const quality = asOptionalString(config.audio?.quality) ?? inferQualityFromName(voiceName);
  const languageCode = localeGroup;

  return {
    key: baseName,
    fileName,
    displayName: `${humanizeLocale(languageCode)} - ${humanizeVoiceName(voiceName)}`,
    languageCode,
    localeGroup: humanizeLocale(languageCode),
    voiceName: humanizeVoiceName(voiceName),
    quality,
    sampleRate: asOptionalNumber(config.audio?.sample_rate),
    speakerCount: asOptionalNumber(config.num_speakers),
    phonemeType: asOptionalString(config.phoneme_type),
    dataset: asOptionalString(config.dataset),
    defaultSampleText: buildDefaultSampleText(languageCode),
    engine: "piper",
    baseModelKey: baseName,
    profileKind: "checkpoint",
    description: "Checkpoint Piper lokal tanpa tuning profil tambahan.",
    gender: null,
    ageGroup: null,
    character: null,
    intonation: null,
    speakingStyle: null,
    licenseName: null,
    licenseUrl: null,
    available: true
  };
}

function buildProfileSummary(
  profile: VoiceProfile,
  checkpoint: LocalTtsModelSummary | undefined
): LocalTtsModelSummary {
  return {
    key: profile.key,
    fileName: checkpoint?.fileName ?? `${profile.modelKey}.onnx`,
    displayName: profile.displayName,
    languageCode: profile.languageCode,
    localeGroup: humanizeLocale(profile.languageCode),
    voiceName: profile.displayName,
    quality: checkpoint?.quality ?? inferQualityFromName(profile.modelKey),
    sampleRate: checkpoint?.sampleRate ?? null,
    speakerCount: checkpoint?.speakerCount ?? null,
    phonemeType: checkpoint?.phonemeType ?? null,
    dataset: checkpoint?.dataset ?? null,
    defaultSampleText: profile.sampleText,
    engine: "piper",
    baseModelKey: profile.modelKey,
    profileKind: profile.profileKind,
    description: profile.description,
    gender: profile.gender,
    ageGroup: profile.ageGroup,
    character: profile.character,
    intonation: profile.intonation,
    speakingStyle: profile.speakingStyle,
    licenseName: profile.licenseName,
    licenseUrl: profile.licenseUrl,
    available: Boolean(checkpoint)
  };
}

async function loadVoiceProfiles(explicitPath?: string): Promise<VoiceProfile[]> {
  const catalogPath = explicitPath ?? (await findCatalogPath());
  if (!catalogPath) return [];

  try {
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf-8")) as VoiceProfileCatalog;
    if (!Array.isArray(catalog.profiles)) return [];
    return catalog.profiles
      .map(parseVoiceProfile)
      .filter((profile): profile is VoiceProfile => profile !== null);
  } catch {
    return [];
  }
}

async function findCatalogPath(): Promise<string | null> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "packages/contracts/json-schema", catalogFileName),
    path.resolve(process.cwd(), "../../packages/contracts/json-schema", catalogFileName),
    path.resolve(moduleDirectory, "../../../../../packages/contracts/json-schema", catalogFileName)
  ];

  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to the next runtime layout.
    }
  }
  return null;
}

function parseVoiceProfile(value: unknown): VoiceProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  const license =
    profile.license && typeof profile.license === "object" && !Array.isArray(profile.license)
      ? (profile.license as Record<string, unknown>)
      : {};
  const required = {
    key: asOptionalString(profile.key),
    modelKey: asOptionalString(profile.model_key),
    displayName: asOptionalString(profile.display_name),
    languageCode: asOptionalString(profile.language_code),
    gender: asOptionalString(profile.gender),
    ageGroup: asOptionalString(profile.age),
    character: asOptionalString(profile.character),
    intonation: asOptionalString(profile.intonation),
    speakingStyle: asOptionalString(profile.speaking_style),
    description: asOptionalString(profile.description),
    sampleText: asOptionalString(profile.sample_text)
  };
  if (Object.values(required).some((entry) => entry === null)) return null;

  return {
    key: required.key!,
    modelKey: required.modelKey!,
    displayName: required.displayName!,
    languageCode: required.languageCode!,
    profileKind: "derived",
    gender: required.gender!,
    ageGroup: required.ageGroup!,
    character: required.character!,
    intonation: required.intonation!,
    speakingStyle: required.speakingStyle!,
    description: required.description!,
    sampleText: required.sampleText!,
    licenseName: asOptionalString(license.name),
    licenseUrl: asOptionalString(license.url)
  };
}

function buildDefaultSampleText(languageCode: string): string {
  const normalized = languageCode.toLowerCase();
  if (normalized.startsWith("id_") || normalized.startsWith("id-")) {
    return "Halo, ini adalah sample suara untuk preview model TTS.";
  }
  if (normalized.startsWith("en_") || normalized.startsWith("en-")) {
    return "Hello, this is a sample voice preview for your narration workflow.";
  }
  return "Hello, this is a sample voice preview for your narration workflow.";
}

function humanizeLocale(value: string): string {
  return value.replace("_", "-");
}

function humanizeVoiceName(value: string): string {
  return value
    .split("-")
    .map((part) => part.replaceAll("_", " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferQualityFromName(value: string): string | null {
  const lowered = value.toLowerCase();
  if (lowered.includes("high")) return "high";
  if (lowered.includes("medium")) return "medium";
  if (lowered.includes("low")) return "low";
  return null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
