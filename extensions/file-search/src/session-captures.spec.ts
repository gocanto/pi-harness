import { assert, it } from "@effect/vitest";
import { createSessionCaptureRegistry } from "./session-captures.ts";

it("tracks a capture's directory and removes it on cleanup", async () => {
  const removed: string[] = [];
  const registry = createSessionCaptureRegistry(async (directory) => {
    removed.push(directory);
  });

  registry.track("/tmp/pi-rg-abc123/output.txt");
  assert.equal(registry.size, 1);

  await registry.cleanup();

  assert.deepEqual(removed, ["/tmp/pi-rg-abc123"]);
  assert.equal(registry.size, 0);
});

it("deduplicates multiple captures from the same directory", async () => {
  const removed: string[] = [];
  const registry = createSessionCaptureRegistry(async (directory) => {
    removed.push(directory);
  });

  registry.track("/tmp/pi-fd-same/output.txt");
  registry.track("/tmp/pi-fd-same/output.txt");
  assert.equal(registry.size, 1);

  await registry.cleanup();
  assert.deepEqual(removed, ["/tmp/pi-fd-same"]);
});

it("cleanup is idempotent: a second call removes nothing", async () => {
  const removed: string[] = [];
  const registry = createSessionCaptureRegistry(async (directory) => {
    removed.push(directory);
  });

  registry.track("/tmp/pi-rg-once/output.txt");
  await registry.cleanup();
  await registry.cleanup();

  assert.deepEqual(removed, ["/tmp/pi-rg-once"]);
});

it("only removes directories it was told to track", async () => {
  const removed: string[] = [];
  const registry = createSessionCaptureRegistry(async (directory) => {
    removed.push(directory);
  });

  registry.track("/tmp/pi-rg-tracked/output.txt");
  await registry.cleanup();

  assert.deepEqual(removed, ["/tmp/pi-rg-tracked"]);
  assert.isFalse(removed.includes("/tmp/pi-rg-untracked"));
});

it("cleanup with nothing tracked never calls the remover", async () => {
  let calls = 0;
  const registry = createSessionCaptureRegistry(async () => {
    calls += 1;
  });

  await registry.cleanup();

  assert.equal(calls, 0);
});
