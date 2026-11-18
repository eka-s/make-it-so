import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./SearchPalette.css";
import { CrewIcon } from "./crewIcons";
import { PopupOpenButton } from "./PopupOpenButton";
import { api } from "./server-api";
import { GROUP_MODES, ancestorPaths, flattenGroups, groupHits, type GroupMode, type SearchGroup } from "./search-group";
import { animateScrollTo } from "./smooth-scroll";
import { dayStartIso, nextDayStartIso, resolveMissionIds, toggleMission, type MissionScope } from "./search-filters";
import { loadStoredSearchGroupMode, persistSearchGroupMode } from "./preferences";
import type { CrewMemberConfig, Mission, SearchHit, SearchResponse } from "./types";
import { useI18n } from "./i18n/I18nProvider";

type SearchPaletteProps = {
  open: boolean;
  missions: Mission[];
  activeMissionId: string;
  crewConfig: Record<string, CrewMemberConfig>;
  onClose: () => void;
  /** A result was chosen. The caller switches to that mission and moves to the message. */
  onJump: (hit: SearchHit) => void;
  /**
   * Button shown when the mouse is over a result: opens that message in a popup (the palette stays open).
   */
  onOpenPopup: (hit: SearchHit) => void;
};

const SEARCH_DELAY_MS = 300;

const GROUP_LABEL_KEYS = {
  mission: "search.group.mission",
  crew: "search.group.crew",
  "mission-crew": "search.group.missionCrew",
} as const;

/** Renders an excerpt with the matched parts highlighted. */
function SnippetText({ hit }: { hit: SearchHit }) {
  const { text, ranges, cutStart, cutEnd } = hit.snippet;
  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([from, to], i) => {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={i}>{text.slice(from, to)}</mark>);
    at = to;
  });
  if (at < text.length) parts.push(text.slice(at));
  return (
    <span className="search-snippet">
      {cutStart && "…"}
      {parts}
      {cutEnd && "…"}
    </span>
  );
}

