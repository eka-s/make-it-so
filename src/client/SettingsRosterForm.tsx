import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./server-api";
import type { SettingsMember, SettingsMemberFields, SettingsRosterState } from "./types";
import { useI18n } from "./i18n/I18nProvider";
import { confirmDiscard, useRegisterDirty, type DirtyRegistry } from "./use-unsaved";

// The roster form: the crew members of the fleet, with their persona and icon. The server validates and decides what
// can be removed; this draws the form and shows the errors next to the fields.

type Draft = { name: string; provider: string; model: string; permission_mode: string; rules: string; skills: string };
type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

const NEW = "";

const toDraft = (m: SettingsMember | null): Draft => ({
  name: m?.name ?? "", provider: m?.provider ?? "", model: m?.model ?? "", permission_mode: m?.permission_mode ?? "",
  rules: (m?.rules ?? []).join("\n"), skills: (m?.skills ?? []).join("\n"),
});

const toFields = (d: Draft): SettingsMemberFields => ({
  name: d.name,
  provider: d.provider || null,
  model: d.model || null,
  permission_mode: d.permission_mode || null,
  rules: d.rules.split("\n"),
  skills: d.skills.split("\n"),
});

export function SettingsRosterForm({ dirty }: { dirty?: DirtyRegistry }) {
  const { t, tKey, tError } = useI18n();
  // The load below must not run again when the language changes (it would throw away what was typed).
  const text = useRef({ t, tError });
  text.current = { t, tError };
  // Answers to a slow member click must not overwrite a later one.
  const selectSeq = useRef(0);
  const [roster, setRoster] = useState<SettingsRosterState | null>(null);
  const [selected, setSelected] = useState<string | null>(null); // a member ID, NEW ("") while adding, or null
  const [newId, setNewId] = useState("");
  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [persona, setPersona] = useState("");
  // The persona as the server has it: the persona has its own save button, and unsaved text in it counts as unsaved input too.
  const [personaSaved, setPersonaSaved] = useState("");
  const [personaStatus, setPersonaStatus] = useState<Status>({ kind: "idle" });
  const [iconVersion, setIconVersion] = useState(0);
  const [iconError, setIconError] = useState(false);
  const [hasIcon, setHasIcon] = useState(true);

  const failed = useCallback((data: unknown) => ({ kind: "failed" as const, message: tError(data as never, t("settings.saveFailed")) }), [t, tError]);

  useEffect(() => {
    const controller = new AbortController();
    api.getSettingsRoster(controller.signal)
      .then(async (res) => {
        const data = await res.json();
        const { t: tNow, tError: tErrorNow } = text.current;
        if (res.ok) setRoster(data);
        else setStatus(res.status === 409 ? { kind: "failed", message: tNow("settings.unreadable", { message: data.message ?? "" }) } : { kind: "failed", message: tErrorNow(data, tNow("settings.saveFailed")) });
      })
      .catch(() => { if (!controller.signal.aborted) setStatus({ kind: "failed", message: text.current.t("settings.saveFailed") }); });
    return () => controller.abort();
  }, []);

  const member = roster?.members.find((m) => m.id === selected) ?? null;

  // Unsaved input: a new member being typed, or an existing one whose fields differ from what the server has.
  const isDirty = selected === NEW
    ? newId !== "" || JSON.stringify(draft) !== JSON.stringify(toDraft(null))
    : member !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(member));  // toDraft makes the text of the form from a member, so equal members give equal text
  useRegisterDirty(dirty, isDirty || persona !== personaSaved);

  const select = (id: string | null) => {
    if (!confirmDiscard(isDirty || persona !== personaSaved, t("settings.unsaved"))) return;
    const seq = ++selectSeq.current;
    const m = roster?.members.find((x) => x.id === id) ?? null;
    setSelected(id);
    setNewId("");
    setDraft(toDraft(m));
    setErrors({});
    setStatus({ kind: "idle" });
    setPersonaStatus({ kind: "idle" });
    setPersona("");
    setPersonaSaved("");
    setHasIcon(true);
    setIconError(false);
    setIconVersion((v) => v + 1);
    if (id) {
      void api.getSettingsPersona(id)
        .then(async (res) => {
          if (!res.ok || seq !== selectSeq.current) return;
          const loaded: string = (await res.json()).text;
          setPersona(loaded);
          setPersonaSaved(loaded);
        })
        .catch(() => { /* the persona stays empty; the form shows its own load state */ });
    }
  };

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setStatus({ kind: "idle" });
  };

  const save = async () => {
    const creating = selected === NEW;
    const id = creating ? newId.trim() : (selected ?? "");
    setStatus({ kind: "saving" });
    setErrors({});
    try {
      const res = creating ? await api.createSettingsMember(id, toFields(draft)) : await api.saveSettingsMember(id, toFields(draft));
      const data = await res.json();
      if (res.ok) {
        setRoster(data);
        setStatus({ kind: "saved" });
        if (creating) {
          setSelected(id);
          setNewId("");
        }
        setDraft(toDraft(data.members.find((m: SettingsMember) => m.id === id) ?? null));
      } else if (data.errors) {
        setErrors(data.errors);
        setStatus({ kind: "idle" });
      } else {
        setStatus(failed(data));
      }
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const remove = async () => {
    if (!member || !window.confirm(t("settings.roster.deleteConfirm", { name: member.name || member.id }))) return;
    try {
      const res = await api.deleteSettingsMember(member.id);
      const data = await res.json();
      if (res.ok) {
        setRoster(data);
        // What is on screen is the member that was just removed: nothing to ask about.
        setDraft(toDraft(null));
        selectSeq.current++;
        setSelected(null);
      } else if (data.errors) {
        setErrors(data.errors);
      } else {
        setStatus(failed(data));
      }
    } catch {
      setStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const savePersona = async () => {
    if (!member) return;
    setPersonaStatus({ kind: "saving" });
    try {
      const res = await api.saveSettingsPersona(member.id, persona);
      if (res.ok) {
        const data = await res.json();
        setPersona(data.text);
        setPersonaSaved(data.text);
        setPersonaStatus({ kind: "saved" });
        setRoster((r) => r && { ...r, members: r.members.map((m) => (m.id === member.id ? { ...m, hasPersona: data.exists } : m)) });
      } else setPersonaStatus(failed(await res.json()));
    } catch {
      setPersonaStatus({ kind: "failed", message: t("settings.saveFailed") });
    }
  };

  const upload = async (file: File | undefined) => {
    if (!member || !file) return;
    try {
      const res = await api.uploadSettingsIcon(member.id, file);
      if (res.ok) {
        setIconError(false);
        setHasIcon(true);
        setIconVersion((v) => v + 1);
      } else setIconError(true);
    } catch {
      setIconError(true);
    }
  };

  const removeIcon = async () => {
    if (!member) return;
    try {
      await api.deleteSettingsIcon(member.id);
      setHasIcon(false);
      setIconError(false);
    } catch {
      setIconError(true);
    }
  };

  if (!roster) return <p className="settings-dim">{status.kind === "failed" ? status.message : t("common.loading")}</p>;

  const err = (key: string) => errors[key] && <p className="settings-error">{tKey(errors[key], errors[key])}</p>;
  const editing = selected !== null;

  return (
    <div className="settings-roster">
      <aside className="settings-roster-list">
        <h2>{t("settings.roster.members")}</h2>
        {roster.members.length === 0 && <p className="settings-dim">{t("settings.roster.none")}</p>}
        <ul className="settings-list">
          {roster.members.map((m) => (
            <li key={m.id}>
              <button type="button" className={m.id === selected ? "settings-member settings-member--active" : "settings-member"} onClick={() => select(m.id)}>
                <code>{m.id}</code> {m.name}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="settings-add" onClick={() => select(NEW)}>{t("settings.roster.add")}</button>
      </aside>

      <section className="settings-roster-detail">
        {!editing && <p className="settings-dim">{t("settings.roster.pick")}</p>}
        {editing && (
          <form className="settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="settings-field">
              <label htmlFor="member-id">{t("settings.roster.id")}</label>
              {selected === NEW
                ? <input id="member-id" type="text" value={newId} onChange={(e) => { setNewId(e.target.value); setStatus({ kind: "idle" }); }} />
                : <code>{selected}</code>}
              {selected === NEW && <p className="settings-help">{t("settings.roster.idHelp")}</p>}
              {err("id")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-name">{t("settings.roster.name")}</label>
              <input id="member-name" type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              {err("name")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-provider">{t("settings.roster.provider")}</label>
              <select id="member-provider" value={draft.provider} onChange={(e) => set({ provider: e.target.value })}>
                <option value="">{t("settings.useDefault")}</option>
                {roster.providers.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <p className="settings-help">{t("settings.roster.providerHelp")}</p>
              {err("provider")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-model">{t("settings.roster.model")}</label>
              <input id="member-model" type="text" value={draft.model} onChange={(e) => set({ model: e.target.value })} />
              <p className="settings-help">{t("settings.roster.modelHelp")}</p>
              {err("model")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-mode">{t("settings.roster.permissionMode")}</label>
              <input id="member-mode" type="text" list="permission-modes" value={draft.permission_mode} onChange={(e) => set({ permission_mode: e.target.value })} />
              <datalist id="permission-modes">{roster.permissionModes.map((m) => <option key={m} value={m} />)}</datalist>
              <p className="settings-help">{t("settings.roster.permissionModeHelp")}</p>
              {err("permission_mode")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-rules">{t("settings.roster.rules")}</label>
              <textarea id="member-rules" rows={3} value={draft.rules} onChange={(e) => set({ rules: e.target.value })} />
              <p className="settings-help">{t("settings.roster.rulesHelp")}</p>
              {err("rules")}
            </div>
            <div className="settings-field">
              <label htmlFor="member-skills">{t("settings.roster.skills")}</label>
              <textarea id="member-skills" rows={3} value={draft.skills} onChange={(e) => set({ skills: e.target.value })} />
              <p className="settings-help">{t("settings.roster.skillsHelp")}</p>
              {err("skills")}
            </div>
            {member && member.usedBy.length > 0 && (
              <p className="settings-dim">{t("settings.roster.usedBy", { where: member.usedBy.map((u) => `${u.ship}/${u.role}`).join(", ") })}</p>
            )}
            <div className="settings-actions">
              <button type="submit" disabled={status.kind === "saving"}>{selected === NEW ? t("settings.roster.create") : t("settings.save")}</button>
              {member && <button type="button" className="settings-danger" onClick={() => void remove()}>{t("settings.roster.delete")}</button>}
              {status.kind === "saved" && <span className="settings-ok">{t("settings.saved")}</span>}
              {status.kind === "failed" && <span className="settings-error">{status.message}</span>}
            </div>
          </form>
        )}

        {member && (
          <>
            <div className="settings-field">
              <label htmlFor="member-persona">{t("settings.roster.persona")}</label>
              <textarea id="member-persona" rows={12} value={persona} onChange={(e) => { setPersona(e.target.value); setPersonaStatus({ kind: "idle" }); }} />
              <p className="settings-help">{t("settings.roster.personaHelp")}</p>
              <div className="settings-actions">
                <button type="button" onClick={() => void savePersona()} disabled={personaStatus.kind === "saving"}>{t("settings.roster.savePersona")}</button>
                {personaStatus.kind === "saved" && <span className="settings-ok">{t("settings.saved")}</span>}
                {personaStatus.kind === "failed" && <span className="settings-error">{personaStatus.message}</span>}
              </div>
            </div>
            <div className="settings-field">
              <label htmlFor="member-icon-file">{t("settings.roster.icon")}</label>
              {hasIcon
                ? <img className="settings-icon" src={api.settingsIconUrl(member.id, iconVersion)} alt="" onError={() => setHasIcon(false)} />
                : <p className="settings-dim">{t("settings.roster.noIcon")}</p>}
              <p className="settings-help">{t("settings.roster.iconHelp")}</p>
              <div className="settings-actions">
                <input id="member-icon-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t("settings.roster.upload")} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
                {hasIcon && <button type="button" onClick={() => void removeIcon()}>{t("settings.roster.removeIcon")}</button>}
              </div>
              {iconError && <p className="settings-error">{t("settings.error.iconRejected")}</p>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
