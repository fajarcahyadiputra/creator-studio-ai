import type { IdentityContext } from "../modules/auth/identity.js";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      validatedBody?: unknown;
      identity?: IdentityContext;
    }
  }
}

export {};
