import "./PinSidebar.css";
import { PopupOpenButton } from "./PopupOpenButton";
import type { PinnedMessage } from "./types";
import { useT } from "./i18n/I18nProvider";

type PinSidebarProps = {
  pinnedMessages: PinnedMessage[];
  /** Scrolls the conversation to the pinned message (loading it first if it is not loaded). */
  onJump: (pin: PinnedMessage) => void;
  /** Button shown when the mouse is over an item: opens that pin's message in a popup. */
  onOpenPopup: (pin: PinnedMessage) => void;
};

// Only caps the amount of text put in the page: where the text is cut (and the "…" drawn) depends on
// the width of the list, so that is left to the CSS (text-overflow: ellipsis), which keeps the "…" at
// the right edge whatever the characters are.
const MAX_PREVIEW_CHARS = 200;

// The pin list of the left pane. Clicking an item takes the conversation to that message. A pin is
// removed with the pin button of the message itself (jump to it first if it is not on screen).
export function PinSidebar({ pinnedMessages, onJump, onOpenPopup }: PinSidebarProps) {
  const t = useT();
  if (pinnedMessages.length === 0) {
    return <p className="pin-panel-empty">{t("pin.none")}</p>;
  }

  return (
    <ul className="pin-list">
      {pinnedMessages.map((pin) => (
        <li key={pin.messageId} className="popup-row">
          <button className="pin-list-item" onClick={() => onJump(pin)} title={t("pin.jump")}>
            <span className="pin-list-role">{pin.role === "captain" ? "👨‍✈️" : "🧔"}</span>
            <span className="pin-list-text">{pin.text.slice(0, MAX_PREVIEW_CHARS)}</span>
          </button>
          <PopupOpenButton onClick={() => onOpenPopup(pin)} />
        </li>
      ))}
    </ul>
  );
}
