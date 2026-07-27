/**
 * Minimal static file server for integration tests.
 * Serves a Vite `dist/` directory (SPA fallback → index.html).
 */
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".ico": "image/x-icon",
};

export type StaticServer = {
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
};

export async function startStaticServer(rootDir: string): Promise<StaticServer> {
  const root = resolve(rootDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith("/")) pathname += "index.html";

        // SPA: /render and other client routes → index.html
        let filePath = normalize(join(root, pathname));
        if (!filePath.startsWith(root + sep) && filePath !== root) {
          res.writeHead(403).end("forbidden");
          return;
        }

        let exists = false;
        try {
          const st = await stat(filePath);
          exists = st.isFile();
        } catch {
          exists = false;
        }

        if (!exists) {
          // Extension-less paths fall back to SPA shell.
          if (!extname(pathname) || pathname === "/render") {
            filePath = join(root, "index.html");
          } else {
            res.writeHead(404).end("not found");
            return;
          }
        }

        const data = await readFile(filePath);
        const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
          "content-type": mime,
          "cache-control": "no-store",
        });
        res.end(data);
      } catch (err) {
        res.writeHead(500).end(err instanceof Error ? err.message : "error");
      }
    })();
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("failed to bind static server");
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: () =>
      new Promise((resolveClose, reject) => {
        server.close((err) => (err ? reject(err) : resolveClose()));
      }),
  };
}
