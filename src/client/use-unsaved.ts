import { useEffect, useRef } from "react";

// The settings forms keep what is typed in their own state. This lets a form say "something typed is not saved yet", so that the
// screen can ask before that is thrown away (switching tabs, closing the page).

/** What a form registers: whether it has unsaved input. Read when the person tries to leave. */
export type DirtyRegistry = { current: () => boolean };

/** Registers `isDirty` for as long as the form is shown. */
export function useRegisterDirty(registry: DirtyRegistry | undefined, isDirty: boolean): void {
  const latest = useRef(isDirty);
  latest.current = isDirty;
  useEffect(() => {
    if (!registry) return;
    registry.current = () => latest.current;
    return () => { registry.current = () => false; };
  }, [registry]);
}

/** Asks before unsaved input is discarded. Returns whether to go on. */
export function confirmDiscard(isDirty: boolean, message: string): boolean {
  return !isDirty || window.confirm(message);
}
