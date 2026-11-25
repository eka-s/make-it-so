import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNarrowWindow } from "./layout-mode";
import { loadStoredLeftPaneOpen, persistLeftPaneOpen } from "./preferences";

/**
 * The left pane's visibility. In a wide window it is beside the conversation and shown or hidden as chosen (saved). In a narrow one (NARROW_WIDTH) it is a drawer over the
 * conversation, closed at first and not saved: what was chosen for the wide window is kept for when the window is wide again.
 */
export function useLeftPane() {
  const narrow = useNarrowWindow();
  const [wideOpen, setWideOpen] = useState(loadStoredLeftPaneOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const shown = narrow ? drawerOpen : wideOpen;
  const drawerShown = narrow && drawerOpen;

  useEffect(() => { if (!narrow) setDrawerOpen(false); }, [narrow]);

  // A hidden pane takes its focus with it (the browser drops it on the page). It goes back to the button that shows the pane, which is where the person was.
  useLayoutEffect(() => {
    if (shown) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".left-column")) toggleRef.current?.focus();
  }, [shown]);

  // Escape closes the drawer, after what else uses it (a popup, a menu, the search): those take it by calling preventDefault, and a window listener runs after theirs.
  useEffect(() => {
    if (!drawerShown) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) setDrawerOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerShown]);

  const toggle = useCallback(() => {
    if (narrow) {
      setDrawerOpen((open) => !open);
      return;
    }
    setWideOpen((open) => {
      persistLeftPaneOpen(!open);
      return !open;
    });
  }, [narrow]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return { shown, drawer: narrow, drawerShown, toggle, closeDrawer, toggleRef };
}
