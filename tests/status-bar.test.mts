import { svelte } from "@sveltejs/vite-plugin-svelte";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

import type { LibraryRowStatus } from "../src/renderer/src/lib/catalog.svelte.ts";
import type { JobSnapshot } from "../src/shared/backend.ts";

const vite = await createServer({
  configFile: false,
  cacheDir: "node_modules/.vite-status-tests",
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [svelte()],
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  appType: "custom",
});
after(() => vite.close());
const { render } = await vite.ssrLoadModule("svelte/server");
const { default: StatusBar } = await vite.ssrLoadModule(
  "/src/renderer/src/components/StatusBar.svelte",
);
const empty: LibraryRowStatus = {
  cataloged: 100,
  indexed: 0,
  embedded: 0,
  pending: 0,
  lastIndexedAt: null,
  loading: false,
  error: null,
};
function statusMarkup(
  status: LibraryRowStatus | undefined,
  indexRate: number | null,
  indexingRunning = true,
  phase: JobSnapshot["phase"] = "imageEmbedding",
  matchedCount = 100,
  filtering = false,
  runtime: Record<string, unknown> = {},
  dismissedSetupErrorKey: string | null = null,
): string {
  return render(StatusBar, {
    props: {
      libraryName: "Library",
      libraryRoot: "library",
      hasLibrary: true,
      matchedCount,
      totalCount: 100,
      filtering,
      searching: false,
      selectedCount: 0,
      status,
      message: undefined,
      backendReady: true,
      backendError: null,
      runtime,
      job: {
        status: indexingRunning ? "running" : "completed",
        phase,
        progress: { itemsPerSecond: indexRate },
      },
      onsearchproblem: () => {},
      dismissedSetupErrorKey,
      ondismisssetup: () => {},
    },
  }).body;
}

test("a dismissed search warning stays hidden until the failure changes", () => {
  const first = statusMarkup(undefined, null, false, "imageEmbedding", 100, false, {
    error: "Could not change provider",
  });
  assert.match(first, /Search settings problem/);
  assert.match(first, /Dismiss this search warning/);

  const dismissed = statusMarkup(
    undefined,
    null,
    false,
    "imageEmbedding",
    100,
    false,
    { error: "Could not change provider" },
    "runtime:Could not change provider",
  );
  assert.doesNotMatch(dismissed, /Search settings problem/);

  const changed = statusMarkup(
    undefined,
    null,
    false,
    "imageEmbedding",
    100,
    false,
    { error: "Could not load provider" },
    "runtime:Could not change provider",
  );
  assert.match(changed, /Search settings problem/);
});

test("item count omits a redundant matches fraction when every item matches", () => {
  const allMatch = statusMarkup(undefined, null, false, "imageEmbedding", 100, true);
  assert.match(allMatch, />100 items</);
  assert.doesNotMatch(allMatch, /100 \/ 100 items/);

  const narrowed = statusMarkup(undefined, null, false, "imageEmbedding", 84, true);
  assert.match(narrowed, /84 \/ 100 items/);
});

test("throughput remains visible when image coverage is unknown", () => {
  for (const status of [
    empty,
    undefined,
    { ...empty, loading: true },
    { ...empty, error: "Status unavailable" },
  ]) {
    const html = statusMarkup(status, 12.5);
    assert.doesNotMatch(html, /index-status/);
    assert.match(html, /job-rate/);
    assert.match(html, /items\/s/);
  }
  assert.doesNotMatch(statusMarkup({ ...empty, indexed: 100 }, 0), /index-status/);
});

test("cataloging and indexing rates occupy the final status segment only while active", () => {
  for (const phase of ["cataloging", "ocr", "imageEmbedding", "textEmbedding"] as const) {
    const html = statusMarkup(
      { ...empty, imageCoverage: { indexed: 25, total: 80 } },
      42,
      true,
      phase,
    );
    assert.match(html, /42 items\/s/);
    assert.ok(html.indexOf("job-rate") > html.indexOf("index-status"));
    assert.doesNotMatch(statusMarkup(empty, 42, false, phase), /job-rate/);
    assert.doesNotMatch(statusMarkup(empty, null, true, phase), /job-rate/);
  }
});

test("image coverage is independent of OCR and uses the image denominator", () => {
  const html = statusMarkup({ ...empty, imageCoverage: { indexed: 25, total: 80 } }, 12.5);
  assert.match(html, /25 \/ 80 scanned/);
  assert.doesNotMatch(html, /index-status[^>]*title=|images\/s|with text/);
});

test("complete image coverage is omitted only when it duplicates the library count", () => {
  const duplicate = statusMarkup(
    { ...empty, imageCoverage: { indexed: 100, total: 100 } },
    null,
    false,
  );
  assert.doesNotMatch(duplicate, /index-status|scanned/);

  const eligibleSubset = statusMarkup(
    { ...empty, imageCoverage: { indexed: 80, total: 80 } },
    null,
    false,
  );
  assert.match(eligibleSubset, />80 scanned</);

  const noEligibleItems = statusMarkup(
    { ...empty, imageCoverage: { indexed: 0, total: 0 } },
    null,
    false,
  );
  assert.doesNotMatch(noEligibleItems, /index-status|scanned/);

  assert.match(
    statusMarkup({ ...empty, imageCoverage: { indexed: 0, total: 80 } }, null),
    /0 \/ 80 scanned/,
  );
});
