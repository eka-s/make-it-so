import { useState, useRef, useEffect, useCallback } from "react";
import "./QuickActionsMenu.css";
import { useI18n } from "./i18n/I18nProvider";
import { api } from "./server-api";
import type { QuickActionItem } from "./types";
import { NEW_ROW, QuickActionsEditor, type EditRow } from "./QuickActionsEditor";

type QuickActionsMenuProps = {
  /** Sends text through the same path as a typed message (a slash command is just a message that starts with "/"). */
  onSend: (text: string) => void;
  /** Puts text in the message box without sending it. */
  onFill: (text: string) => void;
  disabled: boolean;
};

// The custom menu button (the last of the buttons beside the message box). Clicking opens the list of this ship's items; an item is
// sent at once or put in the message box, as it was set up. "Settings…" at the bottom opens the editor, whose changes apply to this ship.
// The list is the server's: it is read when the menu opens and after each save.
export function QuickActionsMenu({ onSend, onFill, disabled }: QuickActionsMenuProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<QuickActionItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  const load = useCallback(() => {
    setFailed(false);
    api.getQuickActions()
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) setItems(data.actions);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // Close on outside click/Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, close]);

  const run = (item: QuickActionItem) => {
    if (item.send === "now") onSend(item.command);
    else onFill(item.command);
    close();
  };

  return (
    <div className="quick-actions-menu" ref={containerRef}>
      <button
        className="chat-input-btn chat-input-btn--menu"
        onClick={() => setIsOpen((v) => !v)}
        disabled={disabled}
        title={t("quickActions.title")}
        aria-label={t("quickActions.title")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        {t("quickActions.button")} ▴
      </button>
      {isOpen && (
        <div className="quick-actions-dropdown" role="menu">
          {failed && <p className="quick-actions-note">{t("quickActions.loadFailed")}</p>}
          {!failed && items !== null && items.length === 0 && <p className="quick-actions-note">{t("quickActions.empty")}</p>}
          {(items ?? []).map((item) => (
            <button
              key={item.id}
              className="quick-actions-item"
              role="menuitem"
              onClick={() => run(item)}
              disabled={disabled}
              title={item.command}
            >
              <span className="quick-actions-item-name">
                {item.name}
                {item.send === "fill" && <span className="quick-actions-fill-mark" aria-hidden="true"> …</span>}
              </span>
              {/* What is sent is shown too: the name alone could say something else than the text */}
              <span className="quick-actions-item-command">{item.command}</span>
            </button>
          ))}
          <button className="quick-actions-item quick-actions-item--settings" role="menuitem" onClick={() => { close(); setEditing(true); }}>
            {t("quickActions.settings")}
          </button>
        </div>
      )}
      {editing && <QuickActionsDialog onClose={() => setEditing(false)} />}
    </div>
  );
}

/** The editor popup for this ship's menu. */
function QuickActionsDialog({ onClose }: { onClose: () => void }) {
  const { t, tError } = useI18n();
  const [rows, setRows] = useState<EditRow[] | null>(null);
  // The IDs the list had when it was loaded: the server leaves alone an item added since (by the settings screen, say).
  const [seen, setSeen] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getQuickActions()
      .then(async (res) => {
        const data = await res.json();
        if (res.ok) {
          setRows(data.actions);
          setSeen(data.actions.map((a) => a.id));
        }
        else setMessage(tError(data, t("quickActions.loadFailed")));
      })
      .catch(() => setMessage(t("quickActions.loadFailed")));
    // Loaded once when the dialog opens (a language change must not throw away what was typed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    setErrors({});
    setMessage(null);
    try {
      const res = await api.saveQuickActions(rows.map(({ id, name, kind, command, send }) => ({ id, name, kind, command, send })), seen);
      const data = await res.json();
      if (res.ok) onClose();
      else if (res.status === 400 && data.errors) setErrors(data.errors);
      else setMessage(tError(data, t("settings.saveFailed")));
    } catch {
      setMessage(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="qa-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="qa-dialog" role="dialog" aria-modal="true" aria-label={t("quickActions.editor.title")}>
        <div className="qa-dialog-header">
          <span>{t("quickActions.editor.title")}</span>
          <button type="button" className="qa-dialog-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>
        <div className="qa-dialog-body">
          <p className="qa-dialog-help">{t("quickActions.editor.help")}</p>
          {rows === null ? <p>{message ?? t("common.loading")}</p> : <QuickActionsEditor rows={rows} onChange={setRows} errors={errors} />}
        </div>
        {rows !== null && (
          <div className="qa-dialog-footer">
            <button type="button" onClick={() => setRows([...rows, { ...NEW_ROW }])}>{t("quickActions.editor.add")}</button>
            <span className="qa-dialog-spacer" />
            {message && <span className="qa-error">{message}</span>}
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="qa-dialog-save" onClick={() => void save()} disabled={saving}>{saving ? t("settings.saving") : t("settings.save")}</button>
          </div>
        )}
      </div>
    </div>
  );
}
