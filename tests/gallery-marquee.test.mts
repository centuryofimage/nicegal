import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type * as Layout from "../src/renderer/src/lib/gallery/layout.ts";
import type * as Marquee from "../src/renderer/src/lib/gallery/marquee.ts";
import type { GalleryItem, LayoutMode } from "../src/renderer/src/lib/gallery/types.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-gallery-marquee-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { buildLayout } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/gallery/layout.ts",
)) as typeof Layout;
const {
  marqueeHitIds,
  rectFromPoints,
  classifyPressTravel,
  autoScrollVelocity,
  CLICK_SLOP_PX,
  MARQUEE_START_PX,
  AUTO_SCROLL_EDGE_PX,
} = (await vite.ssrLoadModule("/src/renderer/src/lib/gallery/marquee.ts")) as typeof Marquee;

const items: GalleryItem[] = Array.from(
  { length: 2000 },
  (_, index) =>
    ({
      id: String(index),
      displayName: `photo${index}.jpg`,
      aspectRatio: [1.5, 0.66, 1, 2.2][index % 4],
      date: Date.parse("2026-06-01") - index * 3600000,
    }) as GalleryItem,
);

for (const mode of ["justified", "masonry", "grid"] as LayoutMode[]) {
  test(`${mode} marquee hits come from layout geometry, including unrendered tiles`, () => {
    const layout = buildLayout(items, 900, { mode });
    assert.ok(layout.height > 20000, "fixture is far taller than any viewport");
    // A drag that started near the top and auto-scrolled thousands of pixels down.
    const rect = rectFromPoints({ x: 850, y: 40 }, { x: 120, y: 9000 });
    const expected = layout.positions
      .filter(
        (position) =>
          position.x <= rect.right &&
          position.x + position.width >= rect.left &&
          position.y <= rect.bottom &&
          position.y + position.height >= rect.top,
      )
      .map((position) => items[position.index].id);
    const hits = marqueeHitIds(layout, items, rect);
    assert.deepEqual(hits, expected);
    const deepest = Math.max(...hits.map((id) => layout.positions[Number(id)].y));
    assert.ok(deepest > 8000, "tiles thousands of pixels below the press are selected");

    const band = rectFromPoints({ x: 0, y: 15000 }, { x: 5, y: 15001 });
    assert.ok(
      marqueeHitIds(layout, items, band).every((id) => layout.positions[Number(id)].x <= 5),
      "a narrow box excludes tiles it does not touch horizontally",
    );
    assert.deepEqual(
      marqueeHitIds(layout, items, rectFromPoints({ x: 0, y: -50 }, { x: 900, y: -10 })),
      [],
    );
  });
}

test("background press travel separates clicks, ignored jitter, and marquees", () => {
  assert.equal(classifyPressTravel(0, 0), "click");
  assert.equal(classifyPressTravel(CLICK_SLOP_PX, 0), "click");
  assert.equal(classifyPressTravel(3, 2), "none", "a sloppy click neither clears nor selects");
  assert.equal(classifyPressTravel(0, MARQUEE_START_PX - 1), "none");
  assert.equal(classifyPressTravel(-MARQUEE_START_PX, 0), "marquee");
  assert.equal(classifyPressTravel(6, 6), "marquee");
});

test("auto-scroll speed grows with distance past the viewport edge", () => {
  const top = 100;
  const bottom = 700;
  assert.equal(autoScrollVelocity(400, top, bottom), 0);
  assert.equal(autoScrollVelocity(top + AUTO_SCROLL_EDGE_PX, top, bottom), 0);
  assert.ok(autoScrollVelocity(top + 2, top, bottom) < 0, "near the top scrolls up");
  const slow = autoScrollVelocity(bottom - 2, top, bottom);
  const fast = autoScrollVelocity(bottom + 100, top, bottom);
  assert.ok(slow > 0 && fast > slow, "past the bottom scrolls down, faster further out");
  assert.equal(
    autoScrollVelocity(bottom + 1e6, top, bottom),
    autoScrollVelocity(bottom + 2e6, top, bottom),
  );
});
