import assert from "node:assert/strict";
import { test } from "node:test";

import type { Library, NativeFolderMenuRequest } from "../src/shared/backend.ts";

import { resolveFolderTarget } from "../src/main/native/folder-actions.ts";

function library(include: { path: string; hostPath?: string }[], exclude: string[] = []): Library {
  return {
    id: 1,
    include: include.map((folder) => ({
      ...folder,
      scanPending: false,
      scanError: null,
      lastScanCompletedNs: null,
    })),
    exclude,
    ocr: false,
    image: true,
    videos: true,
  };
}

const request = (path: string, libraryId = 1): NativeFolderMenuRequest => ({
  libraryId,
  path,
  canRemove: true,
});

test("folder menu accepts included folders and their subfolders", () => {
  const libraries = [library([{ path: "D:\\Photos" }])];
  assert.equal(resolveFolderTarget(libraries, request("D:\\Photos")).path, "D:\\Photos");
  assert.equal(
    resolveFolderTarget(libraries, request("D:\\Photos\\2024\\Trip")).externalPath,
    "D:\\Photos\\2024\\Trip",
  );
});

test("folder menu rejects paths outside the library, in exclusions, or in another library", () => {
  const libraries = [
    library([{ path: "D:\\Photos" }], ["D:\\Photos\\Private"]),
    { ...library([{ path: "E:\\Other" }]), id: 2 },
  ];
  for (const path of [
    "D:\\PhotosBackup",
    "D:\\\\",
    "C:\\Windows",
    "D:\\Photos\\..\\Secrets",
    "D:\\Photos\\Private",
    "D:\\Photos\\Private\\Inner",
    "E:\\Other",
  ]) {
    assert.throws(() => resolveFolderTarget(libraries, request(path)), path);
  }
  assert.throws(() => resolveFolderTarget(libraries, request("D:\\Photos", 3)));
});

test("folder menu rejects malformed requests", () => {
  const libraries = [library([{ path: "/home/me/Pictures" }])];
  for (const value of [
    null,
    "x",
    { libraryId: "1", path: "/home/me/Pictures", canRemove: true },
    { libraryId: 1, path: "Pictures", canRemove: true },
    { libraryId: 1, path: "/home/me/Pictures" },
  ]) {
    assert.throws(() => resolveFolderTarget(libraries, value));
  }
});

test("folder menu copies the host spelling of a sandboxed folder", () => {
  const libraries = [
    library([{ path: "/run/flatpak/doc/abc/Pictures", hostPath: "/home/me/Pictures" }]),
  ];
  const target = resolveFolderTarget(libraries, request("/run/flatpak/doc/abc/Pictures/2024"));
  assert.equal(target.path, "/run/flatpak/doc/abc/Pictures/2024");
  assert.equal(target.externalPath, "/home/me/Pictures/2024");
});
