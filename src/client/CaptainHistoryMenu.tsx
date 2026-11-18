import { useEffect, useRef } from "react";
import "./CaptainHistoryMenu.css";
import { useT } from "./i18n/I18nProvider";

export type CaptainHistoryItem = { id: string; text: string; timestamp: string };

type Props = {
  /** Newest first. `null` while loading. */
  items: CaptainHistoryItem[] | null;
  failed: boolean;
  activeIndex: number;
  onSelect: (item: CaptainHistoryItem) => void;
  onHover: (index: number) => void;
  /** Closes the list without choosing (a click outside it). */
  onCancel: () => void;
};

// The captain's earlier messages, offered when ↑ is pressed on the first row of the input box. Keys (↑↓, Enter, Esc) are handled by the
// input box, which keeps the focus; this component draws the list and takes the clicks.
export function CaptainHistoryMenu({ items, failed, activeIndex, onSelect, onHover, onCancel }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onCancel]);

  useEffect(() => {
    rootRef.current?.querySelector(".history-menu-item--active")?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="history-menu-anchor" ref={rootRef}>
      <div className="history-menu" role="listbox" aria-label={t("history.title")}>
        <div className="history-menu-title">{t("history.title")}<span>{t("history.hint")}</span></div>
        {failed && <p className="history-menu-note">{t("history.loadFailed")}</p>}
        {!failed && items === null && <p className="history-menu-note">{t("common.loading")}</p>}
        {!failed && items !== null && items.length === 0 && <p className="history-menu-note">{t("history.empty")}</p>}
        {items !== null && items.length > 0 && (
          <div className="history-menu-list">
            {items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`history-menu-item${index === activeIndex ? " history-menu-item--active" : ""}`}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(item)}
                title={item.text}
              >
                {item.text}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
