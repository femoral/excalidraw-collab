/**
 * Playwright-backed render worker.
 *
 * Playwright is loaded only via {@link loadPlaywright} (dynamic import) so:
 *   - `RENDER_WORKER=off` never pulls this module in at all (callers use
 *     `openRenderWorker`, which skips `./worker.js`)
 *   - a deployment that skipped optionalDependencies fails with a clean
 *     {@link RenderError} `NOT_INSTALLED` instead of `ERR_MODULE_NOT_FOUND`
 */
import type {
  Browser,
  BrowserContext,
  BrowserServer,
  Page,
} from "playwright";
import { loadPlaywright } from "./playwright-loader.js";
import {
  RENDER_MSG,
  type PageRenderRequest,
  type PageRenderResponse,
} from "./protocol.js";
import {
  RenderError,
  type RenderRequest,
  type RenderResult,
  type RenderWorker,
  type RenderWorkerOptions,
} from "./types.js";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type RenderWorkerHandle = RenderWorker & {
  /** Chromium child pid after launch, else null. */
  getBrowserPid: () => number | null;
  /** SIGKILL the Chromium process (recovery tests). */
  killBrowserProcess: () => void;
};

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new RenderError(
      "INVALID_REQUEST",
      `baseUrl must be an absolute http(s) URL, got ${JSON.stringify(baseUrl)}`,
    );
  }
  return trimmed;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Create a headless Chromium render worker.
 *
 * Browser launch is deferred until the first `render()` call. After
 * `idleTimeoutMs` with no in-flight work the browser is closed and the next
 * render re-launches it.
 */
