/**
 * Minimal ustar tar + gzip pack/unpack using only Node built-ins.
 *
 * Enough for our backup archives (regular files only, paths < 100 bytes in
 * the classic name field or via the prefix/name split, files under 8 GiB).
 * No third-party tar dependency.
 */
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";

export type TarEntry = {
  /** Archive-relative path using forward slashes (no leading slash). */
  name: string;
  /** File contents. */
  data: Buffer;
  /** Unix mode; default 0o644. */
  mode?: number;
  /** mtime as unix seconds; default now. */
  mtime?: number;
};

function encodeOctal(value: number, length: number): Buffer {
  // POSIX tar: octal digits, null-terminated, space-padded on the left.
  const digits = Math.max(0, Math.trunc(value)).toString(8);
  const body = digits.slice(-(length - 1));
  const padded = body.padStart(length - 1, "0");
  const buf = Buffer.alloc(length, 0);
  buf.write(padded, 0, "ascii");
  return buf;
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    // Checksum field (148–155) is treated as spaces during calculation.
    if (i >= 148 && i < 156) {
      sum += 0x20;
    } else {
      sum += header[i]!;
    }
  }
  return sum;
}

/**
 * Split a path into ustar name (≤100) and prefix (≤155).
 * Throws when the path cannot fit.
 */
function splitPath(name: string): { name: string; prefix: string } {
  const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) {
    throw new Error("tar entry name must not be empty");
  }
  if (normalized.length <= 100) {
    return { name: normalized, prefix: "" };
  }
  // Prefer splitting on a path separator so prefix is a directory.
  for (let i = normalized.length - 100; i < normalized.length; i++) {
    if (normalized[i] === "/") {
      const prefix = normalized.slice(0, i);
      const base = normalized.slice(i + 1);
      if (prefix.length <= 155 && base.length <= 100 && base.length > 0) {
        return { name: base, prefix };
      }
    }
  }
  throw new Error(
    `tar path too long for ustar name+prefix fields: ${normalized}`,
  );
}

function writeHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitPath(entry.name);
  const mode = entry.mode ?? 0o644;
  const mtime = entry.mtime ?? Math.floor(Date.now() / 1000);
  const size = entry.data.byteLength;

  header.write(name, 0, 100, "utf8");
  encodeOctal(mode, 8).copy(header, 100);
  encodeOctal(0, 8).copy(header, 108); // uid
  encodeOctal(0, 8).copy(header, 116); // gid
  encodeOctal(size, 12).copy(header, 124);
  encodeOctal(mtime, 12).copy(header, 136);
  // checksum placeholder: 8 spaces
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  // linkname empty
  header.write(USTAR_MAGIC, 257, 6, "ascii");
  header.write(USTAR_VERSION, 263, 2, "ascii");
  // uname / gname empty
  // devmajor / devminor empty
  if (prefix.length > 0) {
    header.write(prefix, 345, 155, "utf8");
  }

  const sum = checksum(header);
  // Checksum field: 6 octal digits, null, space (common convention).
  const sumStr = sum.toString(8).padStart(6, "0");
  header.write(sumStr, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function padToBlock(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/** Pack entries into an uncompressed ustar archive. */
export function packTar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data);
    parts.push(writeHeader({ ...entry, data }));
    parts.push(data);
    const pad = padToBlock(data.byteLength);
    if (pad > 0) {
      parts.push(Buffer.alloc(pad, 0));
    }
  }
  // Two zero blocks end the archive.
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** Pack entries and gzip-compress the result. */
export function packTarGz(entries: readonly TarEntry[]): Buffer {
  return gzipSync(packTar(entries), { level: 6 });
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const raw = buf.toString("ascii", start, start + length).replace(/\0/g, "").trim();
  if (raw.length === 0) return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

function readCString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const nul = slice.indexOf(0);
  const end = nul >= 0 ? nul : slice.length;
  return slice.toString("utf8", 0, end).replace(/\0/g, "").trimEnd();
}

/**
 * Unpack an uncompressed ustar archive into entries.
 * Skips directories, hard links, and other non-regular types.
 */
export function unpackTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK);
    offset += BLOCK;

    // End of archive: two zero blocks (we stop on the first all-zero).
    if (header.every((b) => b === 0)) {
      break;
    }

    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
    const mode = readOctal(header, 100, 8);
    const mtime = readOctal(header, 136, 12);

    const fullName =
      prefix.length > 0 ? `${prefix}/${name}` : name;

    if (offset + size > archive.byteLength) {
      throw new Error(`tar entry truncated: ${fullName}`);
    }

    const data = Buffer.from(archive.subarray(offset, offset + size));
    offset += size;
    offset += padToBlock(size);

    // Regular file: '0' or '\0'. Skip directories ('5') and others.
    if (typeflag === "0" || typeflag === "\0") {
      if (fullName.length > 0) {
        entries.push({ name: fullName, data, mode, mtime });
      }
    }
  }

  return entries;
}

/**
 * Unpack a `.tar.gz` (or raw `.tar` if the payload is not gzip-wrapped).
 */
export function unpackTarGz(input: Buffer): TarEntry[] {
  // Gzip magic 1f 8b — otherwise treat as plain tar (handy for tests).
  if (input.byteLength >= 2 && input[0] === 0x1f && input[1] === 0x8b) {
    return unpackTar(gunzipSync(input));
  }
  return unpackTar(input);
}
