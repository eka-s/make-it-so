import { useCallback, useEffect, useState } from "react";
import { api } from "./server-api";
import type { MemoryBrowse, MemoryDocument, MemorySummary } from "./types";

// What the Memory pane shows, fetched from the server (which decides what is listed): the directories
// that are open, the memo that is selected, and the results of a search. Everything is fetched again when the server says the Memory
// changed (`changeSignal`), and while the pane is closed nothing is fetched.

export type MemoryDocState = { status: "none" } | { status: "loading" } | { status: "missing" } | { status: "failed" } | { status: "ready"; doc: MemoryDocument };

type Options = {
  open: boolean;
  /** Changes whenever the server says the Memory changed. */
  changeSignal: number;
  showDraft: boolean;
  showDeprecated: boolean;
  query: string;
};

const SEARCH_DELAY_MS = 250;

export function useMemory({ open, changeSignal, showDraft, showDeprecated, query }: Options) {
  const [trees, setTrees] = useState<Record<string, MemoryBrowse>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [treeFailed, setTreeFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [docState, setDocState] = useState<MemoryDocState>({ status: "none" });
  const [results, setResults] = useState<{ items: MemorySummary[]; total: number } | null>(null);
  const trimmed = query.trim();

  // The root and every open directory, fetched together so the tree never shows a mix of old and new.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const dirs = ["", ...expanded];
    Promise.all(dirs.map(async (dir) => {
      const res = await api.getMemoryTree({ dir, draft: showDraft, deprecated: showDeprecated }, controller.signal);
      if (!res.ok) return [dir, null] as const;
      return [dir, (await res.json()) as MemoryBrowse] as const;
    })).then((entries) => {
      const next: Record<string, MemoryBrowse> = {};
      for (const [dir, browse] of entries) if (browse) next[dir] = browse;
      setTrees(next);
      setTreeFailed(next[""] === undefined);
    }).catch(() => { if (!controller.signal.aborted) setTreeFailed(true); });
    return () => controller.abort();
  }, [open, changeSignal, showDraft, showDeprecated, expanded]);

  useEffect(() => {
    if (!open || selected === null) {
      setDocState({ status: "none" });
      return;
    }
    const controller = new AbortController();
    api.getMemoryDoc(selected, controller.signal).then(async (res) => {
      if (res.status === 404) setDocState({ status: "missing" });
      else if (!res.ok) setDocState({ status: "failed" });
      else setDocState({ status: "ready", doc: (await res.json()) as MemoryDocument });
    }).catch(() => { if (!controller.signal.aborted) setDocState({ status: "failed" }); });
    return () => controller.abort();
  }, [open, selected, changeSignal]);

  useEffect(() => {
    if (!open || trimmed === "") {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchMemory({ q: trimmed, draft: showDraft, deprecated: showDeprecated }, controller.signal).then(async (res) => {
        setResults(res.ok ? ((await res.json()) as { items: MemorySummary[]; total: number }) : { items: [], total: 0 });
      }).catch(() => { if (!controller.signal.aborted) setResults({ items: [], total: 0 }); });
    }, SEARCH_DELAY_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, trimmed, changeSignal, showDraft, showDeprecated]);

  const toggleDir = useCallback((dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });
  }, []);

  // A path may come with a leading "/" (how the server writes a link inside the Memory).
  const select = useCallback((path: string) => setSelected(path.replace(/^\//, "")), []);

  return { trees, expanded, toggleDir, treeFailed, selected, select, docState, results };
}
