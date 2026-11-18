import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsQuickActionsState } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { useRegisterDirty, type DirtyRegistry } from "./use-unsaved";
import { NEW_ROW, QuickActionsEditor, type EditRow } from "./QuickActionsEditor";

// The custom menu form of the settings app: every item and the ships it is enabled on (quick-actions.yml).
// The server decides what is valid.

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string } | { kind: "unreadable"; message: string };

export function SettingsQuickActionsForm({ dirty }: { dirty?: DirtyRegistry }) {
  const { t, tError } = useI18n();
  // The load below must not run again when the language changes (it would throw away what was typed).
  const text = useRef({ t, tError });
  text.current = { t, tError };
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [ships, setShips] = useState<{ id: string; name: string }[]>([]);
  const [saved, setSaved] = useState("[]");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const adopt = useCallback((state: SettingsQuickActionsState) => {
    setRows(state.actions);
    setShips(state.ships);
    setSaved(JSON.stringify(state.actions));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getSettingsQuickActions(controller.signal)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 409) setStatus({ kind: "unreadable", message: data.message ?? "" });
        else if (res.ok) adopt(data);
        else setStatus({ kind: "failed", message: text.current.tError(data, text.current.t("settings.saveFailed")) });
      })
      .catch(() => { if (!controller.signal.aborted) setStatus({ kind: "failed", message: text.current.t("settings.saveFailed") }); });
    return () => controller.abort();
  }, [adopt]);

  useRegisterDirty(dirty, rows !== null && JSON.stringify(rows) !== saved);

  const save = async () => {
    if (!rows) return;
    setStatus({ kind: "saving" });
    setErrors({});
    try {
      const res = await api.saveSettingsQuickActions(rows.map(({ id, name, kind, command, send, ships: where, except }) => ({ id, name, kind, command, send, ships: where ?? [], except })));
      const data = await res.json();
      if (res.ok) {
        adopt(data);
        setStatus({ kind: "saved" });
      } else if (res.status === 400 && data.errors) {
        setErrors(data.errors);
        setStatus({ kind: "idle" });
      } else if (res.status === 409) {
        setStatus({ kind: "unreadable", message: data.message ?? "" });
      } else {
        setStatus({ kind: "failed", message: tError(data, t("settings.saveFailed")) });
      }
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  if (status.kind === "unreadable") return <p className="settings-error">{t("settings.unreadable", { message: status.message })}</p>;
  if (!rows) return <p className="settings-dim">{status.kind === "failed" ? status.message : t("common.loading")}</p>;

  return (
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="settings-help">{t("settings.quick.help")}</p>
      <QuickActionsEditor rows={rows} onChange={(next) => { setRows(next); setStatus({ kind: "idle" }); }} errors={errors} ships={ships} />
      <div className="settings-actions">
        <button type="button" onClick={() => { setRows([...rows, { ...NEW_ROW, ships: [] }]); setStatus({ kind: "idle" }); }}>
          {t("quickActions.editor.add")}
        </button>
        <button type="submit" disabled={status.kind === "saving"}>{status.kind === "saving" ? t("settings.saving") : t("settings.save")}</button>
        {status.kind === "saved" && <span className="settings-ok">{t("settings.quick.saved")}</span>}
        {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
      </div>
    </form>
  );
}
