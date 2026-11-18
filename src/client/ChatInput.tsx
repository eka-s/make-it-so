import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { KeyboardEvent, DragEvent, ChangeEvent } from "react";
import { QuickActionsMenu } from "./QuickActionsMenu";
import { CaptainHistoryMenu, type CaptainHistoryItem } from "./CaptainHistoryMenu";
import { caretOnFirstRow } from "./caret-row";
import { api } from "./server-api";
import { ChatTargetBar, type ChatTargetBarHandle } from "./ChatTargetBar";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { completeSlash, filterSlashCommands, slashMenuMode, slashQuery } from "./slash-menu";
import type { CrewMemberConfig, SlashCommand } from "./types";
import "./SlashCommandMenu.css";
import { useT } from "./i18n/I18nProvider";

type ChatInputProps = {
  onSend: (text: string) => void;
  onReport: () => void;
  disabled: boolean;
  /** The mission that is open (the ↑ history is of its captain messages). */
  missionId: string;
  crewConfig?: Record<string, CrewMemberConfig>;
  // The base conversation partner (whom you keep talking to) and the destination of the next message only (selected while holding Shift; going back to the base after sending).
  // The actual destination of the next send is the one-message destination if there is one.
  baseTarget: string;
  onceTarget: string | null;
  /**
   * Selects a crew member. With `once`, the destination of the next message only; otherwise the base conversation partner is switched.
   */
  onSelectTarget: (role: string, once: boolean) => void;
  /** Cancels the destination of the next message only. */
  onCancelOnce: () => void;
  // Slash commands the current partner can run (notified by the provider). Shown as candidates for a leading "/" in the input box.
  commands: SlashCommand[];
  // Whether `commands` is the latest one that arrived from the running session (if false, it is the previous list, or empty = not started yet).
  commandsLive: boolean;
};

type FileWithPath = File & { path?: string };

