# Kubernetes / GitOps deploy

Kustomize manifests for running the single-container `excalidraw-collab` image
on Kubernetes. One Deployment, one Service, one PVC for `DATA_DIR`, and a
ConfigMap for non-secret env. Ingress is **overlay-only**.

## Layout

```
deploy/
  base/                 # environment-agnostic; safe to apply almost anywhere
    kustomization.yaml  # exposes `images` for tag bumps
    deployment.yaml
    service.yaml
    pvc.yaml
    configmap.yaml
  overlays/
    example/            # sample: SHA-pinned image + hostname Ingress
      kustomization.yaml
      ingress.yaml
  README.md
```

## Image reference (GHCR)

CI (issue #32) publishes to GitHub Container Registry:

| Reference | When |
|---|---|
| `ghcr.io/femoral/excalidraw-collab:latest` | tip of `main` (convenience only) |
| `ghcr.io/femoral/excalidraw-collab:<short-sha>` | every push; **prefer for GitOps** |
| `ghcr.io/femoral/excalidraw-collab:v<semver>` | git tags matching `v*` |

`<short-sha>` is the abbreviated commit SHA of the build (typically 7 hex
characters). Multi-arch: `linux/amd64` and `linux/arm64`.

Bump the tag via the kustomize `images` field (base or overlay):

```yaml
images:
  - name: ghcr.io/femoral/excalidraw-collab
    newTag: "a1b2c3d"   # short SHA from the CI-published package
```

If the GHCR package is private, add an `imagePullSecret` in an overlay; public
packages pull without credentials.

## Bootstrap Secret

`BOOTSTRAP_TOKEN` is never stored in this repository. Create the Secret in the
target namespace **before** the first apply:

```bash
kubectl create namespace excalidraw-collab   # if using the example overlay
kubectl -n excalidraw-collab create secret generic excalidraw-collab-bootstrap \
  --from-literal=BOOTSTRAP_TOKEN='replace-me-with-a-long-random-token'
```

The Deployment references:

- Secret name: `excalidraw-collab-bootstrap`
- Key: `BOOTSTRAP_TOKEN`

The Secret must exist for the pod to start (`secretKeyRef`). On first boot the
server hashes `BOOTSTRAP_TOKEN` into SQLite as the admin credential and marks
bootstrap complete; later boots do not re-seed from the env var (revoking the
admin token in the app is permanent even if the Secret still holds the old
value). After bootstrap, keep the Secret in place for the reference, or replace
it with a dummy value if you no longer want the plaintext on the cluster.

## Apply

```bash
# Render only
kubectl kustomize deploy/base
kubectl kustomize deploy/overlays/example

# Apply base (cluster default StorageClass; no Ingress)
kubectl apply -k deploy/base

# Apply example overlay (namespace + Ingress + SHA pin)
kubectl apply -k deploy/overlays/example
```

Nothing environment-specific lives in `base/`: no hostnames, no
`storageClassName`, no secret values. Put those in overlays.

## Rolling update and SQLite

The Deployment uses:

```yaml
replicas: 1
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 0
    maxUnavailable: 1
```

SQLite on a `ReadWriteOnce` volume must not be mounted by two pods at once.
`maxSurge: 0` prevents a surge pod; `maxUnavailable: 1` lets the single replica
terminate before its replacement starts. Keep `replicas: 1`.

## Probes and resources

| Probe | Path | Role |
|---|---|---|
| startup | `/healthz` | absorbs first-boot migration / slow PVC (up to ~60s) |
| liveness | `/healthz` | process alive (no Chromium required) |
| readiness | `/readyz` | SQLite reachable |

Memory requests/limits are sized for **Chromium** (the Playwright worker), not
Node: 1Gi request / 2Gi limit with `RENDER_WORKER=on`. Set `RENDER_WORKER=off`
and lower resources in an overlay if you do not need PNG/SVG/merge/skeleton.

## Data

PVC `excalidraw-collab-data` mounts at `/data` (`DATA_DIR`). Contents: SQLite
database (WAL) plus content-addressed files under `files/`. Back up the whole
volume (or use the app's backup CLI) before resizing or migrating clusters.
