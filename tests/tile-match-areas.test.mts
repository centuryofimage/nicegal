import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { TileMatchAreas as Controller } from "../src/renderer/src/lib/patch-features/tile-match-areas.svelte.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-tile-match-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { TileMatchAreas } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/patch-features/tile-match-areas.svelte.ts",
)) as { TileMatchAreas: typeof Controller };

test("tile mapping completes a final partial request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<Array<{ assetId: number; timestampMs?: number }>> = [];
  globalThis.fetch = async (_input, init) => {
    const targets = (JSON.parse(String(init?.body)) as { targets: (typeof calls)[number] }).targets;
    calls.push(targets);
    return new Response(
      JSON.stringify({
        model: "test",
        results: targets.map((target) => ({
          ...target,
          rows: 1,
          columns: 1,
          region: [0, 0, 1, 1],
          pooled: 1,
          scores: [1],
        })),
      }),
      { status: 200 },
    );
  };
  const controller = new TileMatchAreas();
  try {
    controller.configure(
      "test",
      { components: [{ text: "cat", weight: 1 }] },
      Array.from({ length: 17 }, (_, index) =>
        index === 16 ? { assetId: "17", timestampMs: 2000 } : { assetId: String(index + 1) },
      ),
    );
    assert.equal(controller.busy, true);
    const deadline = Date.now() + 3000;
    while (controller.busy && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    for (let index = 1; index <= 16; index += 1)
      assert.ok(controller.get({ assetId: String(index) }), `map ${index}`);
    assert.ok(controller.get({ assetId: "17", timestampMs: 2000 }));
    assert.equal(controller.get({ assetId: "17" }), undefined, "a frame map is not the poster's");
    assert.equal(controller.busy, false);
    assert.deepEqual(
      calls.map((ids) => ids.length),
      [8, 8, 1],
    );
    assert.deepEqual(calls[2], [{ assetId: 17, timestampMs: 2000 }]);
  } finally {
    controller.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("tile mapping does not re-request targets the service could not score", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ results: [{ assetId: 1, error: "missing" }] }), {
      status: 200,
    });
  };
  const controller = new TileMatchAreas();
  try {
    const query = { components: [{ text: "dog", weight: 1 }] };
    controller.configure("test", query, [{ assetId: "1" }, { assetId: "2" }]);
    const deadline = Date.now() + 3000;
    while (controller.busy && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.configure("test", query, [{ assetId: "1" }, { assetId: "2" }]);
    assert.equal(controller.busy, false);
    assert.equal(requests, 1, "an error and an omitted target both count as failed");
  } finally {
    controller.dispose();
    globalThis.fetch = originalFetch;
  }
});
