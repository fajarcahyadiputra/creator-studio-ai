import { beforeEach, describe, expect, it, vi } from "vitest";

const { validateExternalSourceUrl } = vi.hoisted(() => ({
  validateExternalSourceUrl: vi.fn(),
}));

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    brandKit: { findFirst: vi.fn().mockResolvedValue(null) },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
  }
}));

vi.mock("../../infrastructure/ingestion/client.js", () => ({
  validateExternalSourceUrl
}));

vi.mock("../../infrastructure/temporal/client.js", () => ({
  temporalClient: vi.fn()
}));

vi.mock("../../infrastructure/storage/s3.js", () => ({
  createInternalSignedObjectReadUrl: vi.fn(),
  createPublicSignedObjectReadUrl: vi.fn(),
  deleteObjectKeys: vi.fn(),
  objectExists: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({
  env: {
    TEMPORAL_AUTO_CLIP_TASK_QUEUE: "auto-clipping",
    WEB_INTERNAL_BASE_URL: "http://web-node:3000",
  },
}));

import {
  buildClipOutputRenderWorkflowId,
  prepareAutoClippingInput,
  resolveRegeneratedAutoClipSource,
} from "./job-service.js";

beforeEach(() => {
  validateExternalSourceUrl.mockClear();
});

describe("prepareAutoClippingInput", () => {
  it("normalizes external source URLs before the job snapshot is persisted", async () => {
    validateExternalSourceUrl.mockResolvedValue("https://www.youtube.com/watch?v=clean");

    const result = await prepareAutoClippingInput("user-1", {
      source: { type: "EXTERNAL_URL", url: "https://youtube.com/watch?v=clean#t=12" },
      content: {
        title: "Clip source",
        custom_vocabulary: [],
        rights_confirmed: true
      },
      strategy: {},
      visual: {},
      subtitle: {},
      ai: {}
    });

    expect(validateExternalSourceUrl).toHaveBeenCalledWith("https://youtube.com/watch?v=clean#t=12");
    expect(result.source).toMatchObject({
      type: "EXTERNAL_URL",
      url: "https://www.youtube.com/watch?v=clean"
    });
  });

  it("leaves uploaded media sources unchanged", async () => {
    const input = {
      source: { type: "MEDIA_ASSET" as const, media_asset_id: "asset-1" },
      content: {
        title: "Clip source",
        custom_vocabulary: [],
        rights_confirmed: true
      },
      strategy: {},
      visual: {},
      subtitle: {},
      ai: {}
    };

    const result = await prepareAutoClippingInput("user-1", input);

    expect(validateExternalSourceUrl).not.toHaveBeenCalled();
    expect(result.source).toMatchObject(input.source);
  });
});

describe("buildClipOutputRenderWorkflowId", () => {
  it("builds a stable workflow id per clip output", () => {
    expect(buildClipOutputRenderWorkflowId("output-1")).toBe("clip-output-render:output-1");
  });
});

describe("resolveRegeneratedAutoClipSource", () => {
  it("replaces a blocked external URL with an uploaded media asset", () => {
    expect(
      resolveRegeneratedAutoClipSource(
        { type: "EXTERNAL_URL", url: "https://www.youtube.com/watch?v=blocked" },
        "asset-uploaded"
      )
    ).toEqual({
      type: "MEDIA_ASSET",
      media_asset_id: "asset-uploaded",
    });
  });

  it("keeps the existing source when no replacement was uploaded", () => {
    const source = { type: "MEDIA_ASSET" as const, media_asset_id: "asset-existing" };
    expect(resolveRegeneratedAutoClipSource(source)).toBe(source);
  });
});
