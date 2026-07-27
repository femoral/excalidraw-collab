import assert from "node:assert/strict";
import { test } from "node:test";
import { matchRoute } from "./routing.ts";

test("matchRoute: home", () => {
  assert.deepEqual(matchRoute("/"), { name: "home" });
  assert.deepEqual(matchRoute(""), { name: "home" });
});

test("matchRoute: scene", () => {
  assert.deepEqual(matchRoute("/s/arch"), { name: "scene", slug: "arch" });
  assert.deepEqual(matchRoute("/s/arch/"), { name: "scene", slug: "arch" });
});

test("matchRoute: history", () => {
  assert.deepEqual(matchRoute("/s/arch/history"), {
    name: "history",
    slug: "arch",
  });
});

test("matchRoute: notFound", () => {
  assert.deepEqual(matchRoute("/nope"), { name: "notFound", path: "/nope" });
  assert.deepEqual(matchRoute("/s/"), { name: "notFound", path: "/s/" });
  assert.deepEqual(matchRoute("/s/arch/extra"), {
    name: "notFound",
    path: "/s/arch/extra",
  });
});
