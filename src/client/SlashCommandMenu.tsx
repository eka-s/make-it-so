import { useEffect, useRef } from "react";
import "./SlashCommandMenu.css";
import type { SlashCommand } from "./types";

type SlashCommandMenuProps = {
  candidates: SlashCommand[];
  activeIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  /** A note shown when the list is the previous one (that partner has not started yet). */
  staleNote?: string;
};

// Candidates for the current partner's slash commands (name, argument hint, description) shown when "/" is typed at the start of the input.
// There can be many, so a maximum height is set, it scrolls inside, and the item selected with the keyboard is brought into view.
export function SlashCommandMenu({ candidates, activeIndex, onSelect, onHover, staleNote }: SlashCommandMenuProps) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="slash-menu" role="listbox">
      {candidates.map((c, idx) => (
        <button
          key={c.name}
          ref={idx === activeIndex ? activeRef : undefined}
          type="button"
          role="option"
          aria-selected={idx === activeIndex}
          className={`slash-menu-item ${idx === activeIndex ? "slash-menu-item--active" : ""}`}
          // Commit the selection at mousedown (with onClick, the textarea's blur would fire first and the caret position would be lost)
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(c);
          }}
          onMouseEnter={() => onHover(idx)}
        >
          <span className="slash-menu-name">
            /{c.name}
            {c.hint && <span className="slash-menu-hint"> {c.hint}</span>}
          </span>
          {c.description && <span className="slash-menu-description">{c.description}</span>}
        </button>
      ))}
      {staleNote && <div className="slash-menu-stale">{staleNote}</div>}
    </div>
  );
}
