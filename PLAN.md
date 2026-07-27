# excalidraw-collab — plan

Self-hosted Excalidraw with server-side persistence, turn-based collaboration, and a CLI
built for AI agents. **Zero modifications to upstream Excalidraw** — we consume the published
`@excalidraw/excalidraw` npm package (currently `0.18.1`) as a normal dependency.

## 1. Goals & non-goals

**Goals**

- Self-host an Excalidraw editor; scenes persist server-side, survive browser/localStorage.
- Version history per scene: every save is a version, nothing is lost, any version is retrievable.
- A CLI wrapping the HTTP API so agents can `pull`, `push`, and — critically — **`diff`**:
  each side can see exactly what the other side changed during its turn.
- Export to PNG/SVG/`.excalidraw` from both the UI and the CLI.
- Upstream upgrades stay trivial: bump one version number.

**Non-goals (for now)**

- Real-time multiplayer (cursors, live element streaming). The data model is designed so
  this can be added later without migration — see §9.
- End-to-end encryption. Self-hosted, trusted server; E2EE would block server-side
  diffing and rendering, which are the whole point.
- Public sharing / anonymous links.

## 2. What "don't touch upstream" means concretely

We depend on the package and touch exactly four contact points:

| Contact point | What we use | Upgrade risk |
|---|---|---|
| `<Excalidraw />` component | `initialData`, `onChange`, `excalidrawAPI`, `<MainMenu>` children | Low — stable public props |
| Exported utils | `restoreElements`, `reconcileElements`, `getSceneVersion`, `serializeAsJSON`, `exportToSvg`/`exportToBlob`, `convertToExcalidrawElements`, `CaptureUpdateAction` | Low — all public exports |
| `.excalidraw` JSON schema | Stored verbatim; we never rewrite element internals | Low — schema is versioned and back-compatible; the editor's `restore()` repairs old scenes on load |
| Fonts/assets | `window.EXCALIDRAW_ASSET_PATH = "/"` + fonts copied from the package's `dist/prod/fonts` at build time | Low — documented self-hosting path |

Guardrail: `packages/core` keeps a fixture suite of real `.excalidraw` files that round-trip
through our diff/normalize code. Upgrading the package = bump + run fixtures.

Non-negotiable rule: **the server never authors or mutates element internals by hand.**
It stores blobs and, when merging, delegates to upstream's own `reconcileElements`.

## 3. Architecture

```
                    ┌──────────────┐
   human ──────────▶│  web (Vite)  │──┐
                    │  <Excalidraw>│  │  HTTP + Bearer token
                    └──────────────┘  │
                                      ▼
   agent ──▶ excalicli ──────────▶ ┌─────────────────┐    ┌──────────────┐
                                   │ server (Fastify)│───▶│ SQLite + FS  │
                                   └─────────────────┘    │  data/       │
                                            │             └──────────────┘
                                            ▼ (optional)
                                   ┌─────────────────┐
                                   │ render worker   │ headless Chromium,
                                   │ (Playwright)    │ loads our own /render route
                                   └─────────────────┘
```

### Monorepo layout (pnpm workspaces)

```
pnpm-workspace.yaml
packages/
  core/     # pure TS, no DOM, no I/O: types, diff engine, scene digest, validation
  server/   # Fastify HTTP API + SQLite + file store
  cli/      # `excalicli` — thin API client, node:util parseArgs
  web/      # Vite + React 19 + @excalidraw/excalidraw
  render/   # optional Playwright worker (PNG/SVG, skeleton conversion)
docker/     # Dockerfile + compose
```

### Dependency budget

Everything below is either built into Node 24 or top-tier adoption. No exotic packages.

- **core**: none (pure TS). Tests: `node:test`.
- **server**: `fastify` (routing + built-in JSON-schema validation, so no separate validator),
  `node:sqlite` (built into Node 22.5+/24 — no native build step), `node:zlib`, `node:crypto`.
  *Escape hatch*: `node:sqlite` is still flagged experimental, so all SQL lives behind
  `server/src/db.ts`; swapping to `better-sqlite3` is a one-file change.
- **cli**: zero runtime deps — `node:util` `parseArgs`, `fetch`, `node:fs`.
- **web**: `react`, `react-dom`, `@excalidraw/excalidraw`, `vite`. Routing is a ~30-line
  hash/path switch; not worth a router dependency for 3 routes.
