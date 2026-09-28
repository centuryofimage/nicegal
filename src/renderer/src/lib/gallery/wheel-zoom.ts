import { settings, settingsLimits, type GallerySettings } from "../settings.svelte";

export type SizeKey = "targetRowHeight" | "masonryColumnWidth" | "gridCellWidth";

export function sizeKey(current: GallerySettings): SizeKey {
  return current.layoutMode === "justified"
    ? "targetRowHeight"
    : current.layoutMode === "masonry"
      ? "masonryColumnWidth"
      : "gridCellWidth";
}

/** Sets the current layout's tile size, clamped, and snapped to its slider's step unless `exact`
 * (a pinch lands wherever the fingers stopped). */
export function setTileSize(size: (current: number, key: SizeKey) => number, exact = false): void {
  settings.update((current) => {
    const key = sizeKey(current);
    const limit = settingsLimits[key];
    const requested = size(current[key], key);
    const next = exact ? requested : Math.round(requested / limit.step) * limit.step;
    const clamped = Math.max(limit.min, Math.min(limit.max, next));
    if (clamped === current[key]) return current;
    return {
      ...current,
      [key]: clamped,
      ...(current.layoutMode === "grid" ? { gridColumns: 0 } : {}),
    };
  });
}

/** Ctrl+wheel changes tile size. The owner supplies whether an overlay blocks the gallery. */
export function createGalleryWheelZoom(
  isBlocked: () => boolean,
): (element: HTMLDivElement) => () => void {
  return (element: HTMLDivElement): (() => void) => {
    let accumulated = 0;
    let lastWheelTime = 0;
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || isBlocked()) {
        accumulated = 0;
        return;
      }
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      if (!delta) return;
      if (event.timeStamp - lastWheelTime > 250 || Math.sign(delta) !== Math.sign(accumulated))
        accumulated = 0;
      lastWheelTime = event.timeStamp;
      accumulated += delta;
      const steps = Math.trunc(accumulated / 80);
      if (!steps) return;
      accumulated -= steps * 80;
      setTileSize((size, key) => size - steps * settingsLimits[key].step * 3);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  };
}
