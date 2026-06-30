import { describe, expect, it, vi } from "vitest";

const validateExternalSourceUrl = vi.fn();

vi.mock("../../infrastructure/database/prisma.js", () => ({
  prisma: {}
}));

vi.mock("../../infrastructure/ingestion/client.js", () => ({
  validateExternalSourceUrl
}));

vi.mock("../../infrastructure/temporal/client.js", () => ({
  temporalClient: vi.fn()
}));

import { buildClipOutputRenderWorkflowId, prepareAutoClippingInput } from "./job-service.js";

describe("prepareAutoClippingInput", () => {
  it("normalizes external source URLs before the job snapshot is persisted", async () => {
    validateExternalSourceUrl.mockResolvedValue("https://www.youtube.com/watch?v=clean");

    const result = await prepareAutoClippingInput({
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
    expect(result.source).toEqual({
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

    const result = await prepareAutoClippingInput(input);

    expect(validateExternalSourceUrl).not.toHaveBeenCalled();
    expect(result).toBe(input);
  });
});

describe("buildClipOutputRenderWorkflowId", () => {
  it("builds a stable workflow id per clip output", () => {
    expect(buildClipOutputRenderWorkflowId("output-1")).toBe("clip-output-render:output-1");
  });
});
