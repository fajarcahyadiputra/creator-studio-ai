import fs from "node:fs/promises";
import path from "node:path";
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

export async function listLocalTtsModels(): Promise<LocalTtsModelSummary[]> {
  const directory = env.TTS_MODEL_DIR;
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  const modelFiles = entries.filter((entry) => entry.endsWith(".onnx")).sort();
  const summaries = await Promise.all(modelFiles.map((fileName) => buildModelSummary(directory, fileName)));
  return summaries.filter((summary): summary is LocalTtsModelSummary => summary !== null);
}

async function buildModelSummary(directory: string, fileName: string): Promise<LocalTtsModelSummary | null> {
  const baseName = fileName.replace(/\.onnx$/i, "");
  const configPath = path.join(directory, `${fileName}.json`);
  let config: PiperModelConfig = {};

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    config = JSON.parse(raw) as PiperModelConfig;
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
    defaultSampleText: buildDefaultSampleText(languageCode)
  };
}

function buildDefaultSampleText(languageCode: string): string {
  const normalized = languageCode.toLowerCase();
  if (normalized.startsWith("id_")) {
    return "Halo, ini adalah sample suara untuk preview model TTS.";
  }
  if (normalized.startsWith("en_")) {
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
