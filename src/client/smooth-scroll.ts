// Scroll animation. The browser's built-in smooth scroll cannot change its speed and takes about 1 second for a long distance.
// To speed up moves within the conversation (search, pins, history, popups, the button at the bottom right), we animate it ourselves.
// The duration depends on the distance (instant for a short distance, at most 0.5 seconds even for a long one), fast at first and easing toward the end.

/**
 * Range of the animation duration (milliseconds). About half of the built-in smooth scroll (about 1 second for a long distance).
 */
export const MIN_SCROLL_MS = 120;
export const MAX_SCROLL_MS = 500;
/** Duration added per 1 px (milliseconds). The farther, the longer, but it stops at the upper limit. */
const MS_PER_PX = 0.06;

/**
 * Decides the animation duration (milliseconds) from the distance to move (px). 0 if there is no movement (0).
 */
export function scrollDurationMs(distancePx: number): number {
  const distance = Math.abs(distancePx);
  if (distance < 1) return 0;
  return Math.round(Math.min(MAX_SCROLL_MS, MIN_SCROLL_MS + distance * MS_PER_PX));
}

/**
 * Easing: fast at first and gentle toward the end (turns progress 0 to 1 into the fraction moved, 0 to 1).
 */
export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/**
 * The scroll position that places an element at the vertical center of an area. If the element is taller than the area, its top edge is aligned (leaving a little margin).
 */
export function scrollTopToReveal(
  area: { scrollTop: number; clientHeight: number; scrollHeight: number; top: number },
  element: { top: number; height: number },
  margin = 12,
): number {
  const offsetInContent = area.scrollTop + (element.top - area.top);
  const wanted = element.height >= area.clientHeight
    ? offsetInContent - margin
    : offsetInContent - (area.clientHeight - element.height) / 2;
  return Math.min(Math.max(0, wanted), Math.max(0, area.scrollHeight - area.clientHeight));
}

export type SmoothScrollDeps = {
  raf: (callback: () => void) => number;
  cancelRaf: (handle: number) => void;
  now: () => number;
  /** Whether the user has set reduced motion (in that case, no animation and it moves right away). */
  prefersReducedMotion: () => boolean;
};

const browserDeps = (): SmoothScrollDeps => ({
  raf: (callback) => requestAnimationFrame(callback),
  cancelRaf: (handle) => cancelAnimationFrame(handle),
  now: () => performance.now(),
  prefersReducedMotion: () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
});

export type SmoothScroll = {
  /** true if it moved all the way. false if it was stopped midway (the user scrolled, or another move). */
  finished: Promise<boolean>;
  cancel: () => void;
};

// The animation running in the same area. When a new move starts, the previous one is stopped.
const active = new WeakMap<object, () => void>();

/**
 * An action that stops the animation when the user starts scrolling on their own (so as not to fight over control).
 */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Scrolls `el` vertically to the `top` position. It moves for a duration based on the distance, and when done `finished` resolves to true.
 * If the user acts (wheel, touch, click, key), it stops there (finished is false).
 */
export function animateScrollTo(
  el: Pick<HTMLElement, "scrollTop" | "addEventListener" | "removeEventListener">,
  top: number,
  deps: SmoothScrollDeps = browserDeps(),
): SmoothScroll {
  active.get(el)?.();

  const from = el.scrollTop;
  const distance = top - from;
  const duration = deps.prefersReducedMotion() ? 0 : scrollDurationMs(distance);

  let resolve!: (finished: boolean) => void;
  const finished = new Promise<boolean>((r) => { resolve = r; });
  let handle: number | null = null;
  let settled = false;

  const finish = (completed: boolean) => {
    if (settled) return;
    settled = true;
    if (handle !== null) deps.cancelRaf(handle);
    for (const type of USER_SCROLL_EVENTS) el.removeEventListener(type, onUser);
    if (active.get(el) === cancel) active.delete(el);
    resolve(completed);
  };
  const onUser = () => finish(false);
  const cancel = () => finish(false);

  if (duration === 0) {
    el.scrollTop = top;
    resolve(true);
    settled = true;
    return { finished, cancel: () => {} };
  }

  active.set(el, cancel);
  for (const type of USER_SCROLL_EVENTS) el.addEventListener(type, onUser, { passive: true });

  const start = deps.now();
  const tick = () => {
    const progress = (deps.now() - start) / duration;
    if (progress >= 1) {
      el.scrollTop = top;
      finish(true);
      return;
    }
    el.scrollTop = from + distance * easeOutCubic(progress);
    handle = deps.raf(tick);
  };
  handle = deps.raf(tick);

  return { finished, cancel };
}