- **render** (optional): `playwright`.
- Build: `tsc` for core/server/cli, `vite` for web. Format: `prettier`.

## 4. Data model

A scene is a document with a **linear version history** — a tiny git with no branches.

```sql
scenes(id, slug UNIQUE, name, head_version, created_at, updated_at,
       lock_holder, lock_expires_at)

versions(scene_id, version INTEGER,      -- 1,2,3… monotonic per scene
         parent_version, author, message, created_at,
         elements BLOB,                  -- gzipped JSON array
         app_state BLOB,                 -- gzipped JSON, whitelisted keys only
         file_ids JSON,                  -- ["abc…"] referenced binary files
         element_count, scene_hash,      -- hashElementsVersion, for cheap change checks
         PRIMARY KEY (scene_id, version))

drafts(scene_id PRIMARY KEY, elements, app_state, file_ids, updated_at, updated_by)
       -- the editor's autosaved working copy; overwritten, never versioned

tokens(id, name, token_hash, created_at, last_used_at)
```

Binary files (pasted images) are **content-addressed on disk** at `data/files/<fileId>` —
Excalidraw's `fileId` is already a content hash. A version stores only the id list, so a
20-version history of a scene with a 3 MB screenshot costs 3 MB, not 60 MB.

`appState` is stored with a **whitelist** (`viewBackgroundColor`, `gridSize`, `gridModeEnabled`,
`exportBackground`, `exportWithDarkMode`, `frameRendering`, …). Never persist `collaborators`,
`selectedElementIds`, scroll/zoom, or open dialogs — that's per-viewer noise that would
otherwise pollute every diff.

**Element ordering**: array order is authoritative. Excalidraw's fractional `index` field is
optional — the editor's `restore()` calls `syncInvalidIndices` and repairs it on load. Agents
can therefore emit elements without ever thinking about fractional indices. (Server-side merge
must run `restoreElements` before `reconcileElements`, which does require valid ordering.)

## 5. Turn-based collaboration

Optimistic concurrency, with an advisory lock for politeness.

1. Every push declares `parentVersion`. If it equals `head`, the push becomes `head+1`.
2. If not, the server replies **`409 Conflict`** with the diff between `parentVersion` and
   `head` in the body — so an agent that gets rejected immediately knows what it missed,
   in one round trip.
3. Resolution: `--force` (my version wins) or `--merge` (server runs upstream
   `reconcileElements(local, remote, appState)` in the render worker — version-number-based,
   the exact algorithm upstream uses for its own collab).
4. **Advisory turn lock** (`POST /scenes/:slug/lock`, TTL ~30 min, auto-released on push):
   purely informational. The editor shows "🤖 agent holds the turn"; the CLI warns. It never
   hard-blocks — a stale lock must never wedge a self-hosted tool.

The human's editor autosaves to `drafts` continuously (debounced ~2 s) so nothing is ever
lost, but a **draft is not a turn**. A turn ends on an explicit "Commit turn" with a message.
That keeps the history readable: `v7 agent: initial architecture` → `v8 human: reworked the
data path` → `v9 agent: added retry queue`, instead of 400 keystroke-level versions.

## 6. The diff engine (`packages/core`) — the heart of it

Element identity is `id`. Diff of two element arrays:

```ts
type ElementChange =
  | { op: "add";    id, type, label, bbox, describe }
  | { op: "delete"; id, type, label,       describe }
  | { op: "update"; id, type, label, props: {key, from, to}[], describe }
  | { op: "reorder";id, type, label, from: number, to: number };

type SceneDiff = {
  from: number; to: number;
  summary: { added; deleted; updated; reordered };
  elements: ElementChange[];
  appState: { key, from, to }[];
};
```

Details that make it actually useful:

- **Ignored props**: `version`, `versionNonce`, `updated`, `seed`. These churn on every
  interaction and would make every diff 100% noise.
- **Deletion** = element missing OR `isDeleted` flipped to true (Excalidraw tombstones).
- **Label resolution**: for a container, the `text` of its bound text element; for text
  elements, their own `text`. This is what turns `id: "8fJ2k"` into `"Auth Service"`.
- **Change classification** groups raw prop deltas into readable verbs: `moved`, `resized`,
  `restyled`, `text edited`, `rebound`, `grouped`, `locked`.
