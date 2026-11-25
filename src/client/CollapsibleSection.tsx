import { useState, useRef, useCallback, useEffect } from "react";
import "./CollapsibleSection.css";
import { useT } from "./i18n/I18nProvider";

const MIN_HEIGHT = 80;

type CollapsibleSectionProps = {
  title: string;
  isOpen: boolean;
  // Number of pending approvals shown next to the heading (not shown if 0).
  badge?: number;
  onToggle: () => void;
  // Height when open (changed by dragging; the caller holds the state and persists it).
  // While null (= the default state, not dragged yet) it opens at the natural height
  // at which the whole content is visible — it switches to a concrete px value only at the moment of dragging, and from then on
  // that size is remembered.
  height: number | null;
  onResize: (height: number) => void;
  /** The color of the heading and the bar beside the body; each section has its own. */
  tone?: "peach" | "lilac" | "periwinkle";
  children: React.ReactNode;
};

// A collapsible section of the left pane (shared by MissionPanel/crew status/pins).
// Clicking the heading opens/closes it, and several sections can stay open at the same time. While open, the height can be changed
// by dragging the handle at the bottom edge. Each stretches and shrinks independently and they do not fight over each other's height — but
// they cannot be widened beyond the height at which the whole list inside is visible (the upper limit is computed from the difference
// between bodyRef's scrollHeight/clientHeight at the start of the drag and fixed).
export function CollapsibleSection({ title, isOpen, badge = 0, onToggle, height, onResize, tone = "peach", children }: CollapsibleSectionProps) {
  const t = useT();
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const maxHeightRef = useRef(Infinity);
  const sectionRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startYRef.current = e.clientY;
    // While height is null (open at the natural height), measure the height actually rendered now
    // and use it as the starting value.
    const current = height ?? sectionRef.current?.getBoundingClientRect().height ?? MIN_HEIGHT;
    startHeightRef.current = current;
    const body = bodyRef.current;
    maxHeightRef.current = body ? current + Math.max(0, body.scrollHeight - body.clientHeight) : Infinity;
  }, [height]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientY - startYRef.current;
      const uncapped = Math.max(MIN_HEIGHT, startHeightRef.current + delta);
      onResize(Math.min(maxHeightRef.current, uncapped));
    };

    const handleMouseUp = () => setIsDragging(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onResize]);

  return (
    <div
      className={`left-section left-section--${tone}`}
      ref={sectionRef}
      style={isOpen && height !== null ? { height: `${height}px` } : undefined}
    >
      <button
        className="left-section-header"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="left-section-title">{title}</span>
        {badge > 0 && <span className="pending-badge" title={t("pending.badge")}>🔐{badge}</span>}
        <span className={`left-section-chevron ${isOpen ? "left-section-chevron--open" : ""}`}>▼</span>
      </button>
      {isOpen && (
        <>
          <div className={`left-section-body ${height === null ? "left-section-body--auto" : ""}`} ref={bodyRef}>{children}</div>
          <div
            className={`left-section-resize-handle ${isDragging ? "left-section-resize-handle--dragging" : ""}`}
            onMouseDown={handleMouseDown}
            title={t("common.dragToResizeHeight")}
            aria-label={t("common.resizeHandle")}
            role="separator"
            aria-orientation="horizontal"
          />
        </>
      )}
    </div>
  );
}
