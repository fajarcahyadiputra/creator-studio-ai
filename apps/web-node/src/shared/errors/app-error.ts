export interface AppErrorOptions {
  code: string;
  message: string;
  statusCode: number;
  details?: Record<string, unknown>;
  expose?: boolean;
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown>;
  public readonly expose: boolean;
  public readonly retryable: boolean;
  public override readonly cause?: unknown;

  public constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details ?? {};
    this.expose = options.expose ?? options.statusCode < 500;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
  }
}

export class ValidationError extends AppError {
  public constructor(message: string, details: Record<string, unknown> = {}) {
    super({ code: "VALIDATION_ERROR", message, statusCode: 422, details });
  }
}

export class UnauthorizedError extends AppError {
  public constructor(message = "Authentication is required.") {
    super({ code: "UNAUTHORIZED", message, statusCode: 401 });
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = "You do not have permission for this action.") {
    super({ code: "FORBIDDEN", message, statusCode: 403 });
  }
}

export class NotFoundError extends AppError {
  public constructor(resource: string) {
    super({ code: "RESOURCE_NOT_FOUND", message: `${resource} was not found.`, statusCode: 404 });
  }
}

export class ConflictError extends AppError {
  public constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super({ code, message, statusCode: 409, details });
  }
}
