import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsConfigField, SettingsConfigState } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { useRegisterDirty, type DirtyRegistry } from "./use-unsaved";

// The config.yml form. The fields (kind, choices, default) come from the server; this draws them and sends back what changed.

type Draft = Record<string, string | boolean>;
type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string } | { kind: "unreadable"; message: string };

/** The form's text for a value from the server (a list becomes one item per line). */
function toDraft(field: SettingsConfigField): string | boolean {
  if (field.type === "boolean") return field.value === null ? Boolean(field.default) : Boolean(field.value);
  if (field.value === null) return "";
  return Array.isArray(field.value) ? field.value.join("\n") : String(field.value);
}

/** The value to send for a draft (null clears the field back to its default). */
function fromDraft(field: SettingsConfigField, draft: string | boolean): unknown {
  if (field.type === "boolean") return draft;
  const text = String(draft);
  if (text.trim() === "") return null;
  if (field.type === "number") return Number(text);
  if (field.type === "list") return text.split("\n");
  return text;
}

function defaultText(field: SettingsConfigField): string {
  return Array.isArray(field.default) ? field.default.join(" ") : String(field.default);
}

export function SettingsConfigForm({ dirty }: { dirty?: DirtyRegistry }) {
  const { t, tKey, tError } = useI18n();
  // The load below must not run again when the language changes (it would throw away what was typed), so it reads these through a ref.
  const text = useRef({ t, tError });
  text.current = { t, tError };
  const [fields, setFields] = useState<SettingsConfigField[] | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const adopt = useCallback((state: SettingsConfigState) => {
    setFields(state.fields);
    setDraft(Object.fromEntries(state.fields.map((f) => [f.key, toDraft(f)])));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getSettingsConfig(controller.signal)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 409) setStatus({ kind: "unreadable", message: data.message ?? "" });
        else if (res.ok) adopt(data);
        else setStatus({ kind: "failed", message: text.current.tError(data, text.current.t("settings.saveFailed")) });
      })
      .catch(() => { if (!controller.signal.aborted) setStatus({ kind: "failed", message: text.current.t("settings.saveFailed") }); });
    return () => controller.abort();
  }, [adopt]);

  useRegisterDirty(dirty, fields !== null && fields.some((f) => draft[f.key] !== toDraft(f)));

  const save = async () => {
    if (!fields) return;
    setStatus({ kind: "saving" });
    setErrors({});
    const values = Object.fromEntries(fields.map((f) => [f.key, fromDraft(f, draft[f.key])]));
    try {
      const res = await api.saveSettingsConfig(values);
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
  if (!fields) return <p className="settings-dim">{status.kind === "failed" ? status.message : t("common.loading")}</p>;

  const groups = [...new Set(fields.map((f) => f.group))];
  const set = (key: string, value: string | boolean) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setStatus({ kind: "idle" });
  };

  return (
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {groups.map((group) => (
        <section className="settings-section" key={group}>
          <h2>{t(`settings.group.${group}` as never)}</h2>
          {fields.filter((f) => f.group === group).map((field) => {
            const id = `field-${field.key}`;
            const error = errors[field.key];
            return (
              <div className="settings-field" key={field.key}>
                <label htmlFor={id}>{tKey(`settings.field.${field.key}`, field.key)}</label>
                {field.type === "enum" && (
                  <select id={id} value={String(draft[field.key])} onChange={(e) => set(field.key, e.target.value)}>
                    <option value="">{t("settings.useDefault")}</option>
                    {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                )}
                {field.type === "text" && (
                  <input id={id} type="text" value={String(draft[field.key])} placeholder={defaultText(field)} onChange={(e) => set(field.key, e.target.value)} />
                )}
                {field.type === "number" && (
                  <input id={id} type="number" min={field.min} max={field.max} step={1} value={String(draft[field.key])} placeholder={defaultText(field)} onChange={(e) => set(field.key, e.target.value)} />
                )}
                {field.type === "boolean" && (
                  <input id={id} type="checkbox" checked={Boolean(draft[field.key])} onChange={(e) => set(field.key, e.target.checked)} />
                )}
                {field.type === "list" && (
                  <textarea id={id} rows={3} value={String(draft[field.key])} placeholder={Array.isArray(field.default) ? field.default.join("\n") : ""} onChange={(e) => set(field.key, e.target.value)} />
                )}
                <p className="settings-help">
                  {tKey(`settings.help.${field.key}`, "")}{" "}
                  <span className="settings-dim">
                    {field.default === null ? t("settings.defaultSame") : t("settings.defaultValue", { value: defaultText(field) })}
                  </span>
                </p>
                {error && <p className="settings-error">{tKey(error, error)}</p>}
              </div>
            );
          })}
        </section>
      ))}
      <div className="settings-actions">
        <button type="submit" disabled={status.kind === "saving"}>{status.kind === "saving" ? t("settings.saving") : t("settings.save")}</button>
        {status.kind === "saved" && <span className="settings-ok">{t("settings.saved")}</span>}
        {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
      </div>
    </form>
  );
}
