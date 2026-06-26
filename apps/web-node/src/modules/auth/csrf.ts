import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { ForbiddenError } from "../../shared/errors/app-error.js";

function signedToken(nonce: string): string {
  const signature = createHmac("sha256", env.CSRF_SECRET).update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

function validToken(token: string): boolean {
  const [nonce, signature] = token.split(".");
  if (!nonce || !signature) return false;
  const expected = signedToken(nonce);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export const attachCsrfToken: RequestHandler = (request, response, next) => {
  if (!request.session.csrfToken || !validToken(request.session.csrfToken)) {
    request.session.csrfToken = signedToken(randomBytes(24).toString("base64url"));
  }
  response.locals.csrfToken = request.session.csrfToken;
  next();
};

export const verifyCsrf: RequestHandler = (request, _response, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
  if (request.path.startsWith("/internal/")) return next();

  const supplied = request.get("x-csrf-token") ?? String(request.body?._csrf ?? "");
  const stored = request.session.csrfToken;
  if (!stored || !supplied || stored !== supplied || !validToken(stored)) {
    next(new ForbiddenError("The CSRF token is missing or invalid."));
    return;
  }
  next();
};
