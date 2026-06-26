import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { ValidationError } from "../errors/app-error.js";

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (request, _response, next) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      next(
        new ValidationError("Request body is invalid.", {
          fields: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        })
      );
      return;
    }
    request.validatedBody = result.data;
    next();
  };
}
