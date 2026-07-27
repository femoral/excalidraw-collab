import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyThemeToDocument,
  oppositeTheme,
  readHintDismissed,
  readSystemPreference,
  readViewerTheme,
  resolveTheme,
  shouldShowThemeMismatchHint,
  THEME_HINT_DISMISSED_KEY,
  THEME_STORAGE_KEY,
  writeHintDismissed,
  writeViewerTheme,
  type ThemeStorage,
} from "./theme-logic.ts";

function memoryStorage(
  initial: Record<string, string> = {},
): ThemeStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key]! : null;
    },
    setItem(key, value) {
      data[key] = value;
    },
    removeItem(key) {
      delete data[key];
    },
  };
}

describe("resolveTheme precedence", () => {
  test("viewer choice wins over instance and system", () => {
    assert.equal(
      resolveTheme({
        viewerChoice: "light",
        instanceDefault: "dark",
        systemPreference: "dark",
      }),
      "light",
    );
    assert.equal(
      resolveTheme({
        viewerChoice: "dark",
        instanceDefault: "light",
        systemPreference: "light",
      }),
      "dark",
    );
  });

  test("instance default wins when viewer has no choice", () => {
    assert.equal(
      resolveTheme({
        viewerChoice: null,
        instanceDefault: "dark",
        systemPreference: "light",
      }),
      "dark",
    );
    assert.equal(
      resolveTheme({
        viewerChoice: null,
        instanceDefault: "light",
        systemPreference: "dark",
      }),
      "light",
    );
  });

  test("system preference is the last fallback", () => {
    assert.equal(
      resolveTheme({
        viewerChoice: null,
        instanceDefault: null,
        systemPreference: "dark",
      }),
      "dark",
    );
    assert.equal(
      resolveTheme({
        viewerChoice: null,
        instanceDefault: null,
        systemPreference: "light",
      }),
      "light",
    );
  });

  test("admin changing instance default does not override explicit local choice", () => {
    // Once the viewer has chosen, a later instance flip is ignored.
    assert.equal(
      resolveTheme({
        viewerChoice: "light",
        instanceDefault: "dark",
        systemPreference: "dark",
      }),
      "light",
    );
  });
});

describe("viewer theme localStorage", () => {
  test("round-trips and clears", () => {
    const s = memoryStorage();
    assert.equal(readViewerTheme(s), null);
    writeViewerTheme(s, "dark");
    assert.equal(s.data[THEME_STORAGE_KEY], "dark");
    assert.equal(readViewerTheme(s), "dark");
    writeViewerTheme(s, null);
    assert.equal(readViewerTheme(s), null);
  });

  test("invalid values are treated as unset", () => {
    const s = memoryStorage({ [THEME_STORAGE_KEY]: "sepia" });
    assert.equal(readViewerTheme(s), null);
  });
});

describe("shouldShowThemeMismatchHint", () => {
  test("shows when instance differs from OS and no local choice", () => {
    assert.equal(
      shouldShowThemeMismatchHint({
        viewerChoice: null,
        instanceDefault: "dark",
        systemPreference: "light",
        hintDismissed: false,
      }),
      true,
    );
  });

  test("never shows once the viewer has a local choice", () => {
    assert.equal(
      shouldShowThemeMismatchHint({
        viewerChoice: "dark",
        instanceDefault: "dark",
        systemPreference: "light",
        hintDismissed: false,
      }),
      false,
    );
  });

  test("never shows when dismissed or instance unset or matching OS", () => {
    assert.equal(
      shouldShowThemeMismatchHint({
        viewerChoice: null,
        instanceDefault: "dark",
        systemPreference: "light",
        hintDismissed: true,
      }),
      false,
    );
    assert.equal(
      shouldShowThemeMismatchHint({
        viewerChoice: null,
        instanceDefault: null,
        systemPreference: "light",
        hintDismissed: false,
      }),
      false,
    );
    assert.equal(
      shouldShowThemeMismatchHint({
        viewerChoice: null,
        instanceDefault: "dark",
        systemPreference: "dark",
        hintDismissed: false,
      }),
      false,
    );
  });
});

describe("hint dismissal storage", () => {
  test("round-trips", () => {
    const s = memoryStorage();
    assert.equal(readHintDismissed(s), false);
    writeHintDismissed(s, true);
    assert.equal(s.data[THEME_HINT_DISMISSED_KEY], "1");
    assert.equal(readHintDismissed(s), true);
    writeHintDismissed(s, false);
    assert.equal(readHintDismissed(s), false);
  });
});

describe("helpers", () => {
  test("oppositeTheme", () => {
    assert.equal(oppositeTheme("light"), "dark");
    assert.equal(oppositeTheme("dark"), "light");
  });

  test("applyThemeToDocument sets data-theme and color-scheme", () => {
    const attrs: Record<string, string> = {};
    const root = {
      setAttribute(name: string, value: string) {
        attrs[name] = value;
      },
      style: { colorScheme: "" },
    };
    applyThemeToDocument("dark", root);
    assert.equal(attrs["data-theme"], "dark");
    assert.equal(root.style.colorScheme, "dark");
    applyThemeToDocument("light", root);
    assert.equal(attrs["data-theme"], "light");
    assert.equal(root.style.colorScheme, "light");
  });

  test("readSystemPreference falls back to light without matchMedia", () => {
    assert.equal(readSystemPreference(undefined), "light");
    assert.equal(
      readSystemPreference(() => ({ matches: true })),
      "dark",
    );
    assert.equal(
      readSystemPreference(() => ({ matches: false })),
      "light",
    );
  });
});
