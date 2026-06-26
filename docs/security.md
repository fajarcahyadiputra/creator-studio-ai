# Security

## Threat model highlights

### Account takeover

Mitigations include Argon2id, rate limiting, generic password-reset responses, short-lived hashed one-time tokens, secure cookies, session rotation, login audit records, and mandatory superadmin TOTP in the planned security increment.

### Broken object authorization

Repositories filter by both object ID and effective user ID. Admin routes additionally require explicit permissions. Object-storage URLs are created only after authorization.

### Secret exposure

Provider credentials use envelope encryption. Logs redact passwords, cookies, authorization headers, tokens, signed URLs, and credential fields. Decrypted provider secrets must exist only for the provider call and must never enter Temporal workflow history.

### Malicious uploads

Uploads are checked by declared MIME, extension, size, checksum metadata, post-upload magic bytes, FFprobe, and an antivirus hook. Media tooling runs non-root with resource and temporary-disk limits.

### SSRF

Only the ingestion service may fetch external sources. It enforces host capabilities, resolves DNS, rejects loopback/private/link-local/reserved addresses, restricts redirects, limits bytes and duration, and runs under an egress policy.

### Prompt injection

Transcript and media metadata are untrusted data, never system instructions. Analyzer output must match a JSON schema. The analyzer receives no command-execution or arbitrary-network tools.

## Checklist

- [x] Argon2id password hashing.
- [x] Secure server-side sessions and rotation on authentication.
- [x] CSRF synchronized token for mutating browser requests.
- [x] Global and sensitive-endpoint rate limiting.
- [x] RBAC and permission guards.
- [x] Audit-safe impersonation design.
- [x] Structured secret redaction.
- [x] Presigned URLs with short expiry.
- [x] Internal bearer service authentication for development.
- [ ] Production mTLS/service identity.
- [ ] Mandatory superadmin TOTP enforcement.
- [ ] Antivirus implementation selected and deployed.
- [ ] External KMS integration.
- [ ] Penetration test before public launch.
