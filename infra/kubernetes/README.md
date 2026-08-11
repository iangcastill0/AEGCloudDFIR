# Kubernetes deployment

Kustomize base for the three EvidenceVault services. Stateful dependencies
(PostgreSQL 16, Redis 7, OpenSearch 2.x, Authentik, ClamAV, Tika) are expected
to be provisioned separately — managed services or your own operators — and
wired in through the `evidencevault-config` / `evidencevault-secrets`
resources. Object storage is Wasabi (or any S3 API).

    kubectl apply -k infra/kubernetes/base

Before applying:
1. Create the namespace and secrets (see `secret.example.yaml`; use
   ExternalSecrets/SealedSecrets in production — never commit real values).
2. Run migrations as a Job (`migrate-job.yaml`) pointing at the migration role.
3. Adjust `configmap.yaml` endpoints for your environment.

Security posture applied to every pod: runAsNonRoot, readOnlyRootFilesystem,
no privilege escalation, seccomp RuntimeDefault, all capabilities dropped,
tmpfs for /tmp. NetworkPolicies restrict api/worker egress to the datastores
plus provider APIs (worker only). Autoscaling: HPA on the api (CPU) and a
worker HPA example driven by CPU; for queue-depth scaling consider KEDA with
a Redis list scaler (documented inline, not enabled by default).
