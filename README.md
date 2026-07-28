# excalidraw-collab

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) with
server-side persistence, turn-based collaboration, and a CLI built for AI
agents.

Agents drop in explainers and architecture diagrams; humans iterate in the
browser. Each side takes a turn, and both can ask exactly what the other
changed (`diff`, `describe`).

**Upstream is never modified** — `@excalidraw/excalidraw` is a normal npm
dependency. Upgrades are a version bump plus the
[upgrade runbook](./docs/upgrade-excalidraw.md).

| Doc | Audience |
|---|---|
| [docs/cli.md](./docs/cli.md) | Full `excali` reference (generated from the CLI parsers) |
| [packages/cli/skills/excalidraw-collab](./packages/cli/skills/excalidraw-collab) | Agent skill — turn loop, conflicts, exit codes (install with `excali skills install`) |
| [docs/upgrade-excalidraw.md](./docs/upgrade-excalidraw.md) | Bumping `@excalidraw/excalidraw` |
| [docs/release.md](./docs/release.md) | Publishing the CLI to npm |
| [PLAN.md](./PLAN.md) | Architecture, data model, HTTP API |
| [deploy/README.md](./deploy/README.md) | Kubernetes / kustomize |

## Quickstart (Docker Compose)

Requirements: Docker with Compose v2.

```sh
# From the monorepo root. BOOTSTRAP_TOKEN is hashed on first boot as the admin token.
export BOOTSTRAP_TOKEN='replace-me-with-a-long-random-token'
docker compose -f docker/compose.yaml up --build
```

App listens on `http://localhost:3000` (override host port with `PORT=…`).
Data is bind-mounted at `./data` (relative to the repo root).

### Mint a token and use the CLI

The bootstrap token is already an admin credential. Install the CLI from npm
(Node 24+):

```sh
npm install -g @excalidraw-collab/cli   # provides the `excali` command
```

Working from a clone instead? `pnpm install && pnpm build`, then
`alias excali='node packages/cli/bin/excali'`.

```sh
excali login --server http://localhost:3000 --token "$BOOTSTRAP_TOKEN"
excali whoami
excali token create agent-bot          # prints a secret once — store it
excali new "Architecture" --slug arch
excali pull arch
# edit arch.excalidraw  (or open http://localhost:3000 in a browser)
excali push arch -m "initial diagram"
excali describe arch
excali diff arch --since-last-pull
```

### Teach your coding agent the workflow

The CLI ships an agent skill (turn loop, conflict handling, exit codes). Install
it into a skills directory instead of copying instructions by hand:

```sh
excali skills install                 # ./.claude/skills/excalidraw-collab/
excali skills install --scope user    # ~/.claude/skills/excalidraw-collab/
excali skills install --client agents # .agents/skills/… instead of .claude/
excali skills ls                      # what's bundled
```

`--dir PATH` targets an arbitrary skills directory, `--force` overwrites an
existing install, and `--dry-run` shows what would be written.

### Local dev without Docker

```sh
pnpm install
pnpm build

# Terminal 1 — API + optional static web (set SERVE_STATIC after building web)
export BOOTSTRAP_TOKEN='dev-bootstrap-token'
export DATA_DIR=./data
export RENDER_WORKER=off          # or on, if Playwright browsers are installed
pnpm --filter @excalidraw-collab/server exec node dist/main.js

# Terminal 2 — web Vite dev (proxies API as configured in the web package)
pnpm --filter @excalidraw-collab/web dev
```

## Configuration

All server config is **environment variables** (see `packages/server/src/config.ts`).

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DATA_DIR` | `./data` | SQLite DB + content-addressed `files/` |
| `BOOTSTRAP_TOKEN` | _(empty)_ | First-boot admin token (hashed into DB; later boots ignore a changed value for re-seed) |
| `RENDER_WORKER` | `off` | `on` / `off` — Playwright Chromium for PNG/SVG, skeleton convert, `--merge` |
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `SERVE_STATIC` | `false` | Serve the built web app (and `/render` for the worker) |
| `STATIC_ROOT` | `./public` | Directory of the built SPA when `SERVE_STATIC` is true |
| `MAX_FILE_BYTES` | `10485760` | Max upload size for binary files (10 MiB) |

Compose and the production image set `SERVE_STATIC=true`, `STATIC_ROOT=/app/public`,
`DATA_DIR=/data`, and default `RENDER_WORKER=on`.

### CLI config

| Mechanism | Details |
|---|---|
| `excali login --server URL --token T` | Writes `~/.config/excali/config.json` (or `$XDG_CONFIG_HOME/excali/`) mode `0600` |
| `EXCALI_SERVER` / `EXCALI_TOKEN` | Env overrides the file |
| `.excalidraw-collab/state.json` | Per-cwd last pulled/pushed version per scene (not credentials) |

## Deployment

### Docker Compose (primary)

```sh
export BOOTSTRAP_TOKEN='…'
docker compose -f docker/compose.yaml up --build -d
```

- Image build: `docker/Dockerfile` (multi-stage, Playwright runtime base).
- Volume: `./data:/data`.
- CI publishes multi-arch images to GHCR (`ghcr.io/femoral/excalidraw-collab`).

### Kubernetes

Kustomize base + example overlay under `deploy/`. Image pins, bootstrap Secret,
PVC, and Ingress notes: **[deploy/README.md](./deploy/README.md)**.

```sh
kubectl apply -k deploy/base
# or
kubectl apply -k deploy/overlays/example
```

### Backup

```sh
excali backup -o backup.tar.gz          # admin token; portable .tar.gz
excali restore backup.tar.gz            # --on-collision skip|overwrite|abort
excali pull --all -o ./export/          # escape hatch: head of every scene as .excalidraw
```

## Layout

```
packages/
  core/     pure TS: types, diff, digest, normalize (zero runtime deps)
  server/   Fastify HTTP API + SQLite + file store
  cli/      excali (+ skills/ — the agent skill it installs)
  web/      Vite + React + @excalidraw/excalidraw
  render/   headless Chromium worker (optional)
docker/     Dockerfile + compose
deploy/     kustomize base + example overlay
docs/       CLI reference, upgrade runbook
```

## Requirements

- **Node 24+** (`node:sqlite`, `node:test`)
- **pnpm 10+** (repo pins `packageManager` in root `package.json`)

```sh
pnpm install
pnpm build
pnpm test
```

Regenerate the CLI reference after changing command parsers:

```sh
pnpm --filter @excalidraw-collab/cli build
pnpm --filter @excalidraw-collab/cli generate-cli-ref
```

## License

[MIT](LICENSE)
