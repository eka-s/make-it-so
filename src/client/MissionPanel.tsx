import { useState, useRef, useCallback, useEffect } from "react";
import "./MissionPanel.css";
import type { Mission } from "./types";
import { useT } from "./i18n/I18nProvider";
import { loadStoredNumber, persistNumber } from "./preferences";
import { matchesFilter } from "./mission-filter";
import { animateScrollTo, scrollTopToReveal } from "./smooth-scroll";

const MIN_HEIGHT = 80;
const HEIGHT_STORAGE_KEY = "left-section-height-mission";

type MissionPanelProps = {
  missions: Mission[];
  activeMissionId: string;
  onSelect: (missionId: string) => void;
  onCreate: (name: string) => Promise<void>;
  onArchive: (missionId: string, archived: boolean) => Promise<void>;
  // Number of pending approvals per mission (a mission with none counts as 0).
  pendingByMission: Record<string, number>;
  // A signal for when another mission was switched to, e.g. by search (every time tick changes, that mission's row is made to glow).
  // If the list is open and the row is out of view, it is scrolled into view first and then made to glow.
  flash?: { missionId: string; tick: number } | null;
};

// How long the row glows (milliseconds). Slightly longer than the mission-flash animation in MissionPanel.css.
const FLASH_MS = 2600;

