import type { OverviewShip } from "../server/settings/settings-overview.js";
import { isShipId } from "../server/ship-id.js";
import { renderLauncherPage, renderOpeningPage, type LauncherLanguage } from "./launcher-page.js";

export type LauncherDeps = {
  /** The ships as they are now: read for every request, so a ship made meanwhile is there. */
  readShips: () => OverviewShip[];
  language: LauncherLanguage;
  openShip: (id: string) => void;
  openSettings: () => void;
  /** The choice was handed to another process: the list has done its work. */
  onHandedOver: () => void;
};

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

/**
 * What the ship list answers: the list itself, `POST /open` (the form button of one ship) and `POST /settings`. Only a ship that exists, can be read and has
 * a name that is a ship ID is started: the form is only a page, and what it sends is not trusted.
 */
export function createLauncherHandler(deps: LauncherDeps): (request: Request) => Promise<Response> {
  const handOver = (start: () => void): Response => {
    start();
    deps.onHandedOver();
    return html(renderOpeningPage(deps.language));
  };
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/open") {
      const id = new URLSearchParams(await request.text()).get("ship");
      if (id === null || !isShipId(id) || !deps.readShips().some((ship) => ship.id === id && !ship.error)) return new Response("unknown ship", { status: 400 });
      return handOver(() => deps.openShip(id));
    }
    if (request.method === "POST" && path === "/settings") return handOver(deps.openSettings);
    return html(renderLauncherPage({ ships: deps.readShips(), language: deps.language }));
  };
}
