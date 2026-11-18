import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsHost, SettingsHostsState } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { useRegisterDirty, type DirtyRegistry } from "./use-unsaved";

// The hosts.yml form: remote hosts as name → destination. The server decides what is valid and which hosts are in use.

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string } | { kind: "unreadable"; message: string };

export function SettingsHostsForm({ dirty }: { dirty?: DirtyRegistry }) {
  const { t, tKey, tError } = useI18n();
  // The load below must not run again when the language changes (it would throw away what was typed).
  const text = useRef({ t, tError });
  text.current = { t, tError };
  const [hosts, setHosts] = useState<SettingsHost[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // The list as the server last gave it: a removed host that the server refuses to remove comes back from here, with its error.
  const [saved, setSaved] = useState<SettingsHost[]>([]);

  const adopt = useCallback((state: SettingsHostsState) => {
    setHosts(state.hosts);
    setSaved(state.hosts);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getSettingsHosts(controller.signal)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 409) setStatus({ kind: "unreadable", message: data.message ?? "" });
        else if (res.ok) adopt(data);
        else setStatus({ kind: "failed", message: text.current.tError(data, text.current.t("settings.saveFailed")) });
      })
      .catch(() => { if (!controller.signal.aborted) setStatus({ kind: "failed", message: text.current.t("settings.saveFailed") }); });
    return () => controller.abort();
  }, [adopt]);

  const pair = (list: SettingsHost[]) => JSON.stringify(list.map((h) => [h.name.trim(), h.destination.trim()]));
  useRegisterDirty(dirty, hosts !== null && pair(hosts) !== pair(saved));

  const save = async () => {
    if (!hosts) return;
    setStatus({ kind: "saving" });
    setErrors({});
    try {
      const res = await api.saveSettingsHosts(hosts.map(({ name, destination }) => ({ name: name.trim(), destination: destination.trim() })));
      const data = await res.json();
      if (res.ok) {
        adopt(data);
        setStatus({ kind: "saved" });
      } else if (res.status === 400 && data.errors) {
        const errorsByName: Record<string, string> = data.errors;
        setErrors(errorsByName);
        // Put back a host that was removed but cannot be, so the error shows next to it.
        setHosts((list) => {
          const names = new Set((list ?? []).map((h) => h.name.trim()));
          const restored = saved.filter((h) => errorsByName[h.name] && !names.has(h.name));
          return [...(list ?? []), ...restored];
        });
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
  if (!hosts) return <p className="settings-dim">{status.kind === "failed" ? status.message : t("common.loading")}</p>;

  const update = (index: number, patch: Partial<SettingsHost>) => {
    setHosts((list) => (list ?? []).map((h, i) => (i === index ? { ...h, ...patch } : h)));
    setStatus({ kind: "idle" });
  };

  return (
    <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <p className="settings-help">{t("settings.hosts.help")}</p>
      {hosts.length === 0 && <p className="settings-dim">{t("settings.hosts.none")}</p>}
      {hosts.map((host, index) => (
        <div className="settings-host" key={index}>
          <input aria-label={t("settings.hosts.name")} placeholder={t("settings.hosts.name")} value={host.name} onChange={(e) => update(index, { name: e.target.value })} />
          <input aria-label={t("settings.hosts.destination")} placeholder={t("settings.hosts.destination")} value={host.destination} onChange={(e) => update(index, { destination: e.target.value })} />
          <button type="button" onClick={() => { setHosts((list) => (list ?? []).filter((_, i) => i !== index)); setStatus({ kind: "idle" }); }}>
            {t("settings.hosts.remove")}
          </button>
          {host.usedBy.length > 0 && <span className="settings-dim">{t("settings.hosts.usedBy", { ships: host.usedBy.join(", ") })}</span>}
          {errors[host.name] && <span className="settings-error">{tKey(errors[host.name], errors[host.name])}</span>}
        </div>
      ))}
      <div className="settings-actions">
        <button type="button" onClick={() => { setHosts((list) => [...(list ?? []), { name: "", destination: "", usedBy: [] }]); setStatus({ kind: "idle" }); }}>
          {t("settings.hosts.add")}
        </button>
        <button type="submit" disabled={status.kind === "saving"}>{status.kind === "saving" ? t("settings.saving") : t("settings.save")}</button>
        {status.kind === "saved" && <span className="settings-ok">{t("settings.saved")}</span>}
        {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
      </div>
    </form>
  );
}
