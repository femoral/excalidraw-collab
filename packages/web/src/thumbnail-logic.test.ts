import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachThumbnailForCommit,
  buildThumbnailExportAppState,
  COMMIT_THUMBNAIL_STEPS,
  loadSceneThumbnail,
  loadThumbnailDisplay,
  resolveThumbnailSource,
  shouldGenerateThumbnail,
  thumbnailFileIdForCommit,
  thumbnailFilePath,
  thumbnailRenderPath,
  withThumbnailFileId,
  type ThumbnailLoadDeps,
} from "./thumbnail-logic.ts";

// ---------------------------------------------------------------------------
// Export options
// ---------------------------------------------------------------------------

test("buildThumbnailExportAppState sets export keys only", () => {
  const appState = buildThumbnailExportAppState({
    viewBackgroundColor: "#fff",
    collaborators: new Map(),
  } as Record<string, unknown>);
  assert.equal(appState.exportBackground, true);
  assert.equal(appState.exportWithDarkMode, false);
  assert.equal(appState.exportScale, 0.5);
  assert.equal(appState.viewBackgroundColor, "#fff");
  // Collaborators (and other viewer noise) are left alone — pickAppState is
  // the whitelist on the commit path; export just overlays export keys.
  assert.ok("collaborators" in appState);
});

test("shouldGenerateThumbnail accepts any array including empty", () => {
  assert.equal(shouldGenerateThumbnail([]), true);
  assert.equal(shouldGenerateThumbnail([{ id: "a" }]), true);
  assert.equal(shouldGenerateThumbnail(null), false);
  assert.equal(shouldGenerateThumbnail(undefined), false);
});

// ---------------------------------------------------------------------------
// Commit sequencing
// ---------------------------------------------------------------------------

test("COMMIT_THUMBNAIL_STEPS uploads thumbnail before commit_scene", () => {
  const thumbIdx = COMMIT_THUMBNAIL_STEPS.indexOf("upload_thumbnail");
  const commitIdx = COMMIT_THUMBNAIL_STEPS.indexOf("commit_scene");
  assert.ok(thumbIdx >= 0);
  assert.ok(commitIdx > thumbIdx);
  assert.ok(
    COMMIT_THUMBNAIL_STEPS.indexOf("export_thumbnail") < thumbIdx,
  );
});

test("withThumbnailFileId omits key when missing", () => {
  const base = { parentVersion: 0, message: "x", elements: [] as unknown[] };
  assert.deepEqual(withThumbnailFileId(base, undefined), base);
  assert.deepEqual(withThumbnailFileId(base, null), base);
  assert.deepEqual(withThumbnailFileId(base, ""), base);
  assert.deepEqual(withThumbnailFileId(base, "abc"), {
    ...base,
    thumbnailFileId: "abc",
  });
});

test("thumbnailFileIdForCommit only returns success ids", () => {
  assert.equal(
    thumbnailFileIdForCommit({ ok: true, fileId: "deadbeef".repeat(5) }),
    "deadbeef".repeat(5),
  );
  assert.equal(
    thumbnailFileIdForCommit({ ok: false, reason: "export_failed" }),
    undefined,
  );
});

test("attachThumbnailForCommit: happy path upload before return", async () => {
  const order: string[] = [];
  const result = await attachThumbnailForCommit({
    shouldGenerate: true,
    exportPng: async () => {
      order.push("export");
      return new Uint8Array([1, 2, 3, 4]).buffer;
    },
    uploadPng: async (bytes) => {
      order.push("upload");
      assert.equal(bytes.byteLength, 4);
      return { fileId: "a".repeat(40) };
    },
  });
  assert.deepEqual(order, ["export", "upload"]);
  assert.deepEqual(result, { ok: true, fileId: "a".repeat(40) });
});

