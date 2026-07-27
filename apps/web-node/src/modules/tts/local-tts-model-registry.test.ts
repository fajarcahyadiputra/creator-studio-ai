import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findLocalTtsModel, listLocalTtsModels } from "./local-tts-model-registry.js";

describe("local TTS model registry", () => {
  it("merges catalog profiles with installed checkpoints and preserves legacy keys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "creator-tts-registry-"));
    const modelDirectory = path.join(root, "models");
    const catalogPath = path.join(root, "catalog.json");
    await fs.mkdir(modelDirectory);

    try {
      await fs.writeFile(path.join(modelDirectory, "id_ID-news_tts-medium.onnx"), "model");
      await fs.writeFile(
        path.join(modelDirectory, "id_ID-news_tts-medium.onnx.json"),
        JSON.stringify({
          audio: { sample_rate: 22050, quality: "medium" },
          dataset: "news_tts",
          num_speakers: 1
        })
      );
      await fs.writeFile(
        catalogPath,
        JSON.stringify({
          profiles: [
            {
              key: "id-test-warm",
              model_key: "id_ID-news_tts-medium",
              display_name: "Test Warm",
              language_code: "id_ID",
              gender: "female",
              age: "adult",
              character: "warm",
              intonation: "natural",
              speaking_style: "storytelling",
              description: "Warm test profile",
              sample_text: "Halo dari profil pengujian.",
              license: { name: "Upstream terms", url: "https://example.com/license" }
            },
            {
              key: "id-missing",
              model_key: "id_ID-missing-medium",
              display_name: "Missing",
              language_code: "id_ID",
              gender: "male",
              age: "adult",
              character: "deep",
              intonation: "calm",
              speaking_style: "documentary",
              description: "Unavailable profile",
              sample_text: "Tidak tersedia."
            }
          ]
        })
      );

      const models = await listLocalTtsModels({ directory: modelDirectory, catalogPath });
      expect(models.map((model) => model.key)).toEqual([
        "id-test-warm",
        "id-missing",
        "id_ID-news_tts-medium"
      ]);
      expect(models[0]).toMatchObject({
        available: true,
        baseModelKey: "id_ID-news_tts-medium",
        profileKind: "derived",
        gender: "female",
        sampleRate: 22050
      });
      expect(models[1]?.available).toBe(false);
      expect(models[2]).toMatchObject({
        available: true,
        profileKind: "checkpoint",
        baseModelKey: "id_ID-news_tts-medium"
      });
      await expect(
        findLocalTtsModel("id-test-warm", { directory: modelDirectory, catalogPath })
      ).resolves.toMatchObject({ displayName: "Test Warm" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to checkpoint discovery when the catalog is malformed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "creator-tts-registry-"));
    try {
      await fs.writeFile(path.join(root, "en_GB-test-medium.onnx"), "model");
      const catalogPath = path.join(root, "catalog.json");
      await fs.writeFile(catalogPath, "{invalid");

      const models = await listLocalTtsModels({ directory: root, catalogPath });
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        key: "en_GB-test-medium",
        profileKind: "checkpoint",
        available: true
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
