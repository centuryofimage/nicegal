import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobSnapshot } from "../src/shared/backend.ts";

import {
  jobPhaseProgress,
  jobPhases,
  jobRateText,
  summarizeCompletion,
} from "../src/renderer/src/lib/job-format.ts";

test("video embedding shows active work before its first asset is committed", () => {
  const job = {
    status: "running",
    phase: "imageEmbedding",
    activeAssetPaths: ["C:/gallery/movie.mp4"],
    progress: { phaseCompleted: 0, total: 2 },
  } as JobSnapshot;
  assert.deepEqual(jobPhaseProgress(job), {
    text: "0 / 2 · processing 1 file",
    ratio: 0,
  });
  job.progress.phaseCompleted = 1;
  assert.equal(jobPhaseProgress(job).text, "1 / 2");
});

test("cataloging and indexing show valid backend phase rates, including zero", () => {
  for (const phase of [
    "cataloging",
    "scanning",
    "ocr",
    "imageEmbedding",
    "textEmbedding",
  ] as const) {
    const job = { status: "running", phase, progress: { itemsPerSecond: 12.5 } } as JobSnapshot;
    assert.equal(
      jobRateText(job),
      `${(12.5).toLocaleString(undefined, { maximumFractionDigits: 1 })} items/s`,
    );
    job.progress.itemsPerSecond = 0;
    assert.equal(jobRateText(job), "0 items/s");
    for (const rate of [undefined, null, NaN, Infinity, -1]) {
      job.progress.itemsPerSecond = rate;
      assert.equal(jobRateText(job), "");
    }
    job.progress.itemsPerSecond = 12;
    job.status = "completed";
    assert.equal(jobRateText(job), "");
    job.status = "running";
    job.phase = "loadingModels";
    assert.equal(jobRateText(job), "");
  }
});

test("a library scan shows only the index stages its library runs", () => {
  const job = {
    type: "libraryScan",
    indexStages: { ocr: false, image: true, text: false },
  } as JobSnapshot;
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "Images", "Done"],
  );
  assert.ok(jobPhases(job)[0].backendPhases.includes("pruning"));
  job.indexStages = { ocr: true, image: false, text: true };
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "OCR", "Text", "Done"],
  );
  assert.ok(jobPhases(job)[1].backendPhases.includes("downloadingModels"));
  job.indexStages = { ocr: false, image: false, text: false };
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "Done"],
  );
  delete job.indexStages;
  assert.deepEqual(
    jobPhases(job).map((p) => p.label),
    ["Sync", "Images", "OCR", "Text", "Done"],
  );
});

test("a scan summary names folders that need attention", () => {
  const job = {
    type: "libraryScan",
    status: "completed",
    progress: { cataloged: 3, embedded: 2, deleted: 0 },
    folders: [
      { path: "D:/a", state: "completed" },
      { path: "E:/b", state: "unavailable" },
    ],
  } as unknown as JobSnapshot;
  assert.equal(summarizeCompletion(job), "Scanned 3 files, indexed 2 · 1 folder needs attention");
});
