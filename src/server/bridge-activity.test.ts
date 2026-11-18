import { afterEach, describe, expect, it, vi } from "vitest";
import { reportActivity, setActivityHandler } from "./bridge-activity.js";

// It uses module-level state (handlers), so registrations are cleared in each test to keep them independent.
const used = new Set<string>();
function register(missionId: string, fn: (() => void) | null): void {
  used.add(missionId);
  setActivityHandler(missionId, fn);
}

afterEach(() => {
  for (const id of used) setActivityHandler(id, null);
  used.clear();
});

describe("bridge-activity", () => {
  it("the handler registered for the mission is called", () => {
    const fn = vi.fn();
    register("m1", fn);
    reportActivity("m1");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("separated per mission (not overwritten by another mission's registration)", () => {
    const a = vi.fn();
    const b = vi.fn();
    register("a", a);
    register("b", b);

    reportActivity("a");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    // Regression: it used to be a single slot, and another mission's registration overwrote the earlier handler.
    reportActivity("b");
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("clearing with null stops it from being called", () => {
    const fn = vi.fn();
    register("m1", fn);
    register("m1", null);
    reportActivity("m1");
    expect(fn).not.toHaveBeenCalled();
  });

  it("reportActivity for a mission with no handler does nothing", () => {
    expect(() => reportActivity("none")).not.toThrow();
  });
});
