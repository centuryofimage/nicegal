import assert from "node:assert/strict";
import { after, test, type TestContext, type Mock } from "node:test";
import { createServer } from "vite";

import type { NicegalBridge } from "../src/shared/backend.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-remote-bridge-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { createRemoteBridge } = await vite.ssrLoadModule("/src/renderer/src/lib/remote-bridge.ts");
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(t: TestContext): {
  bridge: NicegalBridge;
  stream: { open(): void; drop(): void; onmessage(event: { data: string }): void };
  states: boolean[];
  statuses: unknown[];
  pending: Array<{
    url: string;
    args: unknown[];
    resolve(response: Response): void;
    reject(error: Error): void;
  }>;
  answer(index: number, value: unknown): void;
  log: Mock<typeof console.error>;
} {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const streams: FakeEvents[] = [];
  class FakeEvents {
    static CLOSED = 2;
    static OPEN = 1;
    readyState = 0;
    onopen = (): void => {};
    onerror = (): void => {};
    onmessage: (event: { data: string }) => void = () => {};
    constructor() {
      streams.push(this);
    }
    close(): void {
      this.readyState = 2;
    }
    open(): void {
      this.readyState = 1;
      this.onopen();
    }
    drop(): void {
      this.readyState = 0;
      this.onerror();
    }
  }
  const pending: Array<{
    url: string;
    args: unknown[];
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  for (const [key, value] of Object.entries({
    EventSource: FakeEvents,
    document: {
      addEventListener() {
        /* No visibility changes in these tests. */
      },
    },
  })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.mock.method(
    globalThis,
    "fetch",
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ url, args: JSON.parse(String(init.body)), resolve, reject });
      }),
  );
  const log = t.mock.method(console, "error", () => {});
  const bridge = createRemoteBridge();
  const states: boolean[] = [];
  const statuses: unknown[] = [];
  bridge.connection.onReconnectingChanged((state: boolean) => states.push(state));
  bridge.backend.onBackendStatusChanged((status: unknown) => statuses.push(status));
  const answer = (index: number, value: unknown): void =>
    pending[index].resolve(Response.json({ value }));
  return { bridge, stream: streams[0], states, statuses, pending, answer, log };
}

test("first successful connection clears initial failure and cancels the grace timer", async (t) => {
  const f = fixture(t);
  f.stream.drop();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.states, [false, true]);
  f.stream.open();
  assert.deepEqual(f.states, [false, true, false]);
  f.answer(0, { ready: true });
  await flush();
  f.stream.drop();
  f.stream.open();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.states, [false, true, false]);
  f.answer(1, { ready: true });
  await flush();
});

test("old recovery reads cannot overwrite a new connection or pushed status", async (t) => {
  const f = fixture(t);
  f.stream.open();
  f.stream.drop();
  t.mock.timers.tick(1000);
  f.answer(0, { ready: false, error: "old" });
  await flush();
  assert.deepEqual(f.statuses, []);
  assert.equal(f.states.at(-1), true);
  f.stream.open();
  f.stream.onmessage({
    data: JSON.stringify({ channel: "backend:status-changed", args: [{ ready: true }] }),
  });
  f.answer(1, { ready: false });
  await flush();
  assert.deepEqual(f.statuses, [{ ready: true }]);
});

test("status recovery retries on an open stream and stops retrying after a drop", async (t) => {
  const f = fixture(t);
  f.stream.open();
  f.pending[0].reject(new Error("network down"));
  await flush();
  t.mock.timers.tick(3000);
  assert.equal(f.pending.length, 2);
  f.answer(1, { ready: true });
  await flush();
  assert.deepEqual(f.statuses, [{ ready: true }]);
  f.stream.open();
  f.pending[2].reject(new Error("network down"));
  await flush();
  f.stream.drop();
  t.mock.timers.tick(3000);
  assert.equal(f.pending.length, 3);
});

test("call logs failures once, rethrows them, and transmits cancellation tokens", async (t) => {
  const f = fixture(t);
  const cancelled = f.bridge.backend.cancelSearch(12);
  assert.equal(f.pending[0].args[0], 12);
  f.answer(0, null);
  await cancelled;
  const request = f.bridge.backend.getCatalogRevision();
  f.pending[1].resolve(Response.json({ error: { name: "Error", message: "backend failed" } }));
  await assert.rejects(request, /backend failed/);
  assert.equal(f.log.mock.callCount(), 1);
  assert.match(String(f.log.mock.calls[0].arguments[0]), /IPC .* failed/);
});

test("replacement subscriptions ignore old events and recover after reconnect", async (t) => {
  const f = fixture(t);
  const oldEvents: unknown[] = [];
  const currentEvents: unknown[] = [];
  const stopOld = f.bridge.backend.subscribeJob("job", (value) => oldEvents.push(value));
  await flush();
  const oldToken = f.pending[0].args[1];
  stopOld();
  const stopCurrent = f.bridge.backend.subscribeJob("job", (value) => currentEvents.push(value));
  await flush();
  const currentToken = f.pending[1].args[1];
  assert.notEqual(currentToken, oldToken);
  f.answer(1, null);
  f.answer(0, null);
  await flush();
  assert.deepEqual(
    f.pending[2].args,
    ["job", oldToken],
    "late teardown targets only its subscription",
  );
  f.answer(2, null);
  const emit = (token: unknown): void =>
    f.stream.onmessage({
      data: JSON.stringify({
        channel: "backend:job-snapshot",
        args: [
          { jobId: "job", subscriptionId: token, snapshot: { jobId: "job", status: "running" } },
        ],
      }),
    });
  emit(oldToken);
  emit(currentToken);
  assert.equal(oldEvents.length, 0);
  assert.equal(currentEvents.length, 1);
  f.stream.drop();
  f.stream.open();
  f.answer(3, { ready: true });
  await flush();
  assert.equal(f.pending.length, 5);
  assert.deepEqual(f.pending[4].args, ["job", currentToken]);
  f.answer(4, null);
  await flush();
  stopCurrent();
  await flush();
  f.answer(5, null);
});
