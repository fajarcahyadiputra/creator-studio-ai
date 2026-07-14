import type { Prisma } from "../../generated/prisma/client.js";

export const AUTO_CLIP_ANALYZER_RUNTIME_KEY = "auto_clip_analyzer_runtime";

export type AutoClipAnalyzerMode = "openai_then_heuristic" | "heuristic_then_openai" | "heuristic";

export interface AutoClipAnalyzerRuntimeConfig {
  mode: AutoClipAnalyzerMode;
  provider: string;
  model: string;
}

export const LOCAL_HEURISTIC_PROVIDER_CODE = "python-local";
export const LOCAL_HEURISTIC_MODEL_CODE = "heuristic-local";

export const DEFAULT_AUTO_CLIP_ANALYZER_RUNTIME_CONFIG: AutoClipAnalyzerRuntimeConfig = {
  mode: "openai_then_heuristic",
  provider: "openai",
  model: "gpt-5.5"
};

export function normalizeAutoClipAnalyzerRuntimeConfig(
  value: Prisma.JsonValue | Record<string, unknown> | AutoClipAnalyzerRuntimeConfig | null | undefined
): AutoClipAnalyzerRuntimeConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

  const mode =
    record.mode === "heuristic"
      ? "heuristic"
      : record.mode === "heuristic_then_openai"
        ? "heuristic_then_openai"
        : record.mode === "openai"
          ? "openai_then_heuristic"
          : record.mode === "openai_then_heuristic"
            ? "openai_then_heuristic"
            : DEFAULT_AUTO_CLIP_ANALYZER_RUNTIME_CONFIG.mode;
  const fallbackProvider = mode === "heuristic" ? LOCAL_HEURISTIC_PROVIDER_CODE : DEFAULT_AUTO_CLIP_ANALYZER_RUNTIME_CONFIG.provider;
  const fallbackModel = mode === "heuristic" ? LOCAL_HEURISTIC_MODEL_CODE : DEFAULT_AUTO_CLIP_ANALYZER_RUNTIME_CONFIG.model;
  const provider =
    typeof record.provider === "string" && record.provider.trim().length > 0
      ? record.provider.trim().toLowerCase()
      : fallbackProvider;
  const model =
    typeof record.model === "string" && record.model.trim().length > 0
      ? record.model.trim()
      : fallbackModel;

  return {
    mode,
    provider,
    model
  };
}

export function buildAutoClipAnalyzerRuntimeSettingValue(
  value: Prisma.JsonValue | Record<string, unknown> | AutoClipAnalyzerRuntimeConfig | null | undefined
) {
  const normalized = normalizeAutoClipAnalyzerRuntimeConfig(value);
  return {
    mode: normalized.mode,
    provider: normalized.provider,
    model: normalized.model
  } satisfies Record<string, unknown>;
}