// Display, switching, and creation of missions (= the boundary of a conversation).
// The heading is always the fixed "Missions" (unlike other sections, it does not show a dynamic current value). When collapsed, only the one selected mission is shown, and
// opening with ▼ reveals the other missions and the "+ New mission" button — selecting or
// creating does not close it automatically (opening/closing is controlled only by clicking ▼). While open,
// the height can be changed by dragging the handle at the bottom edge (the same idea as CollapsibleSection.tsx).
// It has its own open/close logic, different from CollapsibleSection's generic behavior of "hide all the content when closed",
// so it is built by hand here instead of using the shared component (the look classes share CollapsibleSection.css).
export function MissionPanel({ missions, activeMissionId, onSelect, onCreate, onArchive, pendingByMission, flash }: MissionPanelProps) {
  const t = useT();
  // The heading shows the total of pending approvals across all missions (so that it is noticed even when closed. The same as the number in the tab)
  const totalPending = Object.values(pendingByMission).reduce((sum, n) => sum + n, 0);
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [height, setHeight] = useState<number | null>(() => loadStoredNumber(HEIGHT_STORAGE_KEY));
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const maxHeightRef = useRef(Infinity);
  const lastHeightRef = useRef(MIN_HEIGHT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // The mission that is glowing now
  const [flashingId, setFlashingId] = useState<string | null>(null);

  const cancelCreate = useCallback(() => {
    setIsCreating(false);
    setNewName("");
    setError(null);
  }, []);

  // When the signal arrives, scroll that mission's row into view (if it is out of view) and then make it glow.
  // When collapsed, only the one selected mission is visible, so no scrolling is needed; it just glows.
  const flashTick = flash?.tick ?? 0;
  const flashMissionId = flash?.missionId;
  useEffect(() => {
    if (flashTick === 0 || !flashMissionId) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-mission-id="${CSS.escape(flashMissionId)}"]`);
    if (!list || !row) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listRect = list.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const fullyVisible = rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom;
    const arrived = fullyVisible
      ? Promise.resolve(true)
      : animateScrollTo(
          list,
          scrollTopToReveal(
            { scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, top: listRect.top },
            { top: rowRect.top, height: rowRect.height },
          ),
        ).finished;
    void arrived.then(() => {
      if (cancelled) return;
      setFlashingId(flashMissionId);
      timer = setTimeout(() => setFlashingId(null), FLASH_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [flashTick, flashMissionId]);

  // When closed, the search field is reset too (the next time it opens it always starts with everything shown).
  useEffect(() => {
    if (!isOpen) setFilterText("");
  }, [isOpen]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    // While height is null (open at the natural height), measure the height actually rendered now
    // and use it as the starting value.
    const current = height ?? bodyRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    startHeightRef.current = current;
    // Prevent it from being widened beyond the height at which the whole list (mission-panel-list) is visible
    // — the list's current scroll difference (scrollHeight-clientHeight) added to the height
    // of the dragged body itself is fixed as the upper limit during this operation (the same idea as CollapsibleSection.tsx).
    const list = listRef.current;
    maxHeightRef.current = list ? current + Math.max(0, list.scrollHeight - list.clientHeight) : Infinity;
  }, [height]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startYRef.current;
      const uncapped = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      const next = Math.min(maxHeightRef.current, uncapped);
      lastHeightRef.current = next;
      setHeight(next);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      persistNumber(HEIGHT_STORAGE_KEY, lastHeightRef.current);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await onCreate(trimmed);
      cancelCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mission.createFailed"));
    }
  }, [newName, onCreate, cancelCreate, t]);

  const handleArchiveToggle = useCallback((missionId: string, archived: boolean) => {
    // The selected mission cannot be archived (the button is disabled too,
    // but it is rejected here as well just in case). Restoring (archived=false) is allowed even for the selected one.
    if (archived && missionId === activeMissionId) return;
    void onArchive(missionId, archived).catch((err) => {
      console.error("[Mission] Failed to update archive state:", err);
    });
  }, [onArchive, activeMissionId]);

  const activeMission = missions.find((m) => m.id === activeMissionId);
  // The list shown while open. It keeps the natural order (the order of the missions array) and
  // does not pull the active mission to the top — putting the active one first when collapsed is
  // a measure so that "the selected one is visible when closed"; while open, not moving the order makes things easier to find.
  //
  // The selected mission always stays in the list regardless of either the search or the archive-hiding filter
  // — so that the one open now does not disappear from the list.
  const visibleMissions = missions.filter((m) => {
    if (m.id === activeMissionId) return true;
    return (showArchived || !m.archivedAt) && matchesFilter(m.name, filterText);
  });

  // The display of one row used by both the active one and the other lists (the archive button
  // only while open, and when collapsed only the selected mission's name).
  const renderMissionItem = (mission: Mission, isCurrent: boolean) => (
    <div
      key={mission.id}
      data-mission-id={mission.id}
      className={`mission-panel-item ${isCurrent ? "mission-panel-item--current" : ""} ${mission.archivedAt ? "mission-panel-item--archived" : ""} ${mission.id === flashingId ? "mission-panel-item--flash" : ""}`}
    >
      <button
        className="mission-panel-item-select"
        onClick={() => onSelect(mission.id)}
        title={mission.name}
      >
        <span className="mission-panel-item-name">{mission.name}</span>
        {(pendingByMission[mission.id] ?? 0) > 0 && (
          <span className="pending-badge" title={t("pending.badge")}>🔐{pendingByMission[mission.id]}</span>
        )}
        {isCurrent && <span className="mission-panel-check">✓</span>}
      </button>
      {isOpen && (
        <button
          className="mission-panel-item-archive"
          onClick={() => handleArchiveToggle(mission.id, !mission.archivedAt)}
          disabled={isCurrent && !mission.archivedAt}
          title={
            mission.archivedAt
              ? t("mission.unarchive")
              : isCurrent
                ? t("mission.cannotArchiveCurrent")
                : t("mission.archive")
          }
          aria-label={mission.archivedAt ? t("mission.unarchive") : t("mission.archive")}
        >
          {mission.archivedAt ? t("mission.restore") : "📦"}
        </button>
      )}
    </div>
  );

  return (
    <div className="left-section">
      <button className="left-section-header" onClick={() => setIsOpen((v) => !v)} aria-expanded={isOpen}>
        <span className="left-section-title">{t("mission.title")}</span>
        {totalPending > 0 && <span className="pending-badge" title={t("pending.badgeAllMissions")}>🔐{totalPending}</span>}
        <span className={`left-section-chevron ${isOpen ? "left-section-chevron--open" : ""}`}>▼</span>
      </button>

      <div
        className="mission-panel-body"
        ref={bodyRef}
        style={isOpen && height !== null ? { height: `${height}px` } : undefined}
      >
        {/*
           The search field is always at the top when opened. It narrows with an AND condition
                       of space-separated terms (see matchesFilter, e.g. "te A" matches only Test A).
           */}
        {isOpen && (
          <>
            <input
              className="mission-panel-filter"
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder={t("mission.search.placeholder")}
              aria-label={t("mission.search.aria")}
            />
            <label className="mission-panel-archived-toggle">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              {t("mission.showArchived")}
            </label>
          </>
        )}
        <div className={`mission-panel-list ${height === null ? "mission-panel-list--auto" : ""}`} ref={listRef}>
          {isOpen
            ? visibleMissions.map((mission) => renderMissionItem(mission, mission.id === activeMissionId))
            : activeMission && renderMissionItem(activeMission, true)}
        </div>

        {/*
           The + New mission button is shown at the very bottom of the mission area
                       only while open (hidden when collapsed).
           */}
        {isOpen && (
          isCreating ? (
            <div className="mission-panel-create">
              <input
                className="mission-panel-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); void handleCreate(); }
                  if (e.key === "Escape") { e.preventDefault(); cancelCreate(); }
                }}
                placeholder={t("mission.new.placeholder")}
                aria-label={t("mission.new.aria")}
                autoFocus
              />
              <div className="mission-panel-create-actions">
                <button className="mission-panel-create-btn" onClick={() => void handleCreate()} disabled={!newName.trim()}>
                  {t("mission.create")}
                </button>
                <button className="mission-panel-cancel-btn" onClick={cancelCreate}>
                  {t("common.cancel")}
                </button>
              </div>
              {error && <p className="mission-panel-error">{error}</p>}
            </div>
          ) : (
            <button className="mission-panel-new-btn" onClick={() => setIsCreating(true)}>
              {t("mission.new")}
            </button>
          )
        )}
      </div>
      {isOpen && (
        <div
          className={`left-section-resize-handle ${isDragging ? "left-section-resize-handle--dragging" : ""}`}
          onMouseDown={handleResizeMouseDown}
          title={t("common.dragToResizeHeight")}
          aria-label={t("common.resizeHandle")}
          role="separator"
          aria-orientation="horizontal"
        />
      )}
    </div>
  );
}
