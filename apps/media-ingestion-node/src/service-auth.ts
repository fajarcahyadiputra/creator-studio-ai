import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { config } from "./config.js";

export const requireServiceAuth: RequestHandler = (request, response, next) => {
  const header = request.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const supplied = Buffer.from(token);
  const expected = Buffer.from(config.INTERNAL_SERVICE_TOKEN);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid service credential." } });
    return;
  }
  next();
};