test("attachThumbnailForCommit: export failure is soft (no throw)", async () => {
  const result = await attachThumbnailForCommit({
    shouldGenerate: true,
    exportPng: async () => {
      throw new Error("canvas boom");
    },
    uploadPng: async () => {
      assert.fail("upload must not run after export failure");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "export_failed");
    assert.match(result.error ?? "", /canvas boom/);
  }
});

test("attachThumbnailForCommit: upload failure is soft", async () => {
  const result = await attachThumbnailForCommit({
    shouldGenerate: true,
    exportPng: async () => new Uint8Array([9]).buffer,
    uploadPng: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "upload_failed");
  }
});

test("attachThumbnailForCommit: skipped when shouldGenerate is false", async () => {
  let exportCalled = false;
  const result = await attachThumbnailForCommit({
    shouldGenerate: false,
    exportPng: async () => {
      exportCalled = true;
      return new Uint8Array([1]).buffer;
    },
    uploadPng: async () => ({ fileId: "x" }),
  });
  assert.equal(exportCalled, false);
  assert.deepEqual(result, { ok: false, reason: "skipped_empty" });
});

// ---------------------------------------------------------------------------
// Three-way fallback (uploaded → render → placeholder)
// ---------------------------------------------------------------------------

test("resolveThumbnailSource prefers uploaded over render", () => {
  assert.deepEqual(
    resolveThumbnailSource({
      slug: "arch",
      headVersion: 3,
      thumbnailFileId: "c".repeat(40),
    }),
    { kind: "uploaded", fileId: "c".repeat(40) },
  );
});

test("resolveThumbnailSource falls back to render when no upload", () => {
  assert.deepEqual(
    resolveThumbnailSource({
      slug: "arch",
      headVersion: 2,
      thumbnailFileId: null,
    }),
    { kind: "render", slug: "arch", version: 2 },
  );
});

test("resolveThumbnailSource is placeholder when empty scene", () => {
  assert.deepEqual(
    resolveThumbnailSource({
      slug: "arch",
      headVersion: 0,
      thumbnailFileId: null,
    }),
    { kind: "placeholder" },
  );
});

function makeDeps(overrides: Partial<ThumbnailLoadDeps> = {}): ThumbnailLoadDeps {
  return {
    getFileBytes: async () => {
      throw new Error("getFileBytes not stubbed");
    },
    getRenderPng: async () => {
      throw new Error("getRenderPng not stubbed");
    },
    createObjectUrl: (bytes, mimeType) =>
      `blob:${mimeType}:${bytes.byteLength}`,
    ...overrides,
  };
}

test("loadThumbnailDisplay: uploaded path never invokes render worker", async () => {
  let renderCalled = false;
  const display = await loadThumbnailDisplay(
    { kind: "uploaded", fileId: "d".repeat(40) },
    makeDeps({
      getFileBytes: async (id) => {
        assert.equal(id, "d".repeat(40));
        return { bytes: new Uint8Array([0x89, 0x50]).buffer, mimeType: "image/png" };
      },
      getRenderPng: async () => {
        renderCalled = true;
        throw new Error("should not call render");
      },
    }),
  );
  assert.equal(renderCalled, false);
  assert.equal(display.kind, "image");
  if (display.kind === "image") {
    assert.equal(display.source, "uploaded");
    assert.match(display.objectUrl, /^blob:image\/png:/);
  }
});

test("loadThumbnailDisplay: render success yields image", async () => {
  const display = await loadThumbnailDisplay(
    { kind: "render", slug: "arch", version: 1 },
    makeDeps({
      getRenderPng: async (slug, version) => {
        assert.equal(slug, "arch");
        assert.equal(version, 1);
        return { bytes: new Uint8Array([1, 2, 3]).buffer, mimeType: "image/png" };
      },
    }),
  );
  assert.equal(display.kind, "image");
  if (display.kind === "image") {
    assert.equal(display.source, "render");
  }
});

test("loadThumbnailDisplay: worker unavailable (501) degrades to placeholder", async () => {
  const display = await loadThumbnailDisplay(
    { kind: "render", slug: "arch", version: 4 },
    makeDeps({
      getRenderPng: async () => {
        const err = new Error("render worker unavailable") as Error & {
          status: number;
          code: string;
        };
        err.status = 501;
        err.code = "NOT_IMPLEMENTED";
        throw err;
      },
    }),
  );
  assert.deepEqual(display, { kind: "placeholder" });
});

test("loadThumbnailDisplay: placeholder is a no-op (no network)", async () => {
  let files = 0;
  let renders = 0;
  const display = await loadThumbnailDisplay(
    { kind: "placeholder" },
    makeDeps({
      getFileBytes: async () => {
        files += 1;
        return { bytes: new ArrayBuffer(0), mimeType: "image/png" };
      },
      getRenderPng: async () => {
        renders += 1;
        return { bytes: new ArrayBuffer(0), mimeType: "image/png" };
      },
    }),
  );
  assert.equal(files, 0);
  assert.equal(renders, 0);
  assert.deepEqual(display, { kind: "placeholder" });
});

test("loadSceneThumbnail: full chain uploaded → no render", async () => {
  let renderCalled = false;
  const display = await loadSceneThumbnail(
    {
      slug: "board",
      headVersion: 7,
      thumbnailFileId: "e".repeat(40),
    },
    makeDeps({
      getFileBytes: async () => ({
        bytes: new Uint8Array([9]).buffer,
        mimeType: "image/png",
      }),
      getRenderPng: async () => {
        renderCalled = true;
        throw new Error("no");
      },
    }),
  );
  assert.equal(renderCalled, false);
  assert.equal(display.kind, "image");
  if (display.kind === "image") {
    assert.equal(display.source, "uploaded");
  }
});

test("loadSceneThumbnail: no upload + worker fails → placeholder", async () => {
  const display = await loadSceneThumbnail(
    { slug: "agent-scene", headVersion: 2, thumbnailFileId: null },
    makeDeps({
      getRenderPng: async () => {
        throw Object.assign(new Error("501"), { status: 501 });
      },
    }),
  );
  assert.deepEqual(display, { kind: "placeholder" });
});

test("loadSceneThumbnail: uploaded missing falls back to render", async () => {
  let renderCalled = false;
  const display = await loadSceneThumbnail(
    {
      slug: "arch",
      headVersion: 3,
      thumbnailFileId: "f".repeat(40),
    },
    makeDeps({
      getFileBytes: async () => {
        throw new Error("404");
      },
      getRenderPng: async () => {
        renderCalled = true;
        return { bytes: new Uint8Array([1]).buffer, mimeType: "image/png" };
      },
    }),
  );
  assert.equal(renderCalled, true);
  assert.equal(display.kind, "image");
  if (display.kind === "image") {
    assert.equal(display.source, "render");
  }
});

test("path helpers encode slug and version", () => {
  assert.equal(thumbnailFilePath("ab"), "/api/files/ab");
  assert.equal(
    thumbnailRenderPath("my scene", 12),
    "/api/scenes/my%20scene/render.png?v=12",
  );
});
