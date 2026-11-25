import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { CrewIcon } from "./crewIcons";
import { HostBadge } from "./HostBadge";
import "./ChatTargetBar.css";
import type { CrewMemberConfig } from "./types";
import { useT } from "./i18n/I18nProvider";
import { applyOrder, countFitting, moveRole, stepHighlight } from "./chat-target-order";
import { loadStoredTargetOrder, persistTargetOrder } from "./preferences";

// Gap between buttons (px). Kept equal to `gap` in ChatTargetBar.css (used for the overflow calculation).
const GAP = 6;
// Left/right padding of the area where the buttons line up (so the selected outline is not clipped. Kept equal to the padding of .chat-target-track in ChatTargetBar.css)
const TRACK_PADDING = 4;

export type ChatTargetBarHandle = {
  /** Starts selecting the conversation partner with the keyboard (moves focus to the row of buttons). */
  startPicking: () => void;
};

type ChatTargetBarProps = {
  // The ship's actual composition (including first_officer). Used to resolve icons and display names.
  crewConfig?: Record<string, CrewMemberConfig>;
  // The base conversation partner (whom you keep talking to).
  baseTarget: string;
  // The destination of the next message only (null if none). Cancelled when sent, going back to the base partner.
  onceTarget: string | null;
  /**
   * Selects a crew member. With `once` (selected while holding Shift) it is the destination of the next message only; otherwise the base conversation partner is switched.
   */
  onSelectTarget: (role: string, once: boolean) => void;
  disabled: boolean;
  // Keyboard selection ended (confirmed or Esc). The caller returns focus to the input box.
  onPickDone: () => void;
};

