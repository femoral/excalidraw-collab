import assert from "node:assert/strict";
import { test } from "node:test";
import { packTar, packTarGz, unpackTar, unpackTarGz } from "./tar.js";

test("pack/unpack round-trips file contents and names", () => {
  const entries = [
    { name: "README.md", data: Buffer.from("hello backup\n", "utf8") },
    {
      name: "scenes/arch/meta.json",
      data: Buffer.from('{"slug":"arch"}\n', "utf8"),
    },
    {
      name: "files/abcdef0123456789abcdef0123456789abcdef01",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
    },
  ];
  const tar = packTar(entries);
  const out = unpackTar(tar);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.name, "README.md");
  assert.equal(out[0]!.data.toString("utf8"), "hello backup\n");
  assert.equal(out[1]!.name, "scenes/arch/meta.json");
  assert.deepEqual(
    out[2]!.data,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
  );
});

test("packTarGz is gunzip-compatible and still unpacks", () => {
  const entries = [
    { name: "MANIFEST.json", data: Buffer.from('{"formatVersion":1}\n') },
  ];
  const gz = packTarGz(entries);
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  const out = unpackTarGz(gz);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.name, "MANIFEST.json");
});

test("unpackTarGz accepts plain tar (no gzip magic)", () => {
  const tar = packTar([{ name: "a.txt", data: Buffer.from("x") }]);
  const out = unpackTarGz(tar);
  assert.equal(out[0]!.data.toString("utf8"), "x");
});
