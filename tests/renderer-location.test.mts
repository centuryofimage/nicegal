import assert from "node:assert/strict";
import { test } from "node:test";

import { APP_ENTRY_URL, isRendererEntryUrl } from "../src/main/renderer-location.ts";

test("the production renderer stays trusted through viewer history", () => {
  for (const suffix of ["", "#", "#item=2401", "#item=42&other=value"])
    assert.equal(isRendererEntryUrl(APP_ENTRY_URL + suffix), true);
});

test("viewer fragments do not admit another document or origin", () => {
  for (const url of [
    "app://renderer/other.html#item=1",
    "app://other/index.html#item=1",
    "app://renderer/index.html?other=1#item=1",
    "app://renderer/index.html/extra#item=1",
    "app://renderer/index.html%23item=1",
    "https://renderer/index.html#item=1",
    "app://renderer@other/index.html#item=1",
    "app://renderer.evil/index.html#item=1",
    "invalid",
    "",
  ])
    assert.equal(isRendererEntryUrl(url), false, url);
});
