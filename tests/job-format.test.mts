import assert from "node:assert/strict";
import { test } from "node:test";

import type { JobSnapshot } from "../src/shared/backend.ts";

import {
  jobPhaseProgress,
  jobPhases,
  jobRateText,
  jobStepIndex,
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
  for (const phase of ["cataloging", "scanning", "ocr", "textEmbedding"] as const) {
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

test("image indexing shows its rate in images while completion stays in files", () => {
  const job = {
    status: "running",
    phase: "imageEmbedding",
    progress: {
      itemsPerSecond: 12.5,
      phaseCompleted: 2,
      total: 10,
    },
  } as JobSnapshot;
  assert.equal(
    jobRateText(job),
    `${(12.5).toLocaleString(undefined, { maximumFractionDigits: 1 })} images/s`,
  );
  assert.equal(jobPhaseProgress(job).text, "2 / 10");
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

test("a scan's model load shows under the stage it loads for", () => {
  const job = {
    type: "libraryScan",
    status: "running",
    phase: "loadingModels",
    progress: { loadingFor: "imageEmbedding", phaseCompleted: 0, total: 1 },
  } as JobSnapshot;
  const phases = jobPhases(job);
  assert.equal(phases[jobStepIndex(job, phases)].label, "Images");
  job.progress.loadingFor = "textEmbedding";
  assert.equal(phases[jobStepIndex(job, phases)].label, "Text");
  delete job.progress.loadingFor;
  assert.equal(jobStepIndex(job, phases), -1);

  const prepare = { ...job, type: "modelPrepare" } as JobSnapshot;
  const steps = jobPhases(prepare);
  assert.equal(steps[jobStepIndex(prepare, steps)].label, "Prepare");
});

test("a standalone embedding job shows its model load and work on its one stage", () => {
  for (const [type, phase, label] of [
    ["textEmbed", "textEmbedding", "Text"],
    ["imageEmbed", "imageEmbedding", "Images"],
  ] as const) {
    const job = {
      type,
      status: "running",
      phase: "loadingModels",
      progress: { loadingFor: phase, phaseCompleted: 0, total: 1 },
    } as JobSnapshot;
    const phases = jobPhases(job);
    assert.equal(phases[jobStepIndex(job, phases)].label, label);
    const working = { ...job, phase, progress: { phaseCompleted: 0, total: 5 } } as JobSnapshot;
    assert.equal(phases[jobStepIndex(working, phases)].label, label);
  }
});

test("a stage checking for pending work shows no count before its total", () => {
  const job = {
    status: "running",
    phase: "imageEmbedding",
    progress: { phaseCompleted: 0, total: null },
  } as JobSnapshot;
  assert.deepEqual(jobPhaseProgress(job), { text: "", ratio: null });
});
