import assert from "node:assert/strict";
import { test } from "node:test";
import { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-search-history-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { searchStepRelation, isRememberable, withRecent, matchingRecent } =
  (await vite.ssrLoadModule(
    "/src/renderer/src/lib/search-history.ts",
  )) as typeof import("../src/renderer/src/lib/search-history.ts");

function step(
  query: string,
  provisional = true,
  referenceIds: string[] = [],
): { query: string; referenceIds: string[]; provisional: boolean } {
  return { query, referenceIds, provisional };
}

test("typing refines a provisional step instead of adding Back steps", () => {
  assert.equal(searchStepRelation(step("ca"), step("cats")), "replace");
  assert.equal(searchStepRelation(step("cats on"), step("cats")), "replace", "backspacing");
  assert.equal(searchStepRelation(step("cats"), step("dogs")), "push");
  assert.equal(searchStepRelation(step("cats", false), step("cats on")), "push", "after Enter");
  assert.equal(searchStepRelation(step("cats"), step("ocr: cats")), "push", "new scope");
  assert.equal(searchStepRelation(step("cats "), step("cats")), "same");
});

test("a blank field is never its own step in the middle of history", () => {
  assert.equal(searchStepRelation(step("cats", false), step("")), "push", "clearing is a step");
  assert.equal(searchStepRelation(step(""), step("dogs")), "replace");
  assert.equal(searchStepRelation(step("ocr:"), step("ocr: dogs")), "replace");
  assert.equal(searchStepRelation(step("cats"), step("")), "push", "not merged as a prefix");
});

test("visual examples are part of a step", () => {
  assert.equal(
    searchStepRelation(step("like:", true, ["a"]), step("like:", true, ["a", "b"])),
    "push",
  );
  assert.equal(searchStepRelation(step("like:", false, ["a"]), step("like:", true, ["a"])), "same");
});

test("the recent list keeps searches with text or filters, newest first", () => {
  assert.equal(isRememberable("cats", 0), true);
  assert.equal(isRememberable("type:video", 0), true);
  assert.equal(isRememberable("ocr:", 0), false);
  assert.equal(isRememberable('in:"C:/Photos"', 0), false, "folder clicks are navigation");
  assert.equal(isRememberable("like: red car", 1), false, "examples are session-only");
  assert.deepEqual(withRecent(["a", "b", "c"], " b "), ["b", "a", "c"]);
  assert.equal(
    withRecent(
      Array.from({ length: 30 }, (_, i) => `q${i}`),
      "new",
    ).length,
    20,
  );
  assert.deepEqual(matchingRecent(["ocr: Invoice", "invoice", "cats"], "INV"), [
    "ocr: Invoice",
    "invoice",
  ]);
  assert.deepEqual(matchingRecent(["cats", "cats on"], "cats"), ["cats on"]);
});