export function createRenderWorker(
  options: RenderWorkerOptions,
): RenderWorkerHandle {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const idleTimeoutMs =
    options.idleTimeoutMs === undefined
      ? DEFAULT_IDLE_TIMEOUT_MS
      : options.idleTimeoutMs;
  const launchArgs = options.launchArgs ?? [];

  let browser: Browser | null = null;
  let browserServer: BrowserServer | null = null;
  let context: BrowserContext | null = null;
  let launching: Promise<void> | null = null;
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let browserPid: number | null = null;

  const freePages: Page[] = [];
  let pageCount = 0;
  const pageWaiters: Array<(page: Page | null) => void> = [];
  let inFlight = 0;
  const renderUrl = `${baseUrl}/render`;

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdle(): void {
    clearIdleTimer();
    if (idleTimeoutMs <= 0) return;
    if (inFlight > 0 || closed) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight === 0 && !closed) {
        void tearDownBrowser();
      }
    }, idleTimeoutMs);
    if (
      typeof idleTimer === "object" &&
      idleTimer !== null &&
      "unref" in idleTimer
    ) {
      idleTimer.unref();
    }
  }

  async function tearDownBrowser(): Promise<void> {
    clearIdleTimer();
    const pages = freePages.splice(0, freePages.length);
    pageCount = 0;
    while (pageWaiters.length > 0) {
      pageWaiters.shift()?.(null);
    }
    const ctx = context;
    const br = browser;
    const server = browserServer;
    context = null;
    browser = null;
    browserServer = null;
    browserPid = null;
    launching = null;
    for (const p of pages) {
      try {
        await p.close();
      } catch {
        // ignore
      }
    }
    if (ctx) {
      try {
        await ctx.close();
      } catch {
        // ignore
      }
    }
    if (br) {
      try {
        await br.close();
      } catch {
        // ignore
      }
    }
    if (server) {
      try {
        await server.close();
      } catch {
        // ignore
      }
    }
  }

  async function ensureBrowser(): Promise<void> {
    if (closed) {
      throw new RenderError("BROWSER_CLOSED", "render worker is closed");
    }
    if (browser && browser.isConnected()) return;
    if (launching) {
      await launching;
      if (browser && browser.isConnected()) return;
    }
    launching = (async () => {
      // Drop any stale handles from a previous crash.
      const stalePages = freePages.splice(0, freePages.length);
      pageCount = 0;
      for (const p of stalePages) {
        try {
          await p.close();
        } catch {
          // ignore
        }
      }
      if (context) {
        try {
          await context.close();
        } catch {
          // ignore
        }
        context = null;
      }
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }
        browser = null;
      }
      if (browserServer) {
        try {
          await browserServer.close();
        } catch {
          // ignore
        }
        browserServer = null;
        browserPid = null;
      }

      // Dynamic import: optionalDependency may be absent in render-free images.
      const { chromium } = await loadPlaywright();

      // launchServer exposes the OS process so recovery tests can SIGKILL it;
      // plain launch() no longer surfaces process() on the Browser type.
      const server = await chromium.launchServer({
        headless: true,
        args: ["--font-render-hinting=none", ...launchArgs],
      });
      browserServer = server;
      browserPid = server.process().pid ?? null;

      const br = await chromium.connect(server.wsEndpoint());
      br.on("disconnected", () => {
        if (browser === br) {
          browser = null;
          context = null;
          browserServer = null;
          browserPid = null;
          freePages.length = 0;
          pageCount = 0;
          while (pageWaiters.length > 0) {
            pageWaiters.shift()?.(null);
          }
        }
      });
      const ctx = await br.newContext({
        viewport: { width: 1280, height: 720 },
        serviceWorkers: "block",
      });
      browser = br;
      context = ctx;
    })();
    try {
      await launching;
    } finally {
      launching = null;
    }
    if (!browser || !browser.isConnected()) {
      throw new RenderError("BROWSER_CLOSED", "failed to launch Chromium");
    }
  }

  function asRenderError(err: unknown, fallbackCode: RenderError["code"]): RenderError {
    if (err instanceof RenderError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    if (
      /has been closed|Target closed|Browser closed|Connection closed|Protocol error|browserContext\.newPage|browser\.newPage/i.test(
        msg,
      )
    ) {
      return new RenderError("BROWSER_CLOSED", msg, { cause: err });
    }
    return new RenderError(fallbackCode, msg, { cause: err });
  }

  async function createReadyPage(): Promise<Page> {
    try {
      await ensureBrowser();
      if (!context) {
        throw new RenderError("BROWSER_CLOSED", "browser context missing");
      }
      const page = await context.newPage();
      pageCount += 1;

      // Refuse CDN font/asset hosts — self-hosted fonts only.
      try {
        await page.route("**/*", async (route) => {
          const url = route.request().url();
          if (
            /excalidraw\.com|fonts\.gstatic\.com|fonts\.googleapis\.com|cdn\.jsdelivr\.net/i.test(
              url,
            )
          ) {
            await route.abort("blockedbyclient");
            return;
          }
          await route.continue();
        });

        await page.goto(renderUrl, {
          waitUntil: "domcontentloaded",
          timeout: renderTimeoutMs,
        });
        await page.waitForFunction(
          () =>
            (
              globalThis as unknown as {
                __excalidrawCollabRenderReady?: boolean;
              }
            ).__excalidrawCollabRenderReady === true,
          { timeout: renderTimeoutMs },
        );
      } catch (err) {
        pageCount -= 1;
        try {
          await page.close();
        } catch {
          // ignore
        }
        throw asRenderError(
          err,
          "RENDER_FAILED",
        );
      }
      return page;
    } catch (err) {
      throw asRenderError(err, "BROWSER_CLOSED");
    }
  }

  function acquirePage(): Promise<Page> {
    return new Promise((resolve, reject) => {
      const tryGive = (page: Page | null) => {
        if (page) resolve(page);
        else {
          reject(
            new RenderError(
              "BROWSER_CLOSED",
              "browser closed while waiting for a render page",
            ),
          );
        }
      };

      if (freePages.length > 0) {
        tryGive(freePages.pop()!);
        return;
      }
      if (pageCount < concurrency) {
        void createReadyPage().then(tryGive, reject);
        return;
      }
      pageWaiters.push(tryGive);
    });
  }

  function releasePage(page: Page, destroy: boolean): void {
    if (destroy || page.isClosed() || !browser?.isConnected()) {
      pageCount = Math.max(0, pageCount - 1);
      void page.close().catch(() => undefined);
      // Only spawn a replacement while the browser is still healthy and
      // someone is waiting — never after a kill (avoids unhandled rejections).
      if (
        pageWaiters.length > 0 &&
        browser?.isConnected() &&
        pageCount < concurrency
      ) {
        const waiter = pageWaiters.shift()!;
        void createReadyPage().then(
          (p) => waiter(p),
          () => waiter(null),
        );
      } else if (pageWaiters.length > 0) {
        // Browser is dead: fail waiters cleanly instead of leaving them hung.
        while (pageWaiters.length > 0) {
          pageWaiters.shift()!(null);
        }
      }
      return;
    }
    if (pageWaiters.length > 0) {
      pageWaiters.shift()!(page);
      return;
    }
    freePages.push(page);
  }

  async function runOnPage(
    page: Page,
    request: RenderRequest,
  ): Promise<RenderResult> {
    const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload: PageRenderRequest = {
      type: RENDER_MSG.REQUEST,
      id,
      format: request.format,
      scene: {
        elements: request.scene.elements,
        appState: request.scene.appState,
        files: request.scene.files ?? null,
      },
      options: request.options,
    };

    // page.evaluate body runs in the browser; avoid relying on DOM libs in this
      // Node package by treating the page global as a loose bag of fields.
      const resultPromise = page.evaluate(
        async ({ msg, responseType }) => {
          const w = globalThis as unknown as {
            addEventListener: (
              type: string,
              listener: (event: { data: unknown }) => void,
            ) => void;
            removeEventListener: (
              type: string,
              listener: (event: { data: unknown }) => void,
            ) => void;
            postMessage: (message: unknown, targetOrigin: string) => void;
            __excalidrawCollabRenderResults?: PageRenderResponse[];
          };
          const response = await new Promise<PageRenderResponse>(
            (resolve, reject) => {
              const onMessage = (event: { data: unknown }) => {
                const data = event.data as PageRenderResponse | undefined;
                if (!data || data.type !== responseType || data.id !== msg.id) {
                  return;
                }
                w.removeEventListener("message", onMessage);
                resolve(data);
              };
              w.addEventListener("message", onMessage);
              w.postMessage(msg, "*");

              // Fallback poll — covers rare cases where the page's own
              // postMessage self-delivery is flaky under automation.
              const started = Date.now();
              const poll = () => {
                const queue = w.__excalidrawCollabRenderResults;
                if (Array.isArray(queue)) {
                  const idx = queue.findIndex((r) => r.id === msg.id);
                  if (idx >= 0) {
                    const [item] = queue.splice(idx, 1);
                    w.removeEventListener("message", onMessage);
                    resolve(item!);
                    return;
                  }
                }
                if (Date.now() - started > 120_000) {
                  w.removeEventListener("message", onMessage);
                  reject(new Error("render response not received in page"));
                  return;
                }
                setTimeout(poll, 20);
              };
              setTimeout(poll, 20);
            },
          );
          return response;
        },
        { msg: payload, responseType: RENDER_MSG.RESPONSE },
      );

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new RenderError(
            "TIMEOUT",
            `render timed out after ${renderTimeoutMs}ms`,
          ),
        );
      }, renderTimeoutMs);
    });

    let onPageClose: (() => void) | undefined;
    const closedPromise = new Promise<never>((_resolve, reject) => {
      onPageClose = () => {
        reject(
          new RenderError("BROWSER_CLOSED", "browser closed during render"),
        );
      };
      page.once("close", onPageClose);
    });

    try {
      const response = await Promise.race([
        resultPromise,
        timeoutPromise,
        closedPromise,
      ]);
      if (!response.ok) {
        throw new RenderError(
          "RENDER_FAILED",
          response.error || "render failed in page",
        );
      }
      if (request.format === "png") {
        return {
          format: "png",
          mimeType: "image/png",
          bytes: base64ToBytes(response.data),
        };
      }
      return {
        format: "svg",
        mimeType: "image/svg+xml",
        bytes: utf8ToBytes(response.data),
      };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (onPageClose) page.off("close", onPageClose);
      // Losing racers still settle later — swallow so they never surface as
      // unhandledRejection after we've already thrown BROWSER_CLOSED/TIMEOUT.
      void resultPromise.catch(() => undefined);
      void closedPromise.catch(() => undefined);
      void timeoutPromise.catch(() => undefined);
    }
  }

  async function render(request: RenderRequest): Promise<RenderResult> {
    if (closed) {
      throw new RenderError("BROWSER_CLOSED", "render worker is closed");
    }
    if (request.format !== "png" && request.format !== "svg") {
      throw new RenderError(
        "INVALID_REQUEST",
        `format must be "png" or "svg", got ${JSON.stringify(request.format)}`,
      );
    }
    if (!request.scene || !Array.isArray(request.scene.elements)) {
      throw new RenderError(
        "INVALID_REQUEST",
        "scene.elements must be an array",
      );
    }

    clearIdleTimer();
    inFlight += 1;
    let page: Page | null = null;
    let destroyPage = false;
    try {
      page = await acquirePage();
      try {
        return await runOnPage(page, request);
      } catch (err) {
        destroyPage = true;
        throw asRenderError(err, "RENDER_FAILED");
      }
    } finally {
      if (page) {
        releasePage(page, destroyPage || page.isClosed());
      }
      inFlight -= 1;
      if (inFlight === 0) {
        scheduleIdle();
      }
    }
  }

  async function close(): Promise<void> {
    closed = true;
    await tearDownBrowser();
  }

  return {
    render,
    close,
    get isRunning() {
      return browser !== null && browser.isConnected();
    },
    getBrowserPid: () => browserPid,
    killBrowserProcess: () => {
      // Prefer BrowserServer.kill() when available; fall back to SIGKILL.
      const server = browserServer;
      if (server) {
        try {
          server.kill();
          return;
        } catch {
          // fall through to pid kill
        }
      }
      const pid = browserPid;
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    },
  };
}
