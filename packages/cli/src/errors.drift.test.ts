/**
 * Drift tripwire: CLI keeps a runtime copy of server error codes/mapping
 * (zero runtime deps). This test imports the server package and fails if
 * the two ever diverge.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ErrorCode as ServerErrorCode,
  exitCodeForError as serverExitCodeForError,
} from "@excalidraw-collab/server";
import { SERVER_ERROR_CODES, exitCodeForError as cliExitCodeForError } from "./errors.js";

test("SERVER_ERROR_CODES covers exactly server ErrorCode values", () => {
  const serverCodes = Object.values(ServerErrorCode).slice().sort();
  const cliCodes = SERVER_ERROR_CODES.slice().sort();
  assert.deepEqual(
    cliCodes,
    serverCodes,
    `CLI SERVER_ERROR_CODES drifted from server ErrorCode.\n` +
      `  CLI:    ${JSON.stringify(cliCodes)}\n` +
      `  server: ${JSON.stringify(serverCodes)}`,
  );
});

test("exitCodeForError matches server for every ErrorCode", () => {
  for (const code of Object.values(ServerErrorCode)) {
    const cliExit = cliExitCodeForError(code);
    const serverExit = serverExitCodeForError(code);
    assert.equal(
      cliExit,
      serverExit,
      `exitCodeForError mismatch for ${code}: CLI=${cliExit} server=${serverExit}`,
    );
  }
});
