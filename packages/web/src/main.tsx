import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@excalidraw/excalidraw/index.css";
import "./styles.css";

// Self-host fonts/assets from public/ (copied at build/dev from the package).
// Must be set before Excalidraw mounts or it will fetch from a CDN.
window.EXCALIDRAW_ASSET_PATH = "/";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
