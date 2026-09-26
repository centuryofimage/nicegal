import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type * as FolderTree from "../src/renderer/src/lib/folder-tree.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-folder-tree-tests",
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { buildFolderTree, visibleFolderRows } = (await vite.ssrLoadModule(
  "/src/renderer/src/lib/folder-tree.ts",
)) as typeof FolderTree;

const ms = (value: number): string => String(BigInt(value) * 1_000_000n);
const root = "D:\\Downloads";
const folders = [
  { path: root, modifiedNs: ms(100) },
  { path: `${root}\\a10`, modifiedNs: ms(300) },
  { path: `${root}\\a2`, modifiedNs: ms(200) },
  { path: `${root}\\a2\\deep`, modifiedNs: ms(900) },
  { path: `${root}\\b`, modifiedNs: ms(500) },
  { path: `${root}\\c`, modifiedNs: null },
];
const imagePaths = [
  `${root}\\a10\\image.jpg`,
  `${root}\\a2\\deep\\image.jpg`,
  `${root}\\b\\image.jpg`,
  `${root}\\c\\image.jpg`,
];
const names = (rows: FolderTree.FolderRow[]): string[] => rows.map((row) => row.node.name);

test("name order is natural and newest order rolls descendants up", () => {
  const byName = buildFolderTree([root], folders, "name", imagePaths);
  assert.deepEqual(
    byName[0].children.map((node) => node.name),
    ["a2", "a10", "b", "c"],
  );
  const byNewest = buildFolderTree([root], folders, "newest", imagePaths);
  assert.equal(byNewest[0].newestMs, 900);
  assert.deepEqual(
    byNewest[0].children.map((node) => node.name),
    ["a2", "b", "a10", "c"],
  );
});

test("roots and the focused branch open by default; explicit choices win", () => {
  const tree = buildFolderTree([root], folders, "name", imagePaths);
  assert.deepEqual(names(visibleFolderRows(tree, {}, null, "")), [
    "Downloads",
    "a2",
    "a10",
    "b",
    "c",
  ]);
  assert.deepEqual(names(visibleFolderRows(tree, {}, `${root}\\a2\\deep`, "")), [
    "Downloads",
    "a2",
    "deep",
    "a10",
    "b",
    "c",
  ]);
  assert.deepEqual(names(visibleFolderRows(tree, { [root]: false }, null, "")), ["Downloads"]);
});

test("filter keeps matches and their ancestors, marking only matches", () => {
  const tree = buildFolderTree([root], folders, "name", imagePaths);
  const rows = visibleFolderRows(tree, { [root]: false }, null, "DEE");
  assert.deepEqual(names(rows), ["Downloads", "a2", "deep"]);
  assert.deepEqual(
    rows.map((row) => row.match),
    [null, null, { start: 0, end: 3 }],
  );
  assert.deepEqual(visibleFolderRows(tree, {}, null, "zzz"), []);
});

test("folders without images or image-bearing descendants are hidden", () => {
  const tree = buildFolderTree([root, "E:\\Empty"], folders, "name", [
    `${root}\\a2\\deep\\image.jpg`,
    `${root}\\b\\image.jpg`,
  ]);
  assert.deepEqual(names(visibleFolderRows(tree, {}, null, "")), ["Downloads", "a2", "b"]);
  assert.deepEqual(names(visibleFolderRows(tree, {}, `${root}\\a2\\deep`, "")), [
    "Downloads",
    "a2",
    "deep",
    "b",
  ]);
  assert.deepEqual(visibleFolderRows(tree, {}, null, "a10"), []);
  assert.deepEqual(buildFolderTree([root], folders, "name", []), []);
});
