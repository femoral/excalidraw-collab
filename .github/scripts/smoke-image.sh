#!/usr/bin/env bash
# Smoke-test a published (or local) excalidraw-collab image the same way a
# local compose run is verified: bring the container up, wait for /healthz,
# then exercise a real API round trip (create scene → push document → pull).
#
# Usage:
#   .github/scripts/smoke-image.sh ghcr.io/owner/repo:sha-abc1234
#   .github/scripts/smoke-image.sh excalidraw-collab:local
#
# BOOTSTRAP_TOKEN is generated at runtime for this disposable container — it is
# never read from the repository and must not be committed.

set -euo pipefail

IMAGE="${1:?usage: smoke-image.sh <image-ref>}"

# Ephemeral token for this run only (not a secret material in the repo).
TOKEN="ci-smoke-$(openssl rand -hex 12)"
PORT="${SMOKE_PORT:-${PORT:-18080}}"
NAME="excalidraw-collab-smoke-$$"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "==> Using local image ${IMAGE}"
else
  echo "==> Pulling ${IMAGE}"
  docker pull "${IMAGE}"
fi

echo "==> Starting container ${NAME}"
docker run -d --name "${NAME}" \
  -e "BOOTSTRAP_TOKEN=${TOKEN}" \
  -e PORT=3000 \
  -e DATA_DIR=/data \
  -e RENDER_WORKER=off \
  -e LOG_LEVEL=warn \
  -p "127.0.0.1:${PORT}:3000" \
  "${IMAGE}" >/dev/null

echo "==> Waiting for GET /healthz"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "${BASE}/healthz" 2>/dev/null | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    ready=1
    break
  fi
  # Fail fast if the container has already exited.
  if ! docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null | grep -q true; then
    echo "container exited before becoming healthy" >&2
    docker logs "${NAME}" >&2 || true
    exit 1
  fi
  sleep 1
done
if [ "${ready}" -ne 1 ]; then
  echo "GET /healthz never returned ok" >&2
  docker logs "${NAME}" >&2 || true
  exit 1
fi
echo "    healthz ok"

auth=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

echo "==> POST /api/scenes (create)"
create_body='{"name":"CI Smoke","slug":"ci-smoke"}'
create_res="$(curl -fsS -X POST "${BASE}/api/scenes" "${auth[@]}" -d "${create_body}")"
echo "${create_res}" | grep -q '"slug"[[:space:]]*:[[:space:]]*"ci-smoke"' \
  || { echo "create scene response unexpected: ${create_res}" >&2; exit 1; }
echo "    scene created"

echo "==> POST /api/scenes/ci-smoke/scene (push document)"
# Minimal valid rectangle (same shape as server unit tests). parentVersion 0
# is the empty-scene baseline for a first commit.
push_body='{
  "parentVersion": 0,
  "message": "ci smoke push",
  "elements": [
    {
      "id": "rect-smoke",
      "type": "rectangle",
      "x": 0,
      "y": 0,
      "width": 100,
      "height": 50,
      "angle": 0,
      "strokeColor": "#000000",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 1,
      "version": 1,
      "versionNonce": 1,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false
    }
  ],
  "appState": { "viewBackgroundColor": "#ffffff" }
}'
push_res="$(curl -fsS -X POST "${BASE}/api/scenes/ci-smoke/scene" "${auth[@]}" -d "${push_body}")"
echo "${push_res}" | grep -q '"version"[[:space:]]*:[[:space:]]*1' \
  || { echo "push response unexpected: ${push_res}" >&2; exit 1; }
echo "    document pushed (v1)"

echo "==> GET /api/scenes/ci-smoke/scene (read back)"
pull_res="$(curl -fsS "${BASE}/api/scenes/ci-smoke/scene" \
  -H "Authorization: Bearer ${TOKEN}")"
echo "${pull_res}" | grep -q '"id"[[:space:]]*:[[:space:]]*"rect-smoke"' \
  || { echo "pull missing element id: ${pull_res}" >&2; exit 1; }
echo "${pull_res}" | grep -q '"type"[[:space:]]*:[[:space:]]*"rectangle"' \
  || { echo "pull missing element type: ${pull_res}" >&2; exit 1; }
echo "    document matches"

echo "==> Smoke test passed for ${IMAGE}"