- **Arrows are rendered as edges**: `startBinding.elementId` / `endBinding.elementId` resolved
  to labels, so a diff line reads `~ arrow: "API" → "Cache"  (was "API" → "DB")`.

Text output for an agent's context window:

```
scene "arch"  v7 → v9   +4 -1 ~3
+ rectangle "Retry Queue"        (640,220 180x80)
+ arrow     "Worker" → "Retry Queue"
~ rectangle "Auth Service"       moved (320,120) → (320,200); restyled fill #e9ecef
~ arrow     "API" → "Cache"      rebound: was "API" → "DB"
- ellipse   "Legacy cache"
```

### Scene digest — `excalicli describe`

Separate from diffing, and just as important: agents can't see a canvas. `describe` flattens
a scene into an outline (frames → children, containment, groups, arrows as an edge list),
which is what lets an agent reason about a drawing a human just edited, cheaply, without an
image. When the render worker is available, `--png` gives a vision-capable agent the actual
picture too. Both paths matter; the text one always works.

## 7. HTTP API

```
GET    /api/scenes                          list (name, slug, head, updated_at, lock)
POST   /api/scenes                          create {name, slug?}
GET    /api/scenes/:slug                    metadata + head version
DELETE /api/scenes/:slug                    soft delete

GET    /api/scenes/:slug/scene[?v=N]        full .excalidraw JSON (default head)
POST   /api/scenes/:slug/scene              push  {parentVersion, elements, appState?,
                                                   files?, author, message} → 201 | 409+diff
GET    /api/scenes/:slug/versions           history
GET    /api/scenes/:slug/diff?from=&to=     structured diff (from/to accept N, "head", "head~2")

PUT    /api/scenes/:slug/draft              editor autosave
GET    /api/scenes/:slug/draft

POST   /api/scenes/:slug/lock               claim turn {holder, ttl}
DELETE /api/scenes/:slug/lock               release

GET    /api/scenes/:slug/render.{png,svg}   rendered, cached per version   [render worker]
GET    /api/scenes/:slug/events?since=N     long-poll (30 s) → head changes [for `watch`]

POST   /api/files                           upload image → {fileId}
GET    /api/files/:fileId

POST   /api/tokens                          mint named token (admin) → shown once, never again
GET    /api/tokens                          list (name, created, last used — never the secret)
DELETE /api/tokens/:id                      revoke
```

Auth: `Authorization: Bearer <token>`, with **named tokens** — one per human or agent. The
`author` recorded on every version is derived from the token, not from a `--as` flag, so
history attribution is trustworthy and one agent can be revoked without rotating everyone
else's. Tokens are stored as SHA-256 hashes; a bootstrap admin token is read from env on
first run. The web app keeps its token in `localStorage` behind a one-field login screen.
Same token type for humans and agents — no reason to build two auth systems for a
single-tenant tool.

## 8. CLI (`excalicli`)

Design rules: **every command accepts `--json`** (agents parse, humans read), **exit codes are
meaningful** (`0` ok, `1` error, `4` conflict, `5` lock held), and state lives in
`.excalidraw-collab/state.json` in the working dir (last pulled version per scene) so
`diff --since-last-pull` works with no arguments — the single most-used agent command.

```
excalicli login --server URL --token T
excalicli ls
excalicli new "Architecture" [--slug arch]
excalicli pull  arch [-o arch.excalidraw] [--png out.png] [--version N]
excalicli push  arch [-f arch.excalidraw] -m "added retry queue" [--force|--merge]
excalicli diff  arch [--from head~1] [--to head] [--since-last-pull] [--json]
excalicli describe arch [--json]        # text outline of the scene
excalicli log   arch
excalicli export arch --format png|svg|json [--scale 2] [-o file]
excalicli turn  claim|release arch
excalicli watch arch                    # long-poll; prints diff on each new version
excalicli token create|ls|revoke NAME   # admin token required
```

Ships with an `AGENTS.md` snippet documenting the loop, so Claude Code picks up the workflow
without prompting:

```
pull → describe/diff --since-last-pull → edit → push -m "..."   (409 → diff → merge → retry)
```

## 9. Rendering & programmatic authoring (`packages/render`)

Both PNG/SVG export and Excalidraw's ergonomic `convertToExcalidrawElements` skeleton API
need a DOM: text width is measured with a real canvas, and v0.18 subsets fonts in the browser.
jsdom shims here are fragile (silently wrong text metrics). So: **one headless Chromium page
loading a hidden `/render` route of our own web app**, driven by Playwright, doing three jobs:

