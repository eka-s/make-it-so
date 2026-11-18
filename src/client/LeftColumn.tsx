import { useState, useRef, useCallback, useEffect } from "react";
import "./LeftPane.css";
import { useT } from "./i18n/I18nProvider";
import { loadStoredNumber, persistNumber } from "./preferences";

// Width of the left pane. It can be changed by dragging.
// There is no expand feature; the drag resize is enough for missions/crew/pins.
// The minimum width is the width at which the contents of a crew row (icon, name, status, context bar and %,
// unreported badge, arrow) line up without overlapping. When the column widths of the row (CrewStatusPanel.css)
// change, revisit this too.
const MIN_WIDTH = 345;
const DEFAULT_WIDTH = 355;
const MAX_WIDTH_RATIO = 0.5; // up to 50% of the viewport width
const MAX_WIDTH_ABS = 480;
const WIDTH_STORAGE_KEY = "left-panel-width";

function loadStoredWidth(): number {
  const saved = loadStoredNumber(WIDTH_STORAGE_KEY);
  // A value saved with an older minimum width is raised to the current minimum width
  return saved === null ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, saved);
}

type LeftColumnProps = {
  children: React.ReactNode;
};

// The frame of the whole left pane. A permanent, single resizable column with the collapsible sections for
// missions/crew status/pins (CollapsibleSection) stacked vertically inside.
export function LeftColumn({ children }: LeftColumnProps) {
  const t = useT();
  const [width, setWidth] = useState(loadStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = width;
  }, [width]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      const maxWidth = Math.min(window.innerWidth * MAX_WIDTH_RATIO, MAX_WIDTH_ABS);
      setWidth(Math.min(maxWidth, Math.max(MIN_WIDTH, startWidthRef.current + delta)));
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setWidth((w) => {
        persistNumber(WIDTH_STORAGE_KEY, w);
        return w;
      });
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div
      className={`left-column ${isDragging ? "left-column--dragging" : ""}`}
      style={{ width: `${width}px` }}
    >
      <div className="left-column-body">{children}</div>
      <div
        className="left-column-resize-handle"
        onMouseDown={handleMouseDown}
        title={t("common.dragToResizeWidth")}
        aria-label={t("common.resizeHandle")}
        role="separator"
        aria-orientation="vertical"
      />
    </div>
  );
}
