import { travel } from "./gesture-math";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Calls `onFire` when a touch press holds still, since iOS Safari sends no contextmenu for a long
 * press. Moving past the slop, lifting, or cancelling stops it. Returns a function that stops it
 * early.
 */
export function startLongPress(press: PointerEvent, onFire: () => void): () => void {
  const { pointerId } = press;
  const origin = { x: press.clientX, y: press.clientY };
  const stop = (): void => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
  };
  const move = (moved: PointerEvent): void => {
    if (
      moved.pointerId === pointerId &&
      travel(origin, { x: moved.clientX, y: moved.clientY }) > LONG_PRESS_SLOP_PX
    )
      stop();
  };
  const timer = setTimeout(() => {
    stop();
    onFire();
  }, LONG_PRESS_MS);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
  return stop;
}
