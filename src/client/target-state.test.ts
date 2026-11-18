import { describe, expect, it } from "vitest";
import { consumeOnce, effectiveTarget, pruneTargets, selectTarget, type TargetState } from "./target-state";

const s = (base: string, once: string | null = null): TargetState => ({ base, once });

describe("effectiveTarget", () => {
  it("the one-message destination if there is one, otherwise the base partner", () => {
    expect(effectiveTarget(s("alex"))).toBe("alex");
    expect(effectiveTarget(s("alex", "sam"))).toBe("sam");
  });
});

describe("selectTarget", () => {
  it("a normal selection switches the base partner and cancels the one-message destination", () => {
    expect(selectTarget(s("alex"), "sam", false)).toEqual(s("sam"));
    expect(selectTarget(s("alex", "jo"), "sam", false)).toEqual(s("sam"));
  });

  it("a normal selection of the crew member that is the one-message destination makes it the base partner (made permanent)", () => {
    expect(selectTarget(s("alex", "jo"), "jo", false)).toEqual(s("jo"));
  });

  it("a normal selection of the base partner cancels the one-message destination (the same as selecting the one to return to)", () => {
    expect(selectTarget(s("alex", "jo"), "alex", false)).toEqual(s("alex"));
  });

  it("selecting with Shift does not change the base partner and makes it the one-message destination. A different crew member replaces it", () => {
    expect(selectTarget(s("alex"), "sam", true)).toEqual(s("alex", "sam"));
    expect(selectTarget(s("alex", "sam"), "jo", true)).toEqual(s("alex", "jo"));
  });

  it("selecting with Shift the crew member that is already the one-message destination, or the one to return to, cancels the one-message destination", () => {
    expect(selectTarget(s("alex", "sam"), "sam", true)).toEqual(s("alex"));
    expect(selectTarget(s("alex", "sam"), "alex", true)).toEqual(s("alex"));
    expect(selectTarget(s("alex"), "alex", true)).toEqual(s("alex"));
  });
});

describe("consumeOnce", () => {
  it("sending cancels the one-message destination and goes back to the base partner. The same state if there is none", () => {
    expect(consumeOnce(s("alex", "sam"))).toEqual(s("alex"));
    const plain = s("alex");
    expect(consumeOnce(plain)).toBe(plain);
  });
});

describe("pruneTargets", () => {
  const roles = ["alex", "sam", "jo"];

  it("a base partner not on the ship becomes the fallback. A one-message destination not on the ship is cancelled", () => {
    expect(pruneTargets(s("gone", "sam"), roles, "alex")).toEqual(s("alex", "sam"));
    expect(pruneTargets(s("alex", "gone"), roles, "alex")).toEqual(s("alex"));
  });

  it("a one-message destination the same as the base is meaningless, so it is cancelled", () => {
    expect(pruneTargets(s("alex", "alex"), roles, "alex")).toEqual(s("alex"));
  });

  it("if there is nothing to fix, the same reference is returned (avoids needless re-rendering)", () => {
    const ok = s("alex", "sam");
    expect(pruneTargets(ok, roles, "alex")).toBe(ok);
  });
});
