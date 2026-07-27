/**
 * Hidden headless export / conversion / merge surface at `/render`.
 *
 * Driven by Playwright (packages/render): the page announces READY, then
 * accepts three request kinds and replies with the matching response:
 *   1. PNG/SVG export via public `exportToBlob` / `exportToSvg`
 *   2. Server-side merge via public `restoreElements` + `reconcileElements`
 *   3. Skeleton conversion via public `convertToExcalidrawElements`
 *
 * Never mutates element internals by hand — public `@excalidraw/excalidraw`
 * exports only.
 */
import { useEffect, useState, type ReactElement } from "react";
import {
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles, ExcalidrawElement } from "@excalidraw-collab/core";
import {
  blobToBase64,
  buildExportAppState,
  filterExportElements,
  isExportRequest,
  isMergeRequest,
  isRenderRequest,
  isSkeletonRequest,
  normalizeRenderOptions,
  RENDER_MSG,
  type RenderExportRequestMessage,
  type RenderMergeRequestMessage,
  type RenderRequestMessage,
  type RenderResponseMessage,
  type SkeletonRequestMessage,
  type SkeletonResponseMessage,
} from "./render-logic.ts";

type PageResponse = RenderResponseMessage | SkeletonResponseMessage;

async function handleExportRequest(
  msg: RenderExportRequestMessage,
): Promise<RenderResponseMessage> {
  const options = normalizeRenderOptions(msg.options);
  const elements = filterExportElements(msg.scene.elements) as ExcalidrawElement[];
  const appState = buildExportAppState(
    msg.scene.appState,
    options,
  ) as Parameters<typeof exportToBlob>[0]["appState"];
  const files = (msg.scene.files ?? null) as BinaryFiles | null;

  // Fonts must be ready so text metrics match a real browser session.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }

  if (msg.format === "png") {
    const blob = await exportToBlob({
      elements: elements as Parameters<typeof exportToBlob>[0]["elements"],
      appState,
      files,
      exportPadding: options.padding,
      mimeType: "image/png",
    });
    const data = await blobToBase64(blob);
    return {
      type: RENDER_MSG.RESPONSE,
      id: msg.id,
      ok: true,
      mimeType: "image/png",
      data,
    };
  }

  const svg = await exportToSvg({
    elements: elements as Parameters<typeof exportToSvg>[0]["elements"],
    appState,
    files,
    exportPadding: options.padding,
  });
  return {
    type: RENDER_MSG.RESPONSE,
    id: msg.id,
    ok: true,
    mimeType: "image/svg+xml",
    data: svg.outerHTML,
  };
}

/**
 * Upstream-only merge. restoreElements first (ordering / fractional indices),
 * then reconcileElements(local, remote, appState). No hand-rolled conflict rules.
 */
function handleMergeRequest(
  msg: RenderMergeRequestMessage,
): RenderResponseMessage {
  // restoreElements repairs ordering so reconcileElements can run.
  const localRestored = restoreElements(
    msg.local.elements as Parameters<typeof restoreElements>[0],
    null,
  );
  const remoteRestored = restoreElements(
    msg.remote.elements as Parameters<typeof restoreElements>[0],
    null,
  );

  // AppState is only consulted for "currently editing" local bias. Server-side
  // merges pass {} so pure version / versionNonce rules apply.
  const appState = (msg.appState ?? {}) as unknown as AppState;

  const merged = reconcileElements(
    localRestored,
    remoteRestored as unknown as Parameters<typeof reconcileElements>[1],
    appState,
  );

  // Serialize plain objects (strip brand types) for postMessage.
  const elements = (merged as OrderedExcalidrawElement[]).map((el) => ({
    ...el,
  }));

  return {
    type: RENDER_MSG.RESPONSE,
    id: msg.id,
    ok: true,
    elements,
  };
}

