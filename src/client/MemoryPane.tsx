import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import "./MemoryPane.css";
import { useT } from "./i18n/I18nProvider";
import { markdownComponents } from "./markdown";
import { loadStoredMemoryLayout, loadStoredNumber, persistMemoryLayout, persistNumber, type MemoryLayout } from "./preferences";
import { classifyMemoryLink } from "./memory-link";
import { useMemory } from "./use-memory";
import type { MemorySummary } from "./types";

// The ship's Memory, for the captain to read (the crew writes it through MCP tools): a list (the tree of directories, or the results of a
// search) and the memo that is selected, stacked or side by side. What is listed comes from the server as it is shown; a link in a memo is read against the memo it is in (memory-link.ts).

const WIDTH_STORAGE_KEY = "memory-pane-width";
const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.25;
const MAX_RATIO = 0.75;

// How much of the pane the list takes (the rest is the memo); one share for each layout, as the two cut different lengths.
const INDEX_DEFAULT_RATIO = 0.4;
const INDEX_MIN_RATIO = 0.15;
const INDEX_MAX_RATIO = 0.85;
const indexKey = (layout: MemoryLayout) => `memory-index-ratio-${layout}`;

function storedIndexRatio(layout: MemoryLayout): number {
  const saved = loadStoredNumber(indexKey(layout));
  return saved === null ? INDEX_DEFAULT_RATIO : Math.min(INDEX_MAX_RATIO, Math.max(INDEX_MIN_RATIO, saved));
}

function storedRatio(): number {
  const saved = loadStoredNumber(WIDTH_STORAGE_KEY);
  return saved === null ? DEFAULT_RATIO : Math.min(MAX_RATIO, Math.max(MIN_RATIO, saved));
}

