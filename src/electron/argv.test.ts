import { describe, expect, it } from "vitest";
import { parseShipArg } from "../server/ship-arg.js";
import { withScript } from "./argv.js";
import { chooseStartMode } from "./start-mode.js";

describe("the arguments the app is started with", () => {
  it("are left as they are when the app runs from a script", () => {
    const argv = ["/electron", "dist/electron/main.js", "--ship", "alpha"];
    expect(withScript(argv, false, "ignored.js")).toBe(argv);
  });

  it("get a stand-in for the script when the app is packaged, so the first argument is not lost", () => {
    const argv = ["/Applications/Make-It-So.app/Contents/MacOS/Make-It-So", "--ship", "alpha"];
    const fixed = withScript(argv, true, "/app/dist/electron/main.js");
    expect(fixed).toEqual(["/Applications/Make-It-So.app/Contents/MacOS/Make-It-So", "/app/dist/electron/main.js", "--ship", "alpha"]);
    // the two readers of argv.slice(2) see the ship and the mode
    expect(parseShipArg(fixed.slice(2))).toBe("alpha");
    expect(chooseStartMode(withScript(["/App", "--settings"], true, "main.js").slice(2), [])).toEqual({ kind: "settings" });
  });
});
