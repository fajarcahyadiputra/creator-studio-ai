import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../../shared/errors/app-error.js";
import { validateExternalSourceUrl } from "./client.js";

describe("validateExternalSourceUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the normalized URL from the ingestion boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { normalized_url: "https://www.youtube.com/watch?v=abc123" }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      )
    );

    await expect(validateExternalSourceUrl("https://youtube.com/watch?v=abc123#fragment")).resolves.toBe(
      "https://www.youtube.com/watch?v=abc123"
    );
  });

  it("maps source-policy rejection into a validation error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "SOURCE_URL_REJECTED",
            message: "The source host is not enabled by platform policy."
          }
        }),
        {
          status: 422,
          headers: { "content-type": "application/json" }
        }
      )
    );

    const result = validateExternalSourceUrl("https://example.com/video");

    await expect(result).rejects.toBeInstanceOf(ValidationError);
    await expect(result).rejects.toMatchObject({
      message: "The source host is not enabled by platform policy."
    });
  });

  it("raises a retryable service error when the ingestion boundary is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(validateExternalSourceUrl("https://www.youtube.com/watch?v=abc123")).rejects.toMatchObject({
      code: "INGESTION_SERVICE_UNAVAILABLE",
      statusCode: 503,
      retryable: true
    });
  });
});
