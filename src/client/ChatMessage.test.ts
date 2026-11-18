import { describe, expect, it } from "vitest";
import { formatCredits } from "./ChatMessage";

describe("formatCredits", () => {
  it("usd (claude) is in dollars with 4 decimal places", () => {
    expect(formatCredits({ credits: 0.12345, unit: "usd", turnDurationMs: 0 })).toBe("$0.1235");
    expect(formatCredits({ credits: 0, unit: "usd", turnDurationMs: 0 })).toBe("$0.0000");
  });

  it("kiro_credits (kiro's credits) is in cr units with 2 decimal places", () => {
    expect(formatCredits({ credits: 1.234, unit: "kiro_credits", turnDurationMs: 0 })).toBe("1.23 cr");
    expect(formatCredits({ credits: 10, unit: "kiro_credits", turnDurationMs: 0 })).toBe("10.00 cr");
  });
});