1. `exportToBlob` / `exportToSvg` → `render.png` / `render.svg`, cached per version.
2. `convertToExcalidrawElements` → lets agents push *skeletons*:
   `{ type: "rectangle", x, y, width, height, label: { text: "API" } }` and
   `{ type: "arrow", start: { id: "a" }, end: { id: "b" } }`, with bindings and bound-text
   resolved by upstream's own code. This is a large ergonomic win — ~5 fields instead of ~30,
   and correct bindings for free.
3. `restoreElements` + `reconcileElements` for server-side `--merge`.

It is **in scope (Phase 4)** but stays runtime-optional: with `RENDER_WORKER=off` the server
still runs, `render.*` returns `501`, and `push --skeleton` is rejected with a clear message —
handy for local dev or a low-memory host. The web app also uploads a thumbnail on commit, so
the scene list has previews either way.

Cost to carry: ~400 MB of Chromium in the image, plus one browser process. It's launched
lazily on first render and idles out after ~10 min, so a scene-list page load doesn't pay for
a browser nobody asked for.

## 10. Web app

Vite + React 19. Three routes: `/` (scene list w/ thumbnails), `/s/:slug` (editor),
`/s/:slug/history` (version list + diff view + restore).

Editor specifics:

- `initialData` ← `GET /scene` (or the draft, if newer than head).
- `onChange` debounced 2 s → `PUT /draft`.
- `<MainMenu>` gets custom items: **Commit turn** (message prompt), **Version history**,
  **Claim/release turn**, alongside `MainMenu.DefaultItems.Export` etc.
- Poll `GET /events` → toast "agent pushed v12" with **Load** / **Merge into mine**.
  Remote loads use `excalidrawAPI.updateScene(..., { captureUpdate: CaptureUpdateAction.NEVER })`
  so a remote change doesn't land in the human's undo stack.
- "What changed" panel: renders the last diff; clicking an entry calls `scrollToContent(el)`
  to fly to it. This is how a human reviews an agent's turn.
- Fonts self-hosted (`window.EXCALIDRAW_ASSET_PATH = "/"`), so the deployment works fully
  offline / air-gapped.

## 11. Build order

Each phase is independently useful — the tool is usable end-to-end from Phase 2 onward.

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | pnpm workspace, TS config, `core` types + fixtures | `pnpm build` green |
| **1** | server: SQLite, scenes/versions/files, named-token auth, push/pull; `excalicli` login/token/ls/new/pull/push/log | agent can round-trip a scene over HTTP |
| **2** | web app: editor, draft autosave, commit turn, scene list | human draws in browser, agent pulls it |
| **3** | diff engine + `describe` + 409-with-diff + `diff --since-last-pull` + history/diff UI | both sides can see the other's turn |
| **4** | render worker: PNG/SVG export, thumbnails, `--merge`, `push --skeleton` | agent can *look* at the drawing |
| **5** | packaging: Dockerfile (Playwright base image) + compose, backup/restore command, `watch`, turn locks | one `docker compose up` on the target host |

## 12. Decisions

- **Deployment: Docker Compose.** One image on Playwright's Chromium base, one service, data
  on a bind-mounted volume (`./data:/app/data`) so backups are `cp -r` and moving hosts is a
  `scp`. Keeps browser system libraries off the host entirely.
- **Auth: named tokens.** One per human or agent; `author` derives from the token. See §7.
- **Render worker: in scope, Phase 4**, runtime-optional via `RENDER_WORKER=off`. See §9.

Still open (low stakes, decide when we get there):

- **Frames as turn boundaries** — scoping a turn to a named frame (agent owns one, human
  another) would allow genuinely parallel work, but adds a second locking dimension.
  Recommend whole-scene turns first; frames only if turn-taking actually chafes.

## 13. Later, if wanted

- **Real-time**: the schema doesn't block it. Add a WebSocket channel broadcasting element
  deltas, keep `reconcileElements` as the merge function, and versions become checkpoints
  rather than the only sync unit. No data migration needed.
- Scene templates / component library (`.excalidrawlib` via `updateLibrary`).
- Comments anchored to element ids — a natural fit for human→agent review notes.
- Full-text search across scenes using `getTextFromElements` + SQLite FTS5.
