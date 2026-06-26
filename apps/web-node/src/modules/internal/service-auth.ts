import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { UnauthorizedError } from "../../shared/errors/app-error.js";

export const requireInternalService: RequestHandler = (request, _response, next) => {
  const authorization = request.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(env.INTERNAL_SERVICE_TOKEN);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    next(new UnauthorizedError("Invalid internal service credential."));
    return;
  }
  next();
};
