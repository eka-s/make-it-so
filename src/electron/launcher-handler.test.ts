import { describe, expect, it, vi } from "vitest";
import { createLauncherHandler } from "./launcher-handler.js";

function setup(ships = [{ id: "alpha", name: "Alpha" }, { id: "beta" }, { id: "broken", error: "bad yaml" }]) {
  const openShip = vi.fn();
  const openSettings = vi.fn();
  const onHandedOver = vi.fn();
  const handle = createLauncherHandler({ readShips: () => ships, language: "en", openShip, openSettings, onHandedOver });
  return { handle, openShip, openSettings, onHandedOver };
}
const post = (path: string, body = "") => new Request(`app://launcher${path}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("the ship list's answers", () => {
  it("shows the ships as they are now", async () => {
    const { handle } = setup();
    const res = await handle(new Request("app://launcher/"));
    expect(res.headers.get("content-type")).toContain("text/html");
    const page = await res.text();
    expect(page).toContain("Alpha");
    expect(page).toContain('value="beta"');
  });

  it("starts the ship whose button was pressed, shows that it is opening, and says the list is done", async () => {
    const { handle, openShip, onHandedOver } = setup();
    const res = await handle(post("/open", "ship=alpha"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Opening");
    expect(openShip).toHaveBeenCalledWith("alpha");
    expect(onHandedOver).toHaveBeenCalledTimes(1);
  });

  it("starts nothing for a ship that does not exist, one whose file cannot be read, or a missing value", async () => {
    const { handle, openShip, onHandedOver } = setup();
    for (const body of ["ship=nope", "ship=broken", "", "other=alpha"]) expect((await handle(post("/open", body))).status).toBe(400);
    expect(openShip).not.toHaveBeenCalled();
    expect(onHandedOver).not.toHaveBeenCalled();
  });

  it("starts nothing for a name that is not a ship ID, even when a directory of that name exists (it would be read as a path or an option)", async () => {
    const { handle, openShip } = setup([{ id: "--inspect=127.0.0.1:9229" }, { id: "../x" }]);
    expect((await handle(post("/open", `ship=${encodeURIComponent("--inspect=127.0.0.1:9229")}`))).status).toBe(400);
    expect((await handle(post("/open", `ship=${encodeURIComponent("../x")}`))).status).toBe(400);
    expect(openShip).not.toHaveBeenCalled();
  });

  it("opens the settings", async () => {
    const { handle, openSettings, onHandedOver } = setup();
    expect((await handle(post("/settings"))).status).toBe(200);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(onHandedOver).toHaveBeenCalledTimes(1);
  });

  it("answers any other request with the list, and starts nothing for a GET of /open", async () => {
    const { handle, openShip, openSettings } = setup();
    expect(await (await handle(new Request("app://launcher/open?ship=alpha"))).text()).toContain("Choose a ship");
    expect(await (await handle(post("/elsewhere", "ship=alpha"))).text()).toContain("Choose a ship");
    expect(openShip).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
  });
});
