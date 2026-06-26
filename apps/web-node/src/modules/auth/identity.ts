export interface IdentityContext {
  actorUserId: string;
  effectiveUserId: string;
  permissions: ReadonlySet<string>;
  isImpersonating: boolean;
}
