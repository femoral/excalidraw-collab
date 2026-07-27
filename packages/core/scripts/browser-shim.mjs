/**
 * Minimal browser globals required to evaluate @excalidraw/excalidraw under Node.
 * Must be imported (and side-effect) before the package itself.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function emptyEl() {
  return {
    style: {},
    setAttribute() {},
    getAttribute() {
      return null;
    },
    getContext() {
      return null;
    },
    width: 0,
    height: 0,
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      },
    },
    appendChild(c) {
      return c;
    },
    removeChild(c) {
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    children: [],
    childNodes: [],
    parentNode: null,
    tagName: "DIV",
  };
}

const document = {
  createElement(tag) {
    const el = emptyEl();
    el.tagName = String(tag).toUpperCase();
    if (tag === "canvas") {
      el.getContext = () => ({
        measureText: (t) => ({
          width: String(t).length * 10,
          actualBoundingBoxAscent: 10,
          actualBoundingBoxDescent: 2,
          fontBoundingBoxAscent: 12,
          fontBoundingBoxDescent: 3,
        }),
        fillText() {},
        strokeText() {},
        clearRect() {},
        fillRect() {},
        drawImage() {},
        save() {},
        restore() {},
        translate() {},
        scale() {},
        rotate() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
        closePath() {},
        arc() {},
        rect() {},
        clip() {},
        setLineDash() {},
        createLinearGradient: () => ({ addColorStop() {} }),
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        globalAlpha: 1,
        textBaseline: "alphabetic",
      });
      el.toDataURL = () => "data:image/png;base64,";
    }
    return el;
  },
  createElementNS() {
    return emptyEl();
  },
  body: { appendChild() {}, removeChild() {} },
  head: { appendChild() {} },
  documentElement: { style: {} },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener() {},
  removeEventListener() {},
  getElementById() {
    return null;
  },
  cookie: "",
  fonts: {
    add() {},
    load: async () => [],
    ready: Promise.resolve(),
    check: () => true,
  },
};

globalThis.window = globalThis;
globalThis.self = globalThis;
globalThis.document = document;

Object.defineProperty(globalThis, "location", {
  value: {
    origin: "https://fixture.local",
    href: "https://fixture.local/",
    protocol: "https:",
    host: "fixture.local",
    hostname: "fixture.local",
    pathname: "/",
    search: "",
    hash: "",
  },
  configurable: true,
});

try {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "node",
      language: "en",
      languages: ["en"],
      platform: "linux",
    },
    configurable: true,
  });
} catch {
  /* Node may already expose a read-only navigator */
}

globalThis.devicePixelRatio = 1;
globalThis.EXCALIDRAW_EXPORT_SOURCE = "https://excalidraw-collab.fixture";

for (const name of [
  "HTMLElement",
  "HTMLCanvasElement",
  "HTMLImageElement",
  "SVGElement",
  "Element",
  "Node",
]) {
  if (!globalThis[name]) globalThis[name] = class {};
}

globalThis.Image = class Image {
  set src(_v) {
    queueMicrotask(() => this.onload?.());
  }
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
globalThis.IntersectionObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  media: "",
});
globalThis.getComputedStyle = () =>
  new Proxy({}, { get: () => () => "" });
globalThis.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
  clear() {},
  key() {
    return null;
  },
  length: 0,
};
globalThis.sessionStorage = globalThis.localStorage;
globalThis.DOMParser = class {
  parseFromString() {
    return {
      body: { textContent: "" },
      querySelector: () => null,
      documentElement: {},
    };
  }
};
globalThis.CSS = { supports: () => false };

for (const name of [
  "ClipboardEvent",
  "DragEvent",
  "FocusEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "TouchEvent",
  "WheelEvent",
  "File",
]) {
  if (!globalThis[name]) globalThis[name] = class {};
}
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
};
globalThis.Event = class Event {
  constructor(type) {
    this.type = type;
  }
};
globalThis.FileReader = class FileReader {
  readAsDataURL() {
    this.onload?.({ target: { result: "" } });
  }
};
globalThis.Worker = class Worker {
  postMessage() {}
  terminate() {}
  addEventListener() {}
};
globalThis.FontFace = class FontFace {
  load() {
    return Promise.resolve(this);
  }
};

/**
 * Seed Math.random + crypto randomness so fixture generation is deterministic.
 * Call once at the start of the generator.
 */
export function seedRandom(seed = 0xeca11d42) {
  // LCG for Math.random
  let state = seed >>> 0;
  Math.random = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  // Deterministic crypto fill (nanoid uses crypto.randomFillSync / getRandomValues)
  const fill = (buf) => {
    const view =
      buf instanceof Uint8Array
        ? buf
        : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
    for (let i = 0; i < view.length; i++) {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      view[i] = state & 0xff;
    }
    return buf;
  };

  if (globalThis.crypto) {
    try {
      globalThis.crypto.getRandomValues = fill;
    } catch {
      /* ignore */
    }
  }

  try {
    const nodeCrypto = require("node:crypto");
    nodeCrypto.randomFillSync = fill;
    if (typeof nodeCrypto.getRandomValues === "function") {
      nodeCrypto.getRandomValues = fill;
    }
  } catch {
    /* ignore */
  }

  // Stable wall-clock for element.updated timestamps
  const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  Date.now = () => FIXED_NOW;
}
