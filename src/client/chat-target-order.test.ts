import { describe, expect, it } from "vitest";
import { applyOrder, countFitting, moveRole, stepHighlight } from "./chat-target-order";

describe("applyOrder", () => {
  it("if nothing is saved, the composition order as is", () => {
    expect(applyOrder(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
  });

  it("the saved order takes priority, new ones not in the saved order are added at the end. Ones that are gone are dropped", () => {
    expect(applyOrder(["a", "b", "c", "d"], ["c", "gone", "a"])).toEqual(["c", "a", "b", "d"]);
  });

  it("duplicates in the saved order are reduced to one", () => {
    expect(applyOrder(["a", "b"], ["b", "b", "a"])).toEqual(["b", "a"]);
  });
});

describe("moveRole", () => {
  const order = ["a", "b", "c", "d"];

  it("moving from front to back puts it at the drop target's position (toward the back)", () => {
    expect(moveRole(order, "a", "c")).toEqual(["b", "c", "a", "d"]);
  });

  it("moving from back to front puts it at the drop target's position (toward the front)", () => {
    expect(moveRole(order, "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("specifying the same one, or one that does not exist, changes nothing", () => {
    expect(moveRole(order, "b", "b")).toBe(order);
    expect(moveRole(order, "x", "b")).toBe(order);
    expect(moveRole(order, "a", "x")).toBe(order);
  });
});

describe("countFitting", () => {
  it("if all fit, the full count (no room is left for the more button)", () => {
    expect(countFitting([50, 50, 50], 160, 5, 30)).toBe(3); // 150 + gap 10 = 160
  });

  it("if they do not fit, room is left for the more button and the number that fit is returned", () => {
    // 3 buttons give 170 > 160. more 30 + (gap 5+50) + (5+50) = 140, and the 3rd is 195 > 160
    expect(countFitting([50, 50, 50], 159, 5, 30)).toBe(2);
  });

  it("if too narrow, 0 (only the more button)", () => {
    expect(countFitting([50, 50], 60, 5, 30)).toBe(0);
  });

  it("0 if there are no buttons", () => {
    expect(countFitting([], 100, 5, 30)).toBe(0);
  });
});

describe("stepHighlight", () => {
  const order = ["a", "b", "c"];

  it("moves one at a time, wrapping around at the ends", () => {
    expect(stepHighlight(order, "a", 1)).toBe("b");
    expect(stepHighlight(order, "c", 1)).toBe("a");
    expect(stepHighlight(order, "a", -1)).toBe("c");
  });

  it("if there is no current position, moving right starts from the first and moving left from the last", () => {
    expect(stepHighlight(order, null, 1)).toBe("a");
    expect(stepHighlight(order, null, -1)).toBe("c");
    expect(stepHighlight(order, "zzz", 1)).toBe("a");
  });

  it("null if the list is empty", () => {
    expect(stepHighlight([], null, 1)).toBeNull();
  });
});
