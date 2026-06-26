# Kubernetes production baseline

The manifests are intentionally infrastructure-neutral and reference external secrets/services. Do not run PostgreSQL, Redis, Temporal, or object storage as single pods for production.

Before deployment:

1. Replace image references and ingress hostname.
2. Create `creator-studio-secrets` through External Secrets, sealed secrets, or the selected secret manager.
3. Add explicit NetworkPolicy egress ranges and provider destinations.
4. Run the migration Job before rolling out application deployments.
5. Configure KEDA or a custom metrics adapter for Temporal task-queue backlog scaling.
6. Add a separate GPU deployment only after GPU activities exist.