type Props = {
  open: boolean;
  /** Covers the whole body of the page (a narrow window) instead of sitting beside the conversation. */
  covers: boolean;
  onClose: () => void;
  /** Something is open over the pane (the left drawer): the pane takes no keys or clicks. */
  inert?: boolean;
  /** The button that opens the pane: where the focus goes when the pane is closed. */
  returnFocusRef: React.RefObject<HTMLElement>;
  /** Changes whenever the server says the Memory changed. */
  changeSignal: number;
};

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function MemoryPane({ open, covers, inert = false, onClose, returnFocusRef, changeSignal }: Props) {
  const t = useT();
  const [ratio, setRatio] = useState(storedRatio);
  const [dragging, setDragging] = useState(false);
  const [layout, setLayout] = useState<MemoryLayout>(loadStoredMemoryLayout);
  const [indexRatios, setIndexRatios] = useState<Record<MemoryLayout, number>>(() => ({ stack: storedIndexRatio("stack"), side: storedIndexRatio("side") }));
  const [splitDragging, setSplitDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const [showDraft, setShowDraft] = useState(true);
  const [showDeprecated, setShowDeprecated] = useState(true);
  const [query, setQuery] = useState("");
  const [showFront, setShowFront] = useState(false);
  const paneRef = useRef<HTMLElement>(null);
  const memory = useMemory({ open, changeSignal, showDraft, showDeprecated, query });
  const { select } = memory;
  const selectedPath = memory.docState.status === "ready" ? memory.docState.doc.path : null;

  // The header is closed again for the next memo, and a hidden pane takes its focus with it: it goes back to the button that opens the pane.
  useEffect(() => { setShowFront(false); }, [selectedPath]);
  useLayoutEffect(() => {
    if (open) return;
    if (paneRef.current?.contains(document.activeElement)) returnFocusRef.current?.focus();
  }, [open, returnFocusRef]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const body = paneRef.current?.parentElement;
      if (!body) return;
      const rect = body.getBoundingClientRect();
      setRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, (rect.right - e.clientX) / rect.width)));
    };
    const onUp = () => {
      setDragging(false);
      setRatio((r) => { persistNumber(WIDTH_STORAGE_KEY, r); return r; });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!splitDragging) return;
    const onMove = (e: MouseEvent) => {
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      const share = layout === "stack" ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
      setIndexRatios((r) => ({ ...r, [layout]: Math.min(INDEX_MAX_RATIO, Math.max(INDEX_MIN_RATIO, share)) }));
    };
    const onUp = () => {
      setSplitDragging(false);
      setIndexRatios((r) => { persistNumber(indexKey(layout), r[layout]); return r; });
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [splitDragging, layout]);

  const toggleLayout = () => {
    const next: MemoryLayout = layout === "stack" ? "side" : "stack";
    persistMemoryLayout(next);
    setLayout(next);
  };

  // What a link does is decided from the memo shown (see memory-link.ts): another memo opens in the pane, a web address in a new tab, anything else is text.
  const components: Components = {
    ...markdownComponents,
    a: ({ href, children }) => {
      const link = classifyMemoryLink(selectedPath ?? "", href);
      if (link.kind === "memo") return <a href={href} onClick={(e) => { e.preventDefault(); select(link.path); }}>{children}</a>;
      if (link.kind === "external") return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
      return <span>{children}</span>;
    },
  };

  const row = useCallback((doc: MemorySummary, depth: number) => (
    <li key={doc.path}>
      <button
        type="button"
        className={`memory-row ${memory.selected === doc.path ? "memory-row--selected" : ""} ${doc.status === "deprecated" ? "memory-row--deprecated" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => select(doc.path)}
        title={doc.description}
      >
        <span className="memory-row-title">{doc.title || fileName(doc.path)}</span>
        {doc.status !== "stable" && <span className={`memory-chip memory-chip--${doc.status}`}>{t(`memory.status.${doc.status}`)}</span>}
      </button>
    </li>
  ), [memory.selected, select, t]);

  const renderDir = (dir: string, depth: number): React.ReactNode => {
    const browse = memory.trees[dir];
    if (!browse) return null;
    return (
      <>
        {browse.dirs.map((child) => {
          const isOpen = memory.expanded.has(child.path);
          return (
            <li key={`dir:${child.path}`}>
              <button type="button" className="memory-row memory-row--dir" style={{ paddingLeft: `${8 + depth * 14}px` }} onClick={() => memory.toggleDir(child.path)} aria-expanded={isOpen}>
                <span className="memory-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                <span className="memory-row-title">{child.name}</span>
                <span className="memory-count">{child.count}</span>
              </button>
              {isOpen && <ul className="memory-list">{renderDir(child.path, depth + 1)}</ul>}
            </li>
          );
        })}
        {browse.docs.map((doc) => row(doc, depth))}
      </>
    );
  };

  const root = memory.trees[""];
  const empty = root !== undefined && root.dirs.length === 0 && root.docs.length === 0;
  const doc = memory.docState.status === "ready" ? memory.docState.doc : null;
  const when = doc?.updatedAt ? new Date(doc.updatedAt).toLocaleString() : "";

  return (
    <aside
      id="memory-pane"
      ref={paneRef}
      className={`memory-pane ${open ? "" : "memory-pane--hidden"} ${covers ? "memory-pane--covers" : ""} ${dragging || splitDragging ? "memory-pane--dragging" : ""}`}
      style={covers ? undefined : { width: `${ratio * 100}%` }}
      aria-label={t("memory.title")}
      {...(inert ? { inert: "" } : {})}
    >
      {!covers && (
        <div className="memory-resize-handle" onMouseDown={(e) => { e.preventDefault(); setDragging(true); }} title={t("memory.resize")} aria-label={t("memory.resize")} role="separator" aria-orientation="vertical" />
      )}
      <div className="memory-header">
        <h2 className="memory-title">{t("memory.title")}</h2>
        <label className="memory-toggle"><input type="checkbox" checked={showDraft} onChange={(e) => setShowDraft(e.target.checked)} />{t("memory.showDraft")}</label>
        <label className="memory-toggle"><input type="checkbox" checked={showDeprecated} onChange={(e) => setShowDeprecated(e.target.checked)} />{t("memory.showDeprecated")}</label>
        <button type="button" className="memory-btn" onClick={toggleLayout} title={t("memory.layout.toggle")} aria-label={t("memory.layout.toggle")}>
          <svg className="app-icon" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="2" y="2" width="12" height="12" rx="1.5" />
            {layout === "stack" ? <line x1="2" y1="8" x2="14" y2="8" /> : <line x1="8" y1="2" x2="8" y2="14" />}
          </svg>
        </button>
        <button type="button" className="memory-btn" onClick={onClose} title={t("memory.close")} aria-label={t("memory.close")}>×</button>
      </div>

      <div ref={splitRef} className={`memory-split memory-split--${layout}`}>
        <section className="memory-index" aria-label={t("memory.list.label")} style={{ flexBasis: `${indexRatios[layout] * 100}%` }}>
          <input
            className="memory-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("memory.search.placeholder")}
            aria-label={t("memory.search.label")}
          />
          <div className="memory-index-body">
            {memory.treeFailed && <p className="memory-note">{t("memory.loadFailed")}</p>}
            {memory.results !== null ? (
              memory.results.items.length === 0 ? <p className="memory-note">{t("memory.noResults")}</p> : (
                <>
                  <ul className="memory-list">{memory.results.items.map((doc) => row(doc, 0))}</ul>
                  {memory.results.total > memory.results.items.length && <p className="memory-note">{t("memory.moreResults", { shown: memory.results.items.length, total: memory.results.total })}</p>}
                </>
              )
            ) : empty ? (
              <p className="memory-note">{t("memory.empty")}</p>
            ) : (
              <ul className="memory-list">{renderDir("", 0)}</ul>
            )}
          </div>
        </section>

        <div
          className="memory-split-handle"
          onMouseDown={(e) => { e.preventDefault(); setSplitDragging(true); }}
          title={t("memory.splitResize")}
          aria-label={t("memory.splitResize")}
          role="separator"
          aria-orientation={layout === "stack" ? "horizontal" : "vertical"}
        />

        <section className="memory-content" aria-label={t("memory.doc.label")}>
          {memory.docState.status === "none" && <p className="memory-note">{t("memory.select")}</p>}
          {memory.docState.status === "missing" && <p className="memory-note">{t("memory.missing")}</p>}
          {memory.docState.status === "failed" && <p className="memory-note">{t("memory.loadFailed")}</p>}
          {doc && (
            <>
              <header className="memory-doc-head">
                <h3 className="memory-doc-title">{doc.title || fileName(doc.path)}</h3>
                <div className="memory-doc-meta">
                  {doc.status !== "stable" && <span className={`memory-chip memory-chip--${doc.status}`}>{t(`memory.status.${doc.status}`)}</span>}
                  {(doc.crew || when) && <span className="memory-written">{doc.crew && when ? t("memory.writtenBy", { crew: doc.crew, when }) : doc.crew || when}</span>}
                </div>
                <div className="memory-doc-path">{doc.path}</div>
                {doc.description && <p className="memory-doc-description">{doc.description}</p>}
                {doc.supersededBy && (
                  <p className="memory-doc-description">
                    {t("memory.supersededBy")}: <a href={doc.supersededBy} onClick={(e) => { e.preventDefault(); select(doc.supersededBy!); }}>{doc.supersededBy}</a>
                  </p>
                )}
                <button type="button" className="memory-link-btn" onClick={() => setShowFront((v) => !v)} aria-expanded={showFront}>
                  {showFront ? "▾" : "▸"} {t("memory.frontmatter")}
                </button>
                {showFront && <pre className="memory-frontmatter">{doc.frontmatter}</pre>}
              </header>
              <div className="markdown-body memory-doc-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{doc.body}</ReactMarkdown>
              </div>
            </>
          )}
        </section>
      </div>
    </aside>
  );
}
