import { travel } from "./gesture-math";

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/**
 * Calls `onFire` when a touch press holds still, since iOS Safari sends no contextmenu for a long
 * press. Moving past the slop, lifting, or cancelling stops it. Returns a function that stops it
 * early.
 *
 * Android Chrome sends its own contextmenu for the same hold, so whichever comes first owns the
 * press: a platform contextmenu stops the timer, and once the timer fires the platform's
 * contextmenu for that hold is swallowed. The menu `onFire` opens is usually modal, which makes
 * the pressed element inert, so that contextmenu would otherwise reach an element that does not
 * prevent it and add the browser's image menu on top.
 */
export function startLongPress(press: PointerEvent, onFire: () => void): () => void {
  const { pointerId } = press;
  const origin = { x: press.clientX, y: press.clientY };
  const stop = (): void => {
    clearTimeout(timer);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", stop, true);
    window.removeEventListener("pointercancel", stop, true);
    window.removeEventListener("contextmenu", stop, true);
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
    swallowPlatformMenu();
    onFire();
  }, LONG_PRESS_MS);
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", stop, true);
  window.addEventListener("pointercancel", stop, true);
  window.addEventListener("contextmenu", stop, true);
  return stop;
}

/** Prevents the next contextmenu, until the finger lifts or another press begins. */
function swallowPlatformMenu(): void {
  const swallow = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    done();
  };
  const done = (): void => {
    window.removeEventListener("contextmenu", swallow, true);
    window.removeEventListener("pointerup", done, true);
    window.removeEventListener("pointercancel", done, true);
    window.removeEventListener("pointerdown", done, true);
  };
  window.addEventListener("contextmenu", swallow, true);
  window.addEventListener("pointerup", done, true);
  window.addEventListener("pointercancel", done, true);
  window.addEventListener("pointerdown", done, true);
}