async function handleRenderRequest(
  msg: RenderRequestMessage,
): Promise<RenderResponseMessage> {
  if (isMergeRequest(msg)) {
    return handleMergeRequest(msg);
  }
  if (isExportRequest(msg)) {
    return handleExportRequest(msg);
  }
  return {
    type: RENDER_MSG.RESPONSE,
    id: (msg as { id: string }).id,
    ok: false,
    error: "unknown render request",
  };
}

async function handleSkeletonRequest(
  msg: SkeletonRequestMessage,
): Promise<SkeletonResponseMessage> {
  // Text width / bound-label sizing need real font metrics.
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }

  // Agents supply ids for arrow bindings — keep them unless explicitly asked
  // to regenerate (matches packages/core fixture generation).
  const regenerateIds = msg.regenerateIds === true;
  const converted = convertToExcalidrawElements(
    msg.elements as Parameters<typeof convertToExcalidrawElements>[0],
    { regenerateIds },
  );
  // restoreElements repairs ordering/indices and binding bookkeeping via
  // upstream code only — we never invent element internals ourselves.
  const elements = restoreElements(converted, null, {
    repairBindings: true,
  }) as unknown[];

  return {
    type: RENDER_MSG.SKELETON_RESPONSE,
    id: msg.id,
    ok: true,
    elements,
  };
}

function reply(message: PageResponse): void {
  // Target the opener/parent if present; otherwise broadcast on the window
  // so Playwright's page.evaluate bridges work via window.postMessage.
  window.postMessage(message, "*");
  // Mirror onto a global for Playwright evaluate loops that don't use
  // MessageEvent (belt-and-suspenders with the exposed bridge).
  const queue = (window as Window & {
    __excalidrawCollabRenderResults?: PageResponse[];
  }).__excalidrawCollabRenderResults;
  if (Array.isArray(queue)) {
    queue.push(message);
  }
}

export function RenderPage(): ReactElement {
  const [status, setStatus] = useState<"ready" | "busy" | "error">("ready");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    // Result queue for Playwright polling fallback.
    (
      window as Window & {
        __excalidrawCollabRenderResults?: PageResponse[];
      }
    ).__excalidrawCollabRenderResults = [];

    const onMessage = (event: MessageEvent) => {
      if (isRenderRequest(event.data)) {
        setStatus("busy");
        setLastError(null);
        void (async () => {
          try {
            const result = await handleRenderRequest(event.data);
            reply(result);
            setStatus("ready");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "render failed";
            reply({
              type: RENDER_MSG.RESPONSE,
              id: (event.data as RenderRequestMessage).id,
              ok: false,
              error: message,
            });
            setLastError(message);
            setStatus("error");
          }
        })();
        return;
      }

      if (isSkeletonRequest(event.data)) {
        setStatus("busy");
        setLastError(null);
        void (async () => {
          try {
            const result = await handleSkeletonRequest(event.data);
            reply(result);
            setStatus("ready");
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "skeleton conversion failed";
            reply({
              type: RENDER_MSG.SKELETON_RESPONSE,
              id: (event.data as SkeletonRequestMessage).id,
              ok: false,
              error: message,
              reason: message,
            });
            setLastError(message);
            setStatus("error");
          }
        })();
      }
    };

    window.addEventListener("message", onMessage);

    // Announce readiness after the listener is attached.
    const ready = { type: RENDER_MSG.READY } as const;
    window.postMessage(ready, "*");
    (
      window as Window & { __excalidrawCollabRenderReady?: boolean }
    ).__excalidrawCollabRenderReady = true;

    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return (
    <div
      data-testid="render-page"
      data-status={status}
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: 16,
        color: "#333",
      }}
    >
      <h1 style={{ fontSize: 14, margin: 0 }}>excalidraw-collab render</h1>
      <p style={{ fontSize: 12, margin: "8px 0 0", opacity: 0.7 }}>
        Headless export / skeleton / merge surface — driven via postMessage.
      </p>
      <p style={{ fontSize: 12, margin: "8px 0 0" }} data-testid="render-status">
        status: {status}
        {lastError ? ` · ${lastError}` : ""}
      </p>
    </div>
  );
}
