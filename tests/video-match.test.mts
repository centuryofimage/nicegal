import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { NicegalServerClient as Client } from "../src/main/backend/nicegal-server-client.ts";
import type { ThumbnailReader as Reader } from "../src/main/backend/thumbnail-reader.ts";
import type { GalleryItem } from "../src/renderer/src/lib/gallery/types.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-video-match-tests",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { NicegalServerClient } = (await vite.ssrLoadModule(
  "/src/main/backend/nicegal-server-client.ts",
)) as { NicegalServerClient: typeof Client };
const { ThumbnailReader } = (await vite.ssrLoadModule("/src/main/backend/thumbnail-reader.ts")) as {
  ThumbnailReader: typeof Reader;
};
const { buildLayout } = await vite.ssrLoadModule("/src/renderer/src/lib/gallery/layout.ts");
const { recyclePool } = await vite.ssrLoadModule("/src/renderer/src/lib/gallery/tile-pool.ts");

test("a visual video hit pools the winning frame and a separate poster fallback", () => {
  const item = {
    id: "7",
    displayName: "clip.mp4",
    mediaKind: "video",
    modifiedNs: "10",
    sourceSize: "20",
    thumbnailRevision: 0,
    width: 1280,
    height: 720,
    aspectRatio: 1280 / 720,
    date: 1,
  } as GalleryItem;
  const items = [item];
  const layout = buildLayout(items, 400);
  const request = {
    tiles: [],
    layout,
    items,
    start: 0,
    end: 1,
    poolSize: 1,
    devicePixelRatio: 1.5,
  };
  const matched = recyclePool({ ...request, matchTimes: new Map([["7", 13_000]]) })[0];
  assert.equal(new URL(matched.src).searchParams.get("frame"), "13000");
  assert.equal(new URL(matched.defaultSrc).searchParams.has("frame"), false);
  assert.equal(matched.matchTimestampMs, 13_000);
  const ordinary = recyclePool({ ...request, tiles: [matched] })[0];
  assert.equal(ordinary.src, ordinary.defaultSrc);
  assert.equal(ordinary.matchTimestampMs, undefined);
});

test("visual search keeps the winning video timestamp for text and composite queries", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          total: 1,
          results: [{ assetId: 7, timestampMs: 13_000, snippet: "", rank: 1, distance: 0.1 }],
          queries: [
            {
              key: "visual",
              total: 1,
              results: [{ assetId: 7, timestampMs: 13_000, snippet: "", rank: 1, distance: 0.1 }],
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const client = new NicegalServerClient("http://127.0.0.1:1", "test-token");
  const text = await client.search({ query: "cat", type: "image", root: "C:/videos" });
  const composite = await client.search({
    query: "",
    type: "image",
    root: "C:/videos",
    imageQuery: { components: [{ text: "cat", weight: 1 }] },
  });
  assert.equal(text.results[0].timestampMs, 13_000);
  assert.equal(composite.results[0].timestampMs, 13_000);
});

test("thumbnail reader returns the exact indexed sample and keeps the poster separate", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "nicegal-video-match-"));
  assert.equal(dirname(directory), tmpdir());
  const path = join(directory, "thumbnails.db");
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA user_version = 4;
    CREATE TABLE thumbnails (
      asset_id INTEGER, size_bucket INTEGER, generator_version INTEGER,
      source_modified_ns INTEGER, source_size INTEGER,
      width INTEGER, height INTEGER, encoding TEXT, data BLOB
    );
    CREATE TABLE video_thumbnails (
      asset_id INTEGER, timestamp_ms INTEGER, size_bucket INTEGER, sampling_version INTEGER,
      source_modified_ns INTEGER, source_size INTEGER,
      width INTEGER, height INTEGER, encoding TEXT, data BLOB
    );
  `);
  db.prepare("INSERT INTO thumbnails VALUES (7, 256, 3, 10, 20, 256, 144, 'image/jpeg', ?)").run(
    Buffer.from("poster"),
  );
  db.prepare(
    "INSERT INTO video_thumbnails VALUES (7, 13000, 256, 3, 10, 20, 256, 144, 'image/jpeg', ?)",
  ).run(Buffer.from("matched frame"));
  db.close();

  const reader = new ThumbnailReader(path);
  t.after(() => {
    reader.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(Buffer.from(reader.get("7", 3, "10", "20", 200)!.data).toString(), "poster");
  assert.equal(
    Buffer.from(reader.getVideoSample("7", 13_000, "10", "20", 200)!.data).toString(),
    "matched frame",
  );
  assert.equal(reader.getVideoSample("7", 12_000, "10", "20", 200), null);
  assert.equal(reader.getVideoSample("7", 13_000, "11", "20", 200), null);
});