export function ChatInput({ onSend, onReport, disabled, missionId, crewConfig, baseTarget, onceTarget, onSelectTarget, onCancelOnce, commands, commandsLive }: ChatInputProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const targetBarRef = useRef<ChatTargetBarHandle>(null);

  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    // Reset the height to auto so that scrollHeight reflects the actual content size
    textarea.style.height = "auto";
    const maxHeight = window.innerHeight * 0.5;
    if (textarea.scrollHeight > maxHeight) {
      textarea.style.height = `${maxHeight}px`;
      textarea.style.overflow = "auto";
    } else {
      textarea.style.height = `${textarea.scrollHeight}px`;
      textarea.style.overflow = "hidden";
    }
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [text, adjustHeight]);

  // The captain's earlier messages (see below): whether the list is open, and the request that fills it.
  const [historyOpen, setHistoryOpen] = useState(false);
  // The request in flight: closing the list, opening it again, or switching missions cancels it, so a late answer
  // (of another mission, say) never lands in the list that is open now.
  const historyRequest = useRef<AbortController | null>(null);

  const closeHistory = useCallback(() => {
    historyRequest.current?.abort();
    historyRequest.current = null;
    setHistoryOpen(false);
  }, []);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    setCursor(0);
    closeHistory();
  }, [text, disabled, onSend, closeHistory]);

  // --- Slash command candidates: shown only while typing the first word that starts with a leading "/" ---
  const [cursor, setCursor] = useState(0);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  // Candidates closed with Esc are not shown again until the text changes
  const [slashDismissed, setSlashDismissed] = useState(false);
  const query = slashQuery(text, cursor);
  const slashCandidates = useMemo(
    () => (query === null || slashDismissed ? [] : filterSlashCommands(commands, query)),
    [commands, query, slashDismissed],
  );
  const slashMode = slashMenuMode(query, slashDismissed, slashCandidates.length, commandsLive);
  const isSlashOpen = slashMode === "candidates";

  useEffect(() => {
    setSlashActiveIndex(0);
  }, [query]);

  // --- The captain's earlier messages: ↑ on the first row of the input box opens a list to pick one from ---
  const [historyItems, setHistoryItems] = useState<CaptainHistoryItem[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [historyActive, setHistoryActive] = useState(0);

  const openHistory = useCallback(() => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryOpen(true);
    setHistoryItems(null);
    setHistoryFailed(false);
    // The newest message is the first (it is drawn at the bottom, next to the input box); ↑ goes to older ones.
    setHistoryActive(0);
    api.getCaptainHistory(missionId, controller.signal)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (!controller.signal.aborted) setHistoryItems(data.items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryFailed(true);
      });
  }, [missionId]);

  const chooseHistory = useCallback((item: CaptainHistoryItem) => {
    setText(item.text);
    setCursor(item.text.length);
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(item.text.length, item.text.length);
    });
  }, []);

  // A different mission has a different history
  useEffect(() => {
    closeHistory();
  }, [missionId, closeHistory]);

  const handleTextChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    setCursor(e.target.selectionStart);
    setSlashDismissed(false);
  }, []);

  // Also track the position when only the cursor moves (arrow keys, clicks), to show/hide the candidates
  const syncCursor = useCallback((e: { currentTarget: HTMLTextAreaElement }) => {
    setCursor(e.currentTarget.selectionStart);
  }, []);

  const selectSlash = useCallback((command: SlashCommand) => {
    const completed = completeSlash(text, cursor, command.name);
    setText(completed.text);
    setCursor(completed.cursor);
    requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(completed.cursor, completed.cursor);
      textareaRef.current?.focus();
    });
  }, [text, cursor]);

  // "@" is a shortcut to select the conversation partner: pressing it enters no character, and focus moves to the row of
  // partner buttons (←→ to select, Enter to confirm, Esc to cancel. See ChatTargetBar). Only an "@" at the start of a line or right after whitespace
  // counts; an "@" right after a character, as in an email address, goes in as an ordinary character.
  // During conversion (IME), key presses are used to confirm characters, so it does not apply.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // While an IME is converting, Enter / Tab / arrows / Esc belong to the conversion (confirming a candidate), not to the menus here.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (historyOpen) {
        const count = historyItems?.length ?? 0;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          // The list is drawn oldest at the top and newest at the bottom, so ↑ goes to an older message.
          const step = e.key === "ArrowUp" ? 1 : -1;
          if (count > 0) setHistoryActive((i) => (i + step + count) % count);
          return;
        }
        if (e.key === "Enter" && !e.ctrlKey) {
          e.preventDefault();
          if (historyItems && historyItems[historyActive]) chooseHistory(historyItems[historyActive]);
          else closeHistory();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeHistory();
          return;
        }
        // Any other key is the person going back to typing (Ctrl+Enter sends): the list is put away and the key does its usual job.
        if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) closeHistory();
      }
      if (isSlashOpen) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const step = e.key === "ArrowDown" ? 1 : -1;
          setSlashActiveIndex((i) => (i + step + slashCandidates.length) % slashCandidates.length);
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.ctrlKey)) {
          e.preventDefault();
          selectSlash(slashCandidates[slashActiveIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashDismissed(true);
          return;
        }
      }
      // If there is a destination of the next message only, cancel it with Esc (an Esc while candidates are shown closes the candidates above)
      if (e.key === "Escape" && onceTarget !== null) {
        e.preventDefault();
        onCancelOnce();
        return;
      }
      if (e.key === "@" && !disabled && !e.nativeEvent.isComposing) {
        const cursor = e.currentTarget.selectionStart;
        const before = e.currentTarget.value[cursor - 1];
        if (cursor === 0 || before === " " || before === "\n") {
          e.preventDefault();
          targetBarRef.current?.startPicking();
          return;
        }
      }
      if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !disabled) {
        const area = e.currentTarget;
        if (area.selectionStart === area.selectionEnd && caretOnFirstRow(area)) {
          e.preventDefault();
          openHistory();
          return;
        }
      }
      if (e.key === "Enter" && e.ctrlKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, disabled, isSlashOpen, slashCandidates, slashActiveIndex, selectSlash, onceTarget, onCancelOnce, historyOpen, historyItems, historyActive, chooseHistory, closeHistory, openHistory]
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      const files = e.dataTransfer.files;
      if (files.length === 0) return;

      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as FileWithPath;
        // Electron exposes file.path. A browser gives only the name, which is not a path, so it is inserted as a bare name
        // (the crew must not take it for a path it can open).
        paths.push(file.path ? `"${file.path}"` : file.name);
      }

      const insertion = paths.join(" ");

      const textarea = textareaRef.current;
      if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const before = text.slice(0, start);
        const after = text.slice(end);
        // If there is adjacent text, add a space before the insertion
        const needsSpaceBefore = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
        const needsSpaceAfter = after.length > 0 && !after.startsWith(" ") && !after.startsWith("\n");
        const newText =
          before +
          (needsSpaceBefore ? " " : "") +
          insertion +
          (needsSpaceAfter ? " " : "") +
          after;
        setText(newText);
      } else {
        // Fallback: append at the end
        const needsSpace = text.length > 0 && !text.endsWith(" ") && !text.endsWith("\n");
        setText(text + (needsSpace ? " " : "") + insertion);
      }
    },
    [text]
  );

  const handleEngage = useCallback(() => {
    if (disabled) return;
    onSend("engage");
  }, [disabled, onSend]);

  const handleMakeItSo = useCallback(() => {
    if (disabled) return;
    onSend("make it so");
  }, [disabled, onSend]);

  const sendTarget = onceTarget ?? baseTarget;
  const targetName = crewConfig?.[sendTarget]?.name ?? sendTarget;

  return (
    <div className="chat-input">
      {/*
         A conversation-partner selection bar kept above the input box (crew members lined up as buttons. One click switches).
         */}
      <ChatTargetBar
        ref={targetBarRef}
        crewConfig={crewConfig}
        baseTarget={baseTarget}
        onceTarget={onceTarget}
        onSelectTarget={onSelectTarget}
        disabled={disabled}
        onPickDone={() => textareaRef.current?.focus()}
      />
      {/* Lower row: the textarea, the send button, and the column of buttons (Make it so, Engage!, Report, Menu). */}
      <div className="chat-input-row">
      <div className="chat-input-field-wrapper">
        <textarea
          ref={textareaRef}
          className={`chat-input-field${dragOver ? " chat-input-field--dragover" : ""}`}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCursor}
          onClick={syncCursor}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          placeholder={disabled ? t("chat.input.placeholderBusy") : t("chat.input.placeholder", { name: targetName })}
          aria-label={t("chat.input.aria")}
        />
        {historyOpen && (
          <CaptainHistoryMenu
            items={historyItems}
            failed={historyFailed}
            activeIndex={historyActive}
            onSelect={chooseHistory}
            onHover={setHistoryActive}
            onCancel={closeHistory}
          />
        )}
        {/* Candidates for the current partner's slash commands, shown for a leading "/" */}
        {isSlashOpen && (
          <div className="slash-menu-anchor">
            <SlashCommandMenu
              candidates={slashCandidates}
              activeIndex={slashActiveIndex}
              onSelect={selectSlash}
              onHover={setSlashActiveIndex}
              staleNote={commandsLive ? undefined : t("slash.stale", { name: targetName })}
            />
          </div>
        )}
        {/*
           When there are no candidates and the partner has not started yet (the list has not arrived), say it is before startup instead of showing no reaction
           */}
        {slashMode === "not-started" && (
          <div className="slash-menu-anchor">
            <div className="slash-menu slash-menu--note" role="status">{t("slash.notStarted", { name: targetName })}</div>
          </div>
        )}
      </div>
      <button
        className="chat-input-send"
        onClick={handleSend}
        disabled={disabled || !text.trim()}
        aria-label={t("chat.send.aria")}
      >
        {disabled ? "⏳" : "▶"}
      </button>
      <div className="chat-input-buttons">
        <button
          className="chat-input-btn chat-input-btn--makeitso"
          onClick={handleMakeItSo}
          disabled={disabled}
          aria-label={t("chat.makeItSo.aria")}
          title={t("chat.makeItSo")}
        >
          {t("chat.makeItSo")}
        </button>
        <button
          className="chat-input-btn chat-input-btn--engage"
          onClick={handleEngage}
          disabled={disabled}
          aria-label={t("chat.engage.aria")}
          title={t("chat.engage")}
        >
          {t("chat.engage")}
        </button>
        <button
          className="chat-input-btn chat-input-btn--report"
          onClick={onReport}
          disabled={disabled}
          aria-label={t("chat.report.aria")}
          title={t("chat.report")}
        >
          {t("chat.report")}
        </button>
        <QuickActionsMenu
          onSend={onSend}
          onFill={(value) => {
            setText(value);
            setCursor(value.length);
            requestAnimationFrame(() => {
              textareaRef.current?.focus();
              textareaRef.current?.setSelectionRange(value.length, value.length);
            });
          }}
          disabled={disabled}
        />
      </div>
      </div>
    </div>
  );
}
