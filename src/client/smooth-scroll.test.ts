import { describe, expect, it, vi } from "vitest";
import { MAX_SCROLL_MS, MIN_SCROLL_MS, animateScrollTo, easeOutCubic, scrollDurationMs, scrollTopToReveal, type SmoothScrollDeps } from "./smooth-scroll";

describe("scrollDurationMs", () => {
  it("0 if it does not move. Short when close, longer the farther, stopping at the upper limit (within about half of the built-in roughly 1 second)", () => {
    expect(scrollDurationMs(0)).toBe(0);
    expect(scrollDurationMs(0.4)).toBe(0);
    expect(scrollDurationMs(100)).toBeGreaterThanOrEqual(MIN_SCROLL_MS);
    expect(scrollDurationMs(100)).toBeLessThan(scrollDurationMs(3000));
    expect(scrollDurationMs(1_000_000)).toBe(MAX_SCROLL_MS);
    expect(MAX_SCROLL_MS).toBeLessThanOrEqual(500);
  });

  it("the same duration for an upward distance (a negative value)", () => {
    expect(scrollDurationMs(-2000)).toBe(scrollDurationMs(2000));
  });
});

describe("easeOutCubic", () => {
  it("0 gives 0 and 1 gives 1. In between, it is faster at first (more than half is covered in the first half). Out of range is clamped", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe("scrollTopToReveal", () => {
  const area = { scrollTop: 1000, clientHeight: 600, scrollHeight: 5000, top: 50 };

  it("if the element is lower than the area, the position that puts it at the vertical center", () => {
    // The element is 450 from the top on screen (400 below the area's top edge at 50), with height 100 → position within the content 1000+400=1400. To put it at the center: 1400-(600-100)/2=1150
    expect(scrollTopToReveal(area, { top: 450, height: 100 })).toBe(1150);
  });

  it("if the element is taller than the area, the top edges are aligned (leaving a margin)", () => {
    expect(scrollTopToReveal(area, { top: 450, height: 900 })).toBe(1400 - 12);
  });

  it("clamped to the range (0 to the maximum scrollable)", () => {
    expect(scrollTopToReveal({ ...area, scrollTop: 0 }, { top: 60, height: 100 })).toBe(0);
    expect(scrollTopToReveal({ ...area, scrollTop: 4300 }, { top: 640, height: 100 })).toBe(4400);
  });
});

// Fake clock and rAF: 1 frame = 16ms
function setup(opts: { reduced?: boolean } = {}) {
  let time = 0;
  let pending: (() => void) | null = null;
  const listeners = new Map<string, () => void>();
  const deps: SmoothScrollDeps = {
    raf: (cb) => { pending = cb; return 1; },
    cancelRaf: () => { pending = null; },
    now: () => time,
    prefersReducedMotion: () => opts.reduced === true,
  };
  const el = {
    scrollTop: 0,
    addEventListener: vi.fn((type: string, cb: () => void) => void listeners.set(type, cb)),
    removeEventListener: vi.fn((type: string) => void listeners.delete(type)),
  };
  const frame = (ms = 16) => {
    time += ms;
    const cb = pending;
    pending = null;
    cb?.();
  };
  return { deps, el, frame, listeners, hasPending: () => pending !== null };
}

describe("animateScrollTo", () => {
  it("moves to the target position over a time based on the distance, and resolves to true when done", async () => {
    const { deps, el, frame } = setup();
    const duration = scrollDurationMs(3000);
    const anim = animateScrollTo(el as never, 3000, deps);
    frame(duration / 2);
    expect(el.scrollTop).toBeGreaterThan(1500); // easing: more than half is covered in half the time
    expect(el.scrollTop).toBeLessThan(3000);
    frame(duration);
    expect(el.scrollTop).toBe(3000);
    await expect(anim.finished).resolves.toBe(true);
  });

  it("faster than the built-in smooth scroll: even a long move arrives within 0.5 seconds", async () => {
    const { deps, el, frame } = setup();
    const anim = animateScrollTo(el as never, 50_000, deps);
    frame(MAX_SCROLL_MS);
    expect(el.scrollTop).toBe(50_000);
    await expect(anim.finished).resolves.toBe(true);
  });

  it("if it does not move (already at that position), it resolves to true right away and uses no frames", async () => {
    const { deps, el, hasPending } = setup();
    el.scrollTop = 500;
    const anim = animateScrollTo(el as never, 500, deps);
    expect(hasPending()).toBe(false);
    await expect(anim.finished).resolves.toBe(true);
  });

  it("when the user starts moving (wheel, etc.), it stops there and resolves to false. It does not take over the position afterwards", async () => {
    const { deps, el, frame, listeners, hasPending } = setup();
    const anim = animateScrollTo(el as never, 3000, deps);
    frame(40);
    const mid = el.scrollTop;
    expect(mid).toBeGreaterThan(0);
    listeners.get("wheel")!();
    await expect(anim.finished).resolves.toBe(false);
    expect(hasPending()).toBe(false);
    frame(1000);
    expect(el.scrollTop).toBe(mid);
    expect(el.removeEventListener).toHaveBeenCalled();
  });

  it("when a new move starts, the previous one stops (resolves to false)", async () => {
    const { deps, el, frame } = setup();
    const first = animateScrollTo(el as never, 3000, deps);
    frame(40);
    const second = animateScrollTo(el as never, 100, deps);
    await expect(first.finished).resolves.toBe(false);
    frame(1000);
    expect(el.scrollTop).toBe(100);
    await expect(second.finished).resolves.toBe(true);
  });

  it("with reduced motion, it does not animate and moves to the target position right away", async () => {
    const { deps, el, hasPending } = setup({ reduced: true });
    const anim = animateScrollTo(el as never, 3000, deps);
    expect(el.scrollTop).toBe(3000);
    expect(hasPending()).toBe(false);
    await expect(anim.finished).resolves.toBe(true);
  });

  it("can be stopped with cancel", async () => {
    const { deps, el, frame } = setup();
    const anim = animateScrollTo(el as never, 3000, deps);
    frame(30);
    anim.cancel();
    await expect(anim.finished).resolves.toBe(false);
  });
});
