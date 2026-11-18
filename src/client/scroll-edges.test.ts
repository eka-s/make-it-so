import { describe, expect, it } from "vitest";
import { EDGE_THRESHOLD, scrollEdges } from "./scroll-edges";

const view = (scrollTop: number, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

describe("scrollEdges", () => {
  it("at the very top, only atTop", () => {
    expect(scrollEdges(view(0))).toEqual({ atTop: true, atBottom: false });
  });

  it("at the very bottom, only atBottom", () => {
    expect(scrollEdges(view(1500))).toEqual({ atTop: false, atBottom: true });
  });

  it("in the middle, neither", () => {
    expect(scrollEdges(view(700))).toEqual({ atTop: false, atBottom: false });
  });

  it("a little away from an edge (within the threshold) still counts as being at that edge; beyond the threshold it does not", () => {
    expect(scrollEdges(view(EDGE_THRESHOLD)).atTop).toBe(true);
    expect(scrollEdges(view(EDGE_THRESHOLD + 1)).atTop).toBe(false);
    expect(scrollEdges(view(1500 - EDGE_THRESHOLD)).atBottom).toBe(true);
    expect(scrollEdges(view(1500 - EDGE_THRESHOLD - 1)).atBottom).toBe(false);
  });

  it("when the content fits in the area (cannot scroll), both are true = neither button is shown", () => {
    expect(scrollEdges(view(0, 400, 500))).toEqual({ atTop: true, atBottom: true });
    expect(scrollEdges(view(0, 500, 500))).toEqual({ atTop: true, atBottom: true });
  });

  it("the very bottom is detected even with a fractional scroll position (zoomed display, etc.)", () => {
    expect(scrollEdges(view(1499.6)).atBottom).toBe(true);
  });
});
