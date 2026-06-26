import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

export const requestContext: RequestHandler = (request, response, next) => {
  const incoming = request.header("x-request-id");
  const requestId = incoming && incoming.length <= 100 ? incoming : randomUUID();
  request.requestId = requestId;
  response.setHeader("x-request-id", requestId);
  next();
};