// A conversation-partner selection bar kept above the input box. Crew members are lined up as buttons, and one click switches the partner.
// - Reordering: drag and drop (the order is saved in the browser).
// - Overflow: buttons that do not fit the width are gathered into the "»" at the right end (like a bookmarks bar).
// - Keyboard: pressing "@" in the input box (on the ChatInput side) moves focus here. ←→ to select, Enter to confirm, Esc to cancel.
export const ChatTargetBar = forwardRef<ChatTargetBarHandle, ChatTargetBarProps>(function ChatTargetBar(
  { crewConfig, baseTarget, onceTarget, onSelectTarget, disabled, onPickDone },
  ref,
) {
  const t = useT();
  const [savedOrder, setSavedOrder] = useState<string[]>(loadStoredTargetOrder);
  const roles = useMemo(() => (crewConfig ? Object.keys(crewConfig) : []), [crewConfig]);
  const ordered = useMemo(() => applyOrder(roles, savedOrder), [roles, savedOrder]);

  // --- Overflow calculation: all buttons are lined up in an invisible row, their widths measured, and the number that fit decided ---
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const row = measureRef.current;
    if (!track || !row) return;
    const widths = Array.from(row.children).map((el) => el.getBoundingClientRect().width);
    const overflowWidth = widths.pop() ?? 0; // The last one is the "»" button
    setVisibleCount(countFitting(widths, track.clientWidth - TRACK_PADDING * 2, GAP, overflowWidth));
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, ordered, crewConfig, baseTarget, onceTarget]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure]);

  const shown = ordered.slice(0, visibleCount);
  const hidden = ordered.slice(visibleCount);

  // --- Keyboard selection ---
  const [picking, setPicking] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    startPicking: () => {
      if (disabled || ordered.length === 0) return;
      setHighlight(ordered.includes(baseTarget) ? baseTarget : ordered[0]);
      setPicking(true);
      trackRef.current?.focus();
    },
  }), [disabled, ordered, baseTarget]);

  // --- The "»" list (opened/closed with the mouse. It opens automatically while a hidden one is selected with the keyboard) ---
  const [menuOpen, setMenuOpen] = useState(false);
  const highlightIsHidden = picking && highlight !== null && hidden.includes(highlight);
  const isMenuOpen = hidden.length > 0 && (menuOpen || highlightIsHidden);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setMenuOpen(false); }
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const finishPicking = useCallback(() => {
    setPicking(false);
    setHighlight(null);
    setMenuOpen(false);
    onPickDone();
  }, [onPickDone]);

  // `once`: selected while holding Shift (makes it the destination of the next message only)
  const select = useCallback((role: string, once: boolean) => {
    onSelectTarget(role, once);
    setMenuOpen(false);
  }, [onSelectTarget]);

  const handleTrackKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!picking) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHighlight((current) => stepHighlight(ordered, current, e.key === "ArrowRight" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlight) onSelectTarget(highlight, e.shiftKey);
      finishPicking();
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishPicking();
    }
  };

  // When focus leaves the bar, selection ends (focus is not returned to the input box)
  const handleTrackBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (wrapperRef.current?.contains(e.relatedTarget as Node | null)) return;
    setPicking(false);
    setHighlight(null);
  };

  // --- Reordering (drag and drop) ---
  const [dragRole, setDragRole] = useState<string | null>(null);
  const [dropRole, setDropRole] = useState<string | null>(null);

  const dragProps = (role: string) => ({
    draggable: !disabled,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      setDragRole(role);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", role);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (dragRole === null || dragRole === role) return;
      e.preventDefault();
      setDropRole(role);
    },
    onDragLeave: () => setDropRole((current) => (current === role ? null : current)),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (dragRole !== null) {
        const next = moveRole(ordered, dragRole, role);
        setSavedOrder(next);
        persistTargetOrder(next);
      }
      setDragRole(null);
      setDropRole(null);
    },
    onDragEnd: () => {
      setDragRole(null);
      setDropRole(null);
    },
  });

  const buttonClass = (role: string, base: string) =>
    [
      base,
      role === baseTarget ? `${base}--current` : "",
      role === onceTarget ? `${base}--once` : "",
      picking && role === highlight ? `${base}--highlight` : "",
      role === dragRole ? `${base}--dragging` : "",
      role === dropRole ? `${base}--drop` : "",
    ]
      .filter(Boolean)
      .join(" ");

  // A mark for when there is a one-message destination: "→1" on that destination, and "●" on the one to go back to (the base partner)
  const marker = (role: string) => {
    if (onceTarget === null) return null;
    if (role === onceTarget) return <span className="chat-target-once-tag">{t("chat.target.onceTag")}</span>;
    if (role === baseTarget) return <span className="chat-target-home" title={t("chat.target.home")}>●</span>;
    return null;
  };

  const label = (role: string) => {
    const member = crewConfig?.[role];
    return { name: member?.name ?? role, icon: member?.icon, host: member?.host };
  };

  const currentHidden = hidden.includes(baseTarget);
  const onceHidden = onceTarget !== null && hidden.includes(onceTarget);

  return (
    <div className="chat-target-bar" ref={wrapperRef}>
      <span className="chat-target-label">{t("chat.target.label")}</span>
      <div
        className="chat-target-track"
        ref={trackRef}
        tabIndex={-1}
        role="toolbar"
        aria-label={t("chat.target.switch")}
        onKeyDown={handleTrackKeyDown}
        onBlur={handleTrackBlur}
      >
        {shown.map((role) => {
          const { name, icon, host } = label(role);
          return (
            <button
              key={role}
              type="button"
              className={buttonClass(role, "chat-target-btn")}
              aria-pressed={role === baseTarget}
              disabled={disabled}
              onClick={(e) => select(role, e.shiftKey)}
              title={t("chat.target.hint")}
              tabIndex={picking ? -1 : 0}
              {...dragProps(role)}
            >
              <CrewIcon name={name} iconUrl={icon} size={16} />
              <span className="chat-target-btn-name">{name}</span>
              <HostBadge host={host} />
              {marker(role)}
            </button>
          );
        })}
        {hidden.length > 0 && (
          <button
            type="button"
            className={`chat-target-more ${currentHidden ? "chat-target-more--current" : ""} ${onceHidden ? "chat-target-more--once" : ""} ${highlightIsHidden ? "chat-target-more--highlight" : ""}`}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            title={t("chat.target.more")}
            disabled={disabled}
            onClick={() => setMenuOpen((v) => !v)}
            tabIndex={picking ? -1 : 0}
          >
            »
          </button>
        )}
        {/*
           An invisible row for measuring widths (lines up the buttons of all crew members and "»" with the same look as the display)
           */}
        <div className="chat-target-measure" ref={measureRef} aria-hidden="true">
          {ordered.map((role) => {
            const { name, icon, host } = label(role);
            return (
              <span key={role} className={`chat-target-btn ${role === baseTarget ? "chat-target-btn--current" : ""} ${role === onceTarget ? "chat-target-btn--once" : ""}`}>
                <CrewIcon name={name} iconUrl={icon} size={16} />
                <span className="chat-target-btn-name">{name}</span>
                <HostBadge host={host} />
                {marker(role)}
              </span>
            );
          })}
          <span className="chat-target-more">»</span>
        </div>
      </div>
      {isMenuOpen && (
        <div className="chat-target-menu" role="menu">
          {hidden.map((role) => {
            const { name, icon, host } = label(role);
            return (
              <button
                key={role}
                type="button"
                role="menuitem"
                className={buttonClass(role, "chat-target-menu-item")}
                disabled={disabled}
                onClick={(e) => select(role, e.shiftKey)}
                title={t("chat.target.hint")}
                tabIndex={-1}
                {...dragProps(role)}
              >
                <CrewIcon name={name} iconUrl={icon} size={16} />
                <span className="chat-target-btn-name">{name}</span>
                <HostBadge host={host} />
                {marker(role)}
                {role === baseTarget && onceTarget === null && <span className="chat-target-current-mark">✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});
