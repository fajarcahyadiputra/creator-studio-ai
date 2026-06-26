import "express-session";

declare module "express-session" {
  interface SessionData {
    actorUserId?: string;
    csrfToken?: string;
    trackedSessionId?: string;
    impersonation?: {
      targetUserId: string;
      reason: string;
      startedAt: string;
      auditLogId: string;
    };
  }
}
