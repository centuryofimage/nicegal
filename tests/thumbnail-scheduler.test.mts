import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import type { EnsureThumbnailsRequest, EnsureThumbnailsResponse } from "../src/shared/backend.ts";

import {
  createThumbnailScheduler,
  orderThumbnailCandidates,
  type ThumbnailFailure,
  type ThumbnailScheduler,
} from "../src/renderer/src/lib/gallery/thumbnail-scheduler.ts";

interface Fixture {
  scheduler: ThumbnailScheduler;
  failures: ThumbnailFailure[];
  readonly calls: number;
  readonly ready: number;
  readonly retries: number;
  miss(): Promise<boolean>;
}

function fixture(
  t: TestContext,
  ensure: (request: EnsureThumbnailsRequest) => Promise<EnsureThumbnailsResponse>,
): Fixture {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  t.mock.method(globalThis, "requestAnimationFrame", (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  t.mock.method(globalThis, "cancelAnimationFrame", (id) => frames.delete(id));
  for (const name of ["info", "warn", "error"] as const) t.mock.method(console, name, () => {});
  const failures: ThumbnailFailure[] = [];
  let calls = 0;
  let ready = 0;
  let retries = 0;
  const scheduler = createThumbnailScheduler({
    concurrency: 1,
    batchSize: 1,
    maxAttempts: 3,
    selectCandidates: (pending) => [...pending.keys()],
    requiredSize: () => 256,
    ensure: (request) => {
      calls++;
      return ensure(request);
    },
    onReady: () => ready++,
    onRetry: () => retries++,
    onFailed: (failure) => failures.push(failure),
  });
  t.after(() => scheduler.dispose());
  scheduler.resume();
  return {
    scheduler,
    failures,
    get calls() {
      return calls;
    },
    get ready() {
      return ready;
    },
    get retries() {
      return retries;
    },
    async miss() {
      const queued = scheduler.enqueue({ assetId: "1", width: 100, height: 100 });
      for (const [id, callback] of frames) {
        frames.delete(id);
        callback(0);
      }
      await Promise.resolve();
      return queued;
    },
  };
}

// Node has no animation frames; individual tests replace and restore these stand-ins.
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

test("generation errors stop after three attempts and only explicit retry grants a new budget", async (t) => {
  const error = new Error("Unreadable source");
  const f = fixture(t, async () => {
    throw error;
  });
  for (let n = 0; n < 3; n++) await f.miss();
  assert.deepEqual(f.failures, [{ assetId: "1", attempts: 3, error }]);
  assert.equal(f.retries, 2);
  assert.equal(await f.miss(), false);
  assert.equal(f.calls, 3);
  f.scheduler.resume();
  assert.equal(await f.miss(), false);
  f.scheduler.retry(["1"]);
  assert.equal(await f.miss(), true);
  assert.equal(f.calls, 4);
});

test("successful generation with an unreadable poster also exhausts its budget", async (t) => {
  const f = fixture(t, async ({ assetIds }) => ({
    assetIds,
    sizeBucket: 256,
    generatorVersion: 2,
    requiredSize: 256,
  }));
  for (let n = 0; n < 4; n++) await f.miss();
  assert.equal(f.calls, 3);
  assert.equal(f.ready, 3);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].attempts, 3);
});

test("a decoded poster clears failures and the attempt budget", async (t) => {
  const f = fixture(t, async () => {
    throw new Error("Missing");
  });
  for (let n = 0; n < 3; n++) await f.miss();
  f.scheduler.loaded("1");
  assert.equal(await f.miss(), true);
  assert.equal(f.calls, 4);
  assert.equal(f.failures.length, 1);
});

test("disposing an in-flight request suppresses late callbacks", async (t) => {
  let reject!: (reason: unknown) => void;
  const f = fixture(
    t,
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await f.miss();
  f.scheduler.dispose();
  reject(new Error("Late failure"));
  await Promise.resolve();
  assert.equal(f.retries, 0);
  assert.equal(f.failures.length, 0);
  assert.equal(await f.miss(), false);
});

test("candidates launch on screen first, then ahead of the scroll, then behind, nearest first", () => {
  const miss = { width: 100, height: 100 };
  const pending = new Map(
    ["above-far", "above", "top", "middle", "below", "below-far"].map((id) => [
      id,
      { assetId: id, ...miss },
    ]),
  );
  const tiles = [
    { itemId: "above-far", y: 0, height: 100 },
    { itemId: "above", y: 300, height: 100 },
    { itemId: "middle", y: 700, height: 100 },
    { itemId: "top", y: 500, height: 100 },
    { itemId: "loaded", y: 600, height: 100 },
    { itemId: "below-far", y: 2000, height: 100 },
    { itemId: "below", y: 1100, height: 100 },
  ];
  const viewport = { top: 500, bottom: 1000 };
  assert.deepEqual(orderThumbnailCandidates(pending, tiles, viewport, 1), [
    "top",
    "middle",
    "below",
    "below-far",
    "above",
    "above-far",
  ]);
  assert.deepEqual(orderThumbnailCandidates(pending, tiles, viewport, -1), [
    "top",
    "middle",
    "above",
    "above-far",
    "below",
    "below-far",
  ]);
});