// Conversation search (the palette). A wide popup at the center of the screen shows the search terms, conditions, and results. The results are what the server
// searched for and built excerpts of, simply arranged in the chosen "grouping". Even after reopening, the search terms, conditions, and results remain
// (even when closed, this component is not removed but only hidden).
export function SearchPalette({ open, missions, activeMissionId, crewConfig, onClose, onJump, onOpenPopup }: SearchPaletteProps) {
  const { t, tKey } = useI18n();
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [captain, setCaptain] = useState(true);
  const [replies, setReplies] = useState(true);
  const [tasks, setTasks] = useState(true);
  const [scope, setScope] = useState<MissionScope>({ kind: "current" });
  const [missionsOpen, setMissionsOpen] = useState(false);
  const [mode, setMode] = useState<GroupMode>(loadStoredSearchGroupMode);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  // Collapsed groups (`SearchGroup.path`). When new results arrive, everything is opened.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const groupRefs = useRef(new Map<string, HTMLElement>());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const missionIds = useMemo(
    () => resolveMissionIds(scope, activeMissionId, missions.map((m) => m.id)),
    [scope, activeMissionId, missions],
  );

  // When opened, focus the search field and select the previous search terms (to make retyping easy)
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  // Every time the conditions change, wait a little and then search (do not keep sending to the server until typing is finished)
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q === "" || missionIds.length === 0 || (!captain && !replies && !tasks)) {
      setResult(null);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus("loading");
      api.search(
        { q, missionIds, from: dayStartIso(from), to: nextDayStartIso(to), captain, replies, tasks },
        controller.signal,
      )
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          setResult((await res.json()) as unknown as SearchResponse);
          setCollapsed(new Set());
          setActiveIndex(0);
          setStatus("idle");
        })
        .catch((err) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setStatus("error");
        });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, from, to, captain, replies, tasks, missionIds]);

  const roleTitle = useCallback(
    (role: string) => (role === "captain" ? t("role.captain") : crewConfig[role]?.name ?? role),
    [crewConfig, t],
  );
  const groups = useMemo(() => groupHits(result?.hits ?? [], mode, roleTitle), [result, mode, roleTitle]);
  const flat = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);

  // If collapsing hides the selected result, go back to the first one
  useEffect(() => {
    if (activeIndex >= flat.length && activeIndex !== 0) setActiveIndex(0);
  }, [flat.length, activeIndex]);

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const allPaths = useMemo(() => {
    const collect = (list: SearchGroup[]): string[] => list.flatMap((g) => [g.path, ...collect(g.children)]);
    return collect(groups);
  }, [groups]);

  // Scrolls to that group from the link at the top (if it is collapsed, the parents are opened too).
  const goToGroup = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(path);
      for (const ancestor of ancestorPaths(path)) next.delete(ancestor);
      return next;
    });
    requestAnimationFrame(() => {
      const list = listRef.current;
      const el = groupRefs.current.get(path);
      if (!list || !el) return;
      const top = list.scrollTop + (el.getBoundingClientRect().top - list.getBoundingClientRect().top) - 4;
      void animateScrollTo(list, Math.max(0, top));
    });
  };

  // Bring the result selected with the keyboard into view
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".search-hit--active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, flat]);

  const changeMode = (next: GroupMode) => {
    setMode(next);
    setCollapsed(new Set());
    persistSearchGroupMode(next);
    setActiveIndex(0);
  };

  const jump = (hit: SearchHit) => {
    onJump(hit);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" && flat.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp" && flat.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter" && flat[activeIndex] && e.target === inputRef.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      jump(flat[activeIndex]);
    }
  };

  const missionSummary =
    scope.kind === "current"
      ? t("search.missions.summary.current")
      : missionIds.length === 0
        ? t("search.missions.none")
        : t("search.missions.summary.count", { count: missionIds.length });

  const renderHit = (hit: SearchHit, showMission: boolean, showCrew: boolean) => {
    const index = flat.indexOf(hit);
    const info = hit.role === "captain" ? undefined : crewConfig[hit.role];
    const kindKey = hit.kind === "task" ? (hit.matchedIn === "instruction" ? "search.kind.instruction" : "search.kind.report") : null;
    return (
      <div key={`${hit.missionId}:${hit.id}`} className="popup-row">
      <button
        type="button"
        className={`search-hit ${index === activeIndex ? "search-hit--active" : ""}`}
        onClick={() => jump(hit)}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <div className="search-hit-meta">
          {showCrew && (
            <span className="search-hit-who">
              {hit.role !== "captain" && <CrewIcon name={roleTitle(hit.role)} iconUrl={info?.icon} size={14} />}
              {roleTitle(hit.role)}
            </span>
          )}
          <span className="search-hit-time">{new Date(hit.timestamp).toLocaleString()}</span>
          {kindKey && <span className="search-hit-kind">{tKey(kindKey, kindKey)}</span>}
          {showMission && <span className="search-hit-mission">{hit.missionName}</span>}
        </div>
        <SnippetText hit={hit} />
      </button>
      <PopupOpenButton onClick={() => onOpenPopup(hit)} />
      </div>
    );
  };

  // `index` is the order within the same parent (the background color is changed slightly between odd and even)
  const renderGroup = (group: SearchGroup, depth: number, index: number) => {
    const isCollapsed = collapsed.has(group.path);
    return (
      <section
        key={group.path}
        ref={(el) => {
          if (el) groupRefs.current.set(group.path, el);
          else groupRefs.current.delete(group.path);
        }}
        className={`search-group search-group--depth${depth} ${index % 2 === 0 ? "search-group--even" : "search-group--odd"}`}
      >
        <button
          type="button"
          className="search-group-title"
          onClick={() => toggleGroup(group.path)}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? t("search.group.expand") : t("search.group.collapse")}
        >
          <span className="search-group-chevron" aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
          <span className="search-group-name">{group.title}</span>
          <span className="search-group-count">{group.count}</span>
        </button>
        {!isCollapsed && (
          <>
            {group.hits.map((hit) =>
              // In the by-mission grouping the heading is the mission, so the results show the crew member. In the by-crew grouping and the sub-headings,
              // the heading is the crew member, so the results show the mission (for the by-crew grouping)
              renderHit(hit, mode === "crew", mode === "mission"),
            )}
            {group.children.map((child, i) => renderGroup(child, depth + 1, i))}
          </>
        )}
      </section>
    );
  };

  // The table of contents fixed at the top (does not scroll): links to each group. For mission × crew, each mission's row lines up the mission and the links to its crew members
  const navigable = groups.length + groups.reduce((sum, g) => sum + g.children.length, 0) > 1;
  const renderNav = () => (
    <nav className="search-nav" aria-label={t("search.nav")}>
      {(mode === "mission-crew" ? groups : [null]).map((parent) => (
        <div className="search-nav-row" key={parent?.path ?? "top"}>
          {(parent ? [parent, ...parent.children] : groups).map((g, i) => (
            <button
              key={g.path}
              type="button"
              className={`search-nav-chip ${parent && i === 0 ? "search-nav-chip--parent" : ""}`}
              onClick={() => goToGroup(g.path)}
              title={g.title}
            >
              <span className="search-nav-name">{g.title}</span> <span className="search-nav-count">{g.count}</span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className={`search-backdrop ${open ? "" : "search-backdrop--hidden"}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-popup" role="dialog" aria-modal="true" aria-label={t("search.title")} onKeyDown={handleKeyDown}>
        <header className="search-header">
          <span className="search-header-title">{t("search.title")}</span>
          <button className="search-close" onClick={onClose} aria-label={t("search.close")} title={t("search.close")}>×</button>
        </header>

        <div className="search-controls">
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            value={query}
            placeholder={t("search.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />

          <div className="search-filters">
            <div className="search-filter">
              <span className="search-filter-label">{t("search.period")}</span>
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label={t("search.from")} />
              <span>〜</span>
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label={t("search.to")} />
            </div>
            <div className="search-filter">
              <span className="search-filter-label">{t("search.include")}</span>
              <label><input type="checkbox" checked={captain} onChange={(e) => setCaptain(e.target.checked)} /> {t("search.include.captain")}</label>
              <label><input type="checkbox" checked={replies} onChange={(e) => setReplies(e.target.checked)} /> {t("search.include.replies")}</label>
              <label><input type="checkbox" checked={tasks} onChange={(e) => setTasks(e.target.checked)} /> {t("search.include.tasks")}</label>
            </div>
            <div className="search-filter">
              <span className="search-filter-label">{t("search.missions")}</span>
              <button type="button" className="search-chip" onClick={() => setMissionsOpen((v) => !v)} aria-expanded={missionsOpen}>
                {missionSummary} {missionsOpen ? "▴" : "▾"}
              </button>
            </div>
            {missionsOpen && (
              <div className="search-missions">
                <div className="search-missions-actions">
                  <button type="button" className="search-chip" onClick={() => setScope({ kind: "current" })}>{t("search.missions.current")}</button>
                  <button type="button" className="search-chip" onClick={() => setScope({ kind: "custom", ids: missions.map((m) => m.id) })}>{t("search.missions.all")}</button>
                </div>
                <div className="search-missions-list">
                  {missions.map((m) => (
                    <label key={m.id} className={m.archivedAt ? "search-mission--archived" : ""}>
                      <input
                        type="checkbox"
                        checked={missionIds.includes(m.id)}
                        onChange={() => setScope((s) => toggleMission(s, activeMissionId, m.id))}
                      />{" "}
                      {m.name}
                      {m.archivedAt ? ` ${t("search.missions.archived")}` : ""}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="search-filter">
              <span className="search-filter-label">{t("search.group")}</span>
              <div className="search-segmented" role="group" aria-label={t("search.group")}>
                {GROUP_MODES.map((m) => (
                  <button key={m} type="button" className={`search-segment ${m === mode ? "search-segment--on" : ""}`} aria-pressed={m === mode} onClick={() => changeMode(m)}>
                    {t(GROUP_LABEL_KEYS[m])}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="search-results-pane">
          {/*
             The count, "collapse all", and the table of contents do not move when the results are scrolled (only the list of results below scrolls)
             */}
          {result && status !== "error" && (
            <div className="search-results-fixed">
              <div className="search-summary-row">
                <p className="search-summary">
                  {result.total === 0
                    ? t("search.empty")
                    : result.truncated
                      ? t("search.truncated", { total: result.total, shown: result.hits.length })
                      : t("search.count", { total: result.total })}
                </p>
                {groups.length > 0 && (
                  <span className="search-bulk">
                    <button type="button" className="search-bulk-btn" onClick={() => setCollapsed(new Set(allPaths))}>{t("search.group.collapseAll")}</button>
                    <button type="button" className="search-bulk-btn" onClick={() => setCollapsed(new Set())}>{t("search.group.expandAll")}</button>
                  </span>
                )}
              </div>
              {navigable && renderNav()}
            </div>
          )}
          <div className="search-results" ref={listRef}>
            {query.trim() === "" && <p className="search-note">{t("search.hint")}</p>}
            {query.trim() !== "" && missionIds.length === 0 && <p className="search-note">{t("search.missions.none")}</p>}
            {status === "loading" && <p className="search-note">{t("search.searching")}</p>}
            {status === "error" && <p className="search-note search-note--error">{t("search.error")}</p>}
            {result && status !== "error" && groups.map((g, i) => renderGroup(g, 0, i))}
          </div>
        </div>
      </div>
    </div>
  );
}
