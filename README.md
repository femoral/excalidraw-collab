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
| [docs/cli.md](./docs/cli.md) | Full `excalicli` reference (generated from the CLI parsers) |
| [packages/cli/skills/excalidraw-collab](./packages/cli/skills/excalidraw-collab) | Agent skill — turn loop, conflicts, exit codes (install with `excalicli skills install`) |
| [docs/upgrade-excalidraw.md](./docs/upgrade-excalidraw.md) | Bumping `@excalidraw/excalidraw` |
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

The bootstrap token is already an admin credential. From a host with Node 24+
and a built CLI (`pnpm install && pnpm build` in this repo):

```sh
# After: pnpm install && pnpm build
alias excalicli='node packages/cli/bin/excalicli'   # or put the bin on PATH

excalicli login --server http://localhost:3000 --token "$BOOTSTRAP_TOKEN"
excalicli whoami
excalicli token create agent-bot          # prints a secret once — store it
excalicli new "Architecture" --slug arch
excalicli pull arch
# edit arch.excalidraw  (or open http://localhost:3000 in a browser)
excalicli push arch -m "initial diagram"
excalicli describe arch
excalicli diff arch --since-last-pull
```

### Teach your coding agent the workflow

The CLI ships an agent skill (turn loop, conflict handling, exit codes). Install
it into a skills directory instead of copying instructions by hand:

```sh
excalicli skills install                 # ./.claude/skills/excalidraw-collab/
excalicli skills install --scope user    # ~/.claude/skills/excalidraw-collab/
excalicli skills install --client agents # .agents/skills/… instead of .claude/
excalicli skills ls                      # what's bundled
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
| `excalicli login --server URL --token T` | Writes `~/.config/excalicli/config.json` (or `$XDG_CONFIG_HOME/excalicli/`) mode `0600` |
| `EXCALICLI_SERVER` / `EXCALICLI_TOKEN` | Env overrides the file |
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
excalicli backup -o backup.tar.gz          # admin token; portable .tar.gz
excalicli restore backup.tar.gz            # --on-collision skip|overwrite|abort
excalicli pull --all -o ./export/          # escape hatch: head of every scene as .excalidraw
```

## Layout

```
packages/
  core/     pure TS: types, diff, digest, normalize (zero runtime deps)
  server/   Fastify HTTP API + SQLite + file store
  cli/      excalicli (+ skills/ — the agent skill it installs)
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
