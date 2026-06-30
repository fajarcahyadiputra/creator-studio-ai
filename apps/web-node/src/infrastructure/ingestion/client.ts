import { env } from "../../config/env.js";
import { AppError, ValidationError } from "../../shared/errors/app-error.js";

interface ValidateSourceResponse {
  data?: {
    normalized_url?: string;
  };
  error?: {
    code?: string;
    message?: string;
  };
}

export async function validateExternalSourceUrl(url: string): Promise<string> {
  let response: Response;

  try {
    response = await fetch(
      `${String(env.MEDIA_INGESTION_INTERNAL_BASE_URL).replace(/\/$/, "")}/internal/v1/ingestion/validate-source`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          url,
          declared_rights: true
        })
      }
    );
  } catch (error) {
    throw new AppError({
      code: "INGESTION_SERVICE_UNAVAILABLE",
      message: "The source validation service is unavailable.",
      statusCode: 503,
      retryable: true,
      cause: error
    });
  }

  const payload: ValidateSourceResponse | undefined = await parseJson(response);

  if (response.ok) {
    const normalizedUrl = payload?.data?.normalized_url;
    if (!normalizedUrl) {
      throw new AppError({
        code: "INGESTION_SERVICE_INVALID_RESPONSE",
        message: "The source validation service returned an invalid response.",
        statusCode: 502,
        retryable: true
      });
    }
    return normalizedUrl;
  }

  const message = payload?.error?.message?.trim();
  if (response.status === 422) {
    throw new ValidationError(message || "The external source URL was rejected by platform policy.");
  }

  throw new AppError({
    code: "INGESTION_SERVICE_ERROR",
    message: "The source validation service could not validate this URL.",
    statusCode: 502,
    retryable: response.status >= 500,
    details: {
      upstream_status: response.status,
      upstream_code: payload?.error?.code
    }
  });
}

async function parseJson(response: Response): Promise<ValidateSourceResponse | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  return (await response.json()) as ValidateSourceResponse;
}
