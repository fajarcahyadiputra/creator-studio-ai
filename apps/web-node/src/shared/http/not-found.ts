import type { RequestHandler } from "express";

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "The requested route was not found.",
      request_id: request.requestId ?? "unknown",
      details: { method: request.method, path: request.path }
    }
  });
};
