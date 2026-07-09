import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { logger } from "../logging/logger.js";

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = request.requestId ?? "unknown";
  const statusCode =
    typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : null;

  if (error instanceof AppError) {
    const log = error.statusCode >= 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(
      {
        requestId,
        code: error.code,
        statusCode: error.statusCode,
        retryable: error.retryable,
        details: error.details,
        err: error.statusCode >= 500 ? error : undefined
      },
      "Request failed"
    );

    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : "An unexpected error occurred.",
        request_id: requestId,
        details: error.expose ? error.details : {}
      }
    });
    return;
  }

  if (statusCode === 413) {
    logger.warn({ requestId, err: error }, "Request payload exceeded the configured size limit");
    response.status(413).json({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "The request payload is too large.",
        request_id: requestId,
        details: {}
      }
    });
    return;
  }

  logger.error({ requestId, err: error }, "Unhandled request error");
  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
      request_id: requestId,
      details: {}
    }
  });
};
