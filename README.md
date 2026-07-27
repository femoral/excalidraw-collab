# excalidraw-collab

Self-hosted [Excalidraw](https://github.com/excalidraw/excalidraw) with server-side
persistence, turn-based collaboration, and a CLI built for AI agents.

Agents drop in explainers, samples and architecture diagrams; humans iterate on top. Each side
takes a turn, and both can ask exactly what the other changed.

**Upstream is never modified** — `@excalidraw/excalidraw` is consumed as a plain npm
dependency, so picking up new releases is a version bump.

See [PLAN.md](./PLAN.md) for the full design.

## Layout

```
packages/
  core/     pure TS: types, diff engine, scene digest, validation
  server/   Fastify HTTP API + SQLite + file store
  cli/      excalicli
  web/      Vite + React + @excalidraw/excalidraw
  render/   headless-Chromium worker (export, skeleton conversion, merge)
docker/     image + compose
```

## Status

Pre-implementation. Work is decomposed into 35 issues grouped into dependency waves —
see [the roadmap](https://github.com/femoral/excalidraw-collab/issues/36).

## Workflow

Branch per unit of work, merge to `main` locally, push. No PR review flow.

```sh
git switch -c wave1/server-sqlite
# ... work ...
git switch main && git merge --no-ff wave1/server-sqlite && git push
```

## Requirements

Node 24+ (uses the built-in `node:sqlite` and `node:test`), pnpm 10+.
