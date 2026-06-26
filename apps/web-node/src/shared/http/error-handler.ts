import type { ErrorRequestHandler } from "express";
import { AppError } from "../errors/app-error.js";
import { logger } from "../logging/logger.js";

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const requestId = request.requestId ?? "unknown";

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
