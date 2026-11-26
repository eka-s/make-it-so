import { useCallback, useEffect, useState } from "react";
import { useNarrowWindow } from "./layout-mode";
import { loadStoredMemoryOpen, persistMemoryOpen } from "./preferences";

/**
 * Whether the Memory pane (on the right) is open. It is saved, so the pane is where it was left after a reload. In a narrow window
 * (NARROW_WIDTH) it covers the whole body of the page instead of sitting beside the conversation (see MemoryPane.css), and Escape closes it.
 */
export function useMemoryPane(leftDrawerShown: boolean) {
  const narrow = useNarrowWindow();
  const [open, setOpen] = useState(loadStoredMemoryOpen);

  const set = useCallback((next: boolean) => {
    persistMemoryOpen(next);
    setOpen(next);
  }, []);
  const toggle = useCallback(() => set(!open), [open, set]);
  const close = useCallback(() => set(false), [set]);

  // Escape closes what covers the page, after what else uses it (a popup, a menu): those take it by calling preventDefault.
  useEffect(() => {
    if (!open || !narrow) return;
    // The left drawer opens over the pane and takes the key first; in a search box Escape clears what was typed.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || leftDrawerShown) return;
      if (e.target instanceof HTMLInputElement && e.target.value !== "") return;
      set(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow, leftDrawerShown, set]);

  return { open, covers: narrow, toggle, close };
}
