import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type * as Layout from "../src/renderer/src/lib/gallery/layout.ts";
import type * as ScrollAnchor from "../src/renderer/src/lib/gallery/scroll-anchor.ts";
import type { GalleryItem, GallerySection } from "../src/renderer/src/lib/gallery/types.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-gallery-scroll-anchor-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { buildLayout } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/gallery/layout.ts",
)) as typeof Layout;
const { captureAnchor, anchorScrollTop } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/gallery/scroll-anchor.ts",
)) as typeof ScrollAnchor;

const items: GalleryItem[] = Array.from(
  { length: 600 },
  (_, index) =>
    ({
      id: `asset-${index}`,
      displayName: `photo${index}.jpg`,
      aspectRatio: [1.5, 0.66, 1, 2.2, 0.47][index % 5],
      date: Date.parse("2026-06-01") - index * 3600000,
    }) as GalleryItem,
);

/** Asserts the viewport top lands inside the anchored item, as far down it as before. */
function assertRestored(
  layout: ReturnType<typeof buildLayout>,
  list: readonly GalleryItem[],
  anchor: ScrollAnchor.ScrollAnchor | undefined,
): number {
  assert.equal(anchor?.kind, "item");
  if (anchor?.kind !== "item") return 0;
  const restored = anchorScrollTop(layout, list, anchor);
  assert.ok(restored !== undefined);
  const position = layout.positions[list.findIndex((item) => item.id === anchor.id)];
  assert.ok(position.y <= restored && restored < position.y + position.height);
  assert.ok(Math.abs((restored - position.y) / position.height - anchor.progress) < 1e-9);
  return restored;
}

test("an item anchor finds the same item after a resize and a mode change", () => {
  const before = buildLayout(items, 1200, { mode: "justified" });
  const scrollTop = before.positions[300].y + before.positions[300].height * 0.25;
  const anchor = captureAnchor(before, items, scrollTop);
  // The anchor is an item in the row under the top, not a pixel offset.
  assert.ok(anchor?.kind === "item" && Math.abs(anchor.progress - 0.25) < 1e-9);

  for (const after of [
    buildLayout(items, 700, { mode: "justified" }),
    buildLayout(items, 1200, { mode: "masonry" }),
    buildLayout(items, 900, { mode: "grid" }),
  ])
    assertRestored(after, items, anchor);
});

test("an item anchor survives items removed above it", () => {
  const layout = buildLayout(items, 1000, { mode: "justified" });
  const scrollTop = layout.positions[400].y + 1;
  const anchor = captureAnchor(layout, items, scrollTop);

  const filtered = items.filter((_, index) => index % 3 !== 0 || index >= 400);
  const after = buildLayout(filtered, 1000, { mode: "justified" });
  assert.ok(assertRestored(after, filtered, anchor) < scrollTop, "the item moved up");
});

test("the top stays the top, not the first tile under the padding", () => {
  const layout = buildLayout(items, 1000, { mode: "justified" });
  assert.deepEqual(captureAnchor(layout, items, 0), { kind: "top" });
  assert.deepEqual(captureAnchor(layout, items, 0.4), { kind: "top" });
  assert.equal(anchorScrollTop(layout, items, { kind: "top" }), 0);
});

test("a section header anchor keeps its offset; a missing section or item restores nothing", () => {
  const sections: GallerySection[] = [
    { key: "literal", label: "Names and text", start: 0, count: 200 },
    { key: "visual", label: "Visual results", start: 200, count: 400 },
  ];
  const layout = buildLayout(items, 1000, { mode: "justified" }, sections, 26, 6);
  const header = layout.dividers.find((divider) => divider.key === "visual")!;
  const anchor = captureAnchor(layout, items, header.y + 10);
  assert.deepEqual(anchor, { kind: "section", key: "visual", offset: 10 });

  const narrower = buildLayout(items, 600, { mode: "justified" }, sections, 26, 6);
  const moved = narrower.dividers.find((divider) => divider.key === "visual")!;
  assert.equal(anchorScrollTop(narrower, items, anchor), moved.y + 10);

  const withoutSections = buildLayout(items, 600, { mode: "justified" });
  assert.equal(anchorScrollTop(withoutSections, items, anchor), undefined);
  assert.equal(
    anchorScrollTop(layout, items, { kind: "item", id: "gone", progress: 0 }),
    undefined,
  );
});
