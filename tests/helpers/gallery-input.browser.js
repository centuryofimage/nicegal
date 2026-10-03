/* eslint-disable @typescript-eslint/explicit-function-return-type -- Runs directly as browser JavaScript through CDP. */
// Live renderer regression check: with pnpm dev running, connect agent-browser to 9222,
// then pipe this file into `agent-browser eval --stdin`. Uses CSS coordinates, not screenshots.
(async () => {
  const { createGalleryInput } = await import("/src/lib/gallery/input.ts");
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const counts = { starts: 0, ends: 0, clears: 0, opens: 0, drags: 0 };
  let isCurrent = () => false;
  let marqueeRect = null;
  const input = createGalleryInput({
    onopen: () => counts.opens++,
    onselect: () => {},
    onfilemenu: () => {},
    onclear: () => counts.clears++,
    onmarqueestart: () => counts.starts++,
    onmarqueechange: () => {},
    onmarqueeend: () => counts.ends++,
    onmarqueerect: (rect) => (marqueeRect = rect),
    marqueeHits: () => [],
    onfiledrag: (_index, current) => {
      counts.drags++;
      isCurrent = current;
    },
  });
  const viewport = document.createElement("div");
  viewport.style.cssText =
    "position:fixed;top:0;left:0;width:300px;height:300px;z-index:999999;background:white";
  const frame = document.createElement("div");
  frame.className = "gallery-frame";
  frame.dataset.galleryItemId = "fixture";
  frame.style.cssText = "position:absolute;top:20px;left:20px;width:40px;height:40px";
  const image = document.createElement("img");
  frame.append(image);
  viewport.append(frame);
  document.body.append(viewport);
  frame.addEventListener("dragstart", (event) => input.startFileDrag(event, { index: 0 }));
  const detach = input.attach(viewport);
  const mouse = (target, type, x, y, buttons = 1) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        buttons,
        button: 0,
      }),
    );
  const pointer = (target, type, x, y, buttons = 1) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        buttons,
        button: 0,
        pointerId: 1,
      }),
    );
  const press = (target, x, y) => {
    pointer(target, "pointerdown", x, y);
    mouse(target, "mousedown", x, y);
  };
  const release = (target, x, y) => {
    pointer(target, "pointerup", x, y, 0);
    mouse(target, "mouseup", x, y, 0);
  };
  const boxVisible = () => marqueeRect !== null;
  try {
    press(image, 30, 30);
    pointer(document, "pointermove", 90, 90);
    mouse(document, "mousemove", 90, 90);
    assert(counts.starts === 0 && !boxVisible(), "item presses must never arm a marquee");
    image.dispatchEvent(
      new DragEvent("dragstart", {
        bubbles: true,
        cancelable: true,
        dataTransfer: new DataTransfer(),
      }),
    );
    assert(counts.drags === 1 && isCurrent(), "item drag should own a live gesture");
    release(frame, 30, 30);
    assert(!isCurrent(), "release must invalidate delayed export preparation");
    input.activate({ index: 0 }, new MouseEvent("click", { detail: 1 }));
    assert(counts.opens === 0, "drag release must not open a tile");
    press(frame, 30, 30);
    release(frame, 30, 30);
    input.activate({ index: 0 }, new MouseEvent("click", { detail: 1 }));
    assert(counts.opens === 1, "the next genuine click must still open");

    const cancellations = [
      () => window.dispatchEvent(new Event("blur")),
      () => pointer(viewport, "pointercancel", 100, 100, 0),
      () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      () => mouse(document, "mousemove", 100, 100, 0),
      () => viewport.dispatchEvent(new DragEvent("dragstart", { bubbles: true })),
      () => viewport.dispatchEvent(new DragEvent("dragend", { bubbles: true })),
    ];
    for (const cancel of cancellations) {
      const started = counts.starts;
      press(viewport, 5, 5);
      pointer(document, "pointermove", 100, 100);
      mouse(document, "mousemove", 100, 100);
      assert(counts.starts === started + 1 && boxVisible(), "background drag must show a marquee");
      cancel();
      assert(!boxVisible(), "cancellation must remove the box immediately");
      pointer(document, "pointermove", 120, 120);
      mouse(document, "mousemove", 120, 120);
      assert(
        counts.starts === started + 1 && !boxVisible(),
        "returning mouse must not resurrect the box",
      );
      release(viewport, 5, 5);
    }
    assert(counts.clears === 0, "canceled or reversed drags must not become background clicks");
    press(viewport, 5, 5);
    release(viewport, 5, 5);
    assert(counts.clears === 1, "genuine background clicks still clear selection");
    press(viewport, 5, 5);
    pointer(document, "pointermove", 9, 7);
    release(viewport, 9, 7);
    assert(
      counts.clears === 1 && counts.starts === 6,
      "a short drag below the marquee threshold neither clears nor starts a marquee",
    );
    return { passed: true, devicePixelRatio, counts };
  } finally {
    detach();
    viewport.remove();
  }
})();
