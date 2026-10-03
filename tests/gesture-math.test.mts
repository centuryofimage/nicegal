import assert from "node:assert/strict";
import { test } from "node:test";

import {
  distance,
  pinchOf,
  pinchStep,
  swipeDirection,
  travel,
} from "../src/renderer/src/lib/gesture-math.ts";

test("pinchOf measures span and midpoint", () => {
  const pinch = pinchOf({ x: 0, y: 0 }, { x: 6, y: 8 });
  assert.equal(pinch.distance, 10);
  assert.deepEqual(pinch.mid, { x: 3, y: 4 });
  assert.equal(distance({ x: 1, y: 1 }, { x: 1, y: 1 }), 0);
});

test("pinchStep scales by the span ratio and pans by the midpoint shift", () => {
  const prev = pinchOf({ x: 0, y: 0 }, { x: 100, y: 0 });
  const next = pinchOf({ x: 10, y: 5 }, { x: 210, y: 5 });
  const step = pinchStep(prev, next);
  assert.equal(step.ratio, 2);
  assert.deepEqual(step.pan, { x: 60, y: 5 });
});

test("pinchStep does not scale from a zero span", () => {
  const prev = pinchOf({ x: 5, y: 5 }, { x: 5, y: 5 });
  const next = pinchOf({ x: 0, y: 0 }, { x: 50, y: 0 });
  assert.equal(pinchStep(prev, next).ratio, 1);
});

test("swipeDirection needs a long, mostly horizontal drag", () => {
  assert.equal(swipeDirection(-80, 10), "next");
  assert.equal(swipeDirection(80, -10), "prev");
  assert.equal(swipeDirection(-49, 0), null);
  assert.equal(swipeDirection(-60, 40), null);
  assert.equal(swipeDirection(-60, 30), "next");
  assert.equal(swipeDirection(0, 200), null);
});

test("travel is Manhattan distance", () => {
  assert.equal(travel({ x: 1, y: 1 }, { x: 4, y: -3 }), 7);
});
