import { useCallback, useEffect, useState } from "react";
import type { RefObject } from "react";
import "./ScrollEdgeButtons.css";
import { scrollEdges } from "./scroll-edges";
import { animateScrollTo } from "./smooth-scroll";
import { useT } from "./i18n/I18nProvider";

type ScrollEdgeButtonsProps = {
  /** The scrolling area (the conversation display). */
  containerRef: RefObject<HTMLElement | null>;
};

// "To the very top" and "to the very bottom" buttons floating at the bottom right of the conversation display. Faint normally, and darker when the mouse is over them.
// When at the very bottom only the up button is shown, and when at the very top only the down button (when the content fits and
// cannot scroll, neither is shown). The position is re-checked on every scroll, change of the area's size, and change of content (a message added, or
// the body growing while streaming).
export function ScrollEdgeButtons({ containerRef }: ScrollEdgeButtonsProps) {
  const t = useT();
  const [edges, setEdges] = useState({ atTop: true, atBottom: true });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const next = scrollEdges(container);
      // If nothing changed, keep the same reference (no needless re-render)
      setEdges((prev) => (prev.atTop === next.atTop && prev.atBottom === next.atBottom ? prev : next));
    };
    // Even if called several times in one frame, it is merged into one
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    update();
    container.addEventListener("scroll", schedule, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(container);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      container.removeEventListener("scroll", schedule);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, [containerRef]);

  const scrollTo = useCallback((top: "top" | "bottom") => {
    const container = containerRef.current;
    if (!container) return;
    // Moves with our own animation, faster than the built-in smooth scroll (smooth-scroll.ts)
    void animateScrollTo(container, top === "top" ? 0 : container.scrollHeight - container.clientHeight);
  }, [containerRef]);

  if (edges.atTop && edges.atBottom) return null;

  return (
    <div className="scroll-edge-buttons">
      {!edges.atTop && (
        <button className="scroll-edge-btn" onClick={() => scrollTo("top")} title={t("chat.scrollTop")} aria-label={t("chat.scrollTop")}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 10 L7 5 L12 10" />
          </svg>
        </button>
      )}
      {!edges.atBottom && (
        <button className="scroll-edge-btn" onClick={() => scrollTo("bottom")} title={t("chat.scrollBottom")} aria-label={t("chat.scrollBottom")}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 4 L7 9 L12 4" />
          </svg>
        </button>
      )}
    </div>
  );
}
