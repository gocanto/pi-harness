import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

/** Mode bit checks only mean something on POSIX; Windows lacks these bits. */
const isPosix = process.platform !== "win32";

test("safeStringify handles cycles, bigint, depth, and size", () => {
  const value: Record<string, unknown> = {
    bigint: 42n,
    nested: { deeper: { deepest: true } },
    large: "x".repeat(20_000),
  };
  value.self = value;

  const text = safeStringify(value, {
    maxBytes: 2_048,
    maxDepth: 2,
    maxStringBytes: 512,
  });
  assert.ok(Buffer.byteLength(text, "utf8") <= 2_048);
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object");
  assert.match(text, /42n/);
  assert.match(text, /circular/);
  assert.match(text, /truncated/);
});

test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "atomic writes create a private file and a private run directory",
  {
    skip: !isPosix,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
    const originalUmask = process.umask(0o022);
    try {
      const runDir = join(root, "wf_fixture");
      const file = join(runDir, "workflow.json");
      writeFileAtomic(file, "{}");

      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(runDir).mode & 0o777, 0o700);
    } finally {
      process.umask(originalUmask);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "atomic replace hardens a pre-existing world-readable file and directory",
  {
    skip: !isPosix,
  },
  () => {
    const root = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
    try {
      const runDir = join(root, "wf_fixture");
      const file = join(runDir, "workflow.json");
      writeFileAtomic(file, "{}");
      // Simulate artifacts left world-readable by an older version of this code.
      chmodSync(runDir, 0o755);
      chmodSync(file, 0o644);

      writeFileAtomic(file, '{"value":2}');

      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(runDir).mode & 0o777, 0o700);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
