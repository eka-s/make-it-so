import "./PopupOpenButton.css";
import { useT } from "./i18n/I18nProvider";

type PopupOpenButtonProps = {
  onClick: () => void;
  /**
   * Placed within a row such as a heading (it does not float at the top right). It becomes visible when the parent `.message` is hovered.
   */
  inline?: boolean;
};

// The "show in a popup" button that appears when the mouse is over an item of a list (pins, crew status history, search results).
// Clicking the item itself means "scroll to that message in the conversation"; this button opens that message in a popup.
// It is shown when the parent `.popup-row` is hovered (or focused) (PopupOpenButton.css).
export function PopupOpenButton({ onClick, inline = false }: PopupOpenButtonProps) {
  const t = useT();
  return (
    <button
      type="button"
      className={`popup-open-btn${inline ? " popup-open-btn--inline" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={t("popup.open")}
      aria-label={t("popup.open")}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 2 H2 V10 H10 V7" />
        <path d="M7 2 H10 V5" />
        <path d="M10 2 L5.5 6.5" />
      </svg>
    </button>
  );
}
