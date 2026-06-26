import { ValidationError } from "../errors/app-error.js";

export function routeParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Route parameter ${name} must be a single non-empty value.`);
  }
  return value;
}
