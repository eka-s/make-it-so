import { useEffect, type RefObject } from "react";
import { api } from "./server-api";
import { inDesktop } from "./shell";

/**
 * The desktop app needs to know about the header to size its window: how wide the window has to be (the header's room at both ends, which changes with the
 * theme) and, on macOS, where the window buttons go (the header is the title bar and they sit over it, in screen points, which a page zoom does not scale: the
 * app keeps them in the middle of the header's height). It answers with the page's zoom, which the minimum width follows on every system; on macOS
 * the room kept for the buttons is divided by it (`--shell-zoom`, desktop-shell.css) to stay the same size on the screen. The zoom comes from the app,
 * which knows it exactly; working it out from the widths in the page is wrong while the window is being resized.
 * Reported when the header first shows and whenever the header or the page's area changes size (a zoom changes the area).
 */
export function useShellWindow(header: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = header.current;
    if (!element || !inDesktop()) return;
    let latest = 0;
    let reported = "";
    const report = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      const style = getComputedStyle(element);
      const room = Math.round(parseFloat(style.paddingLeft) + parseFloat(style.paddingRight));
      // Resizing the window fires this on every frame, and it matters only when the header, the room or the zoom changed (a zoom changes the pixel ratio).
      const key = `${height}:${room}:${window.devicePixelRatio}`;
      if (key === reported) return;
      reported = key;
      const sequence = ++latest;
      api.reportShellWindow({ height, room })
        .then(async (res) => {
          if (!res.ok || sequence !== latest) return; // a newer report is on its way: its answer is the one to use
          const { zoom } = await res.json();
          document.documentElement.style.setProperty("--shell-zoom", String(zoom));
        })
        .catch(() => { reported = ""; }); // not delivered: the same state is reported again next time
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    window.addEventListener("resize", report);
    report();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [header]);
}
