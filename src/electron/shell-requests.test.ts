import { describe, expect, it, vi } from "vitest";
import { WINDOW_PATH, withShellRequests } from "./shell-requests.js";

function setup() {
  const serve = vi.fn(async () => new Response("from the ship", { status: 200 }));
  const onReport = vi.fn(() => ({ zoom: 1.5 }));
  return { serve, onReport, handle: withShellRequests(serve, onReport) };
}
const post = (body: string, path = WINDOW_PATH) => new Request(`app://ship${path}`, { method: "POST", body });

describe("the page's reports to the window", () => {
  it("takes the header height and answers with the zoom, without bothering the ship", async () => {
    const { handle, serve, onReport } = setup();
    const res = await handle(post(JSON.stringify({ height: 40, room: 176 })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ zoom: 1.5 });
    expect(onReport).toHaveBeenCalledWith({ height: 40, room: 176 });
    expect(serve).not.toHaveBeenCalled();
  });

  it("refuses what cannot be a header height", async () => {
    const { handle, onReport } = setup();
    const bad = [
      "", "abc", "null", "[]", "{}",
      JSON.stringify({ height: "40", room: 176 }),
      JSON.stringify({ height: 3.5, room: 176 }),
      JSON.stringify({ height: 7, room: 176 }),
      JSON.stringify({ height: 601, room: 176 }),
      JSON.stringify({ height: 40 }),
      JSON.stringify({ height: 40, room: -1 }),
      JSON.stringify({ height: 40, room: 2001 }),
      JSON.stringify({ height: 40, room: 1.5 }),
      JSON.stringify({ height: 40, room: "176" }),
    ];
    for (const body of bad) expect((await handle(post(body))).status).toBe(400);
    expect(onReport).not.toHaveBeenCalled();
  });

  it("answers 405 to anything but POST", async () => {
    const { handle, onReport } = setup();
    expect((await handle(new Request(`app://ship${WINDOW_PATH}`))).status).toBe(405);
    expect(onReport).not.toHaveBeenCalled();
  });

  it("hands every other request to the ship", async () => {
    const { handle, serve } = setup();
    const res = await handle(new Request("app://ship/api/config"));
    expect(await res.text()).toBe("from the ship");
    expect(serve).toHaveBeenCalledTimes(1);
  });
});
