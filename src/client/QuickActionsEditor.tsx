import { useI18n } from "./i18n/I18nProvider";
import "./QuickActionsEditor.css";

// The rows of the custom menu editor, shared by the ship's popup and the settings app. The caller owns the list and the saving;
// the server decides what is valid (`errors` is by index).

export type EditRow = {
  id?: string;
  name: string;
  kind: "message" | "slash";
  command: string;
  send: "now" | "fill";
  /** Settings app only: where the item is enabled. */
  ships?: "all" | string[];
  /** Settings app only: with `ships: "all"`, the ships it is switched off on. */
  except?: string[];
  /** Ship popup only: other ships have this item too. */
  shared?: boolean;
};

export const NEW_ROW: EditRow = { name: "", kind: "message", command: "", send: "now" };

type Props = {
  rows: EditRow[];
  onChange: (rows: EditRow[]) => void;
  errors: Record<string, string>;
  /** When given, each row can say on which ships it is enabled (the settings app). */
  ships?: { id: string; name: string }[];
};

export function QuickActionsEditor({ rows, onChange, errors, ships }: Props) {
  const { t, tKey } = useI18n();
  const update = (index: number, patch: Partial<EditRow>) => onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const move = (index: number, by: number) => {
    const to = index + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  };

  return (
    <div className="qa-editor">
      {rows.length === 0 && <p className="qa-editor-empty">{t("quickActions.empty")}</p>}
      {rows.map((row, index) => (
        <div className="qa-row" key={row.id ?? `new-${index}`}>
          <div className="qa-row-main">
            <input className="qa-name" aria-label={t("quickActions.editor.name")} placeholder={t("quickActions.editor.name")} value={row.name} maxLength={40} onChange={(e) => update(index, { name: e.target.value })} />
            <select aria-label={t("quickActions.editor.kind")} value={row.kind} onChange={(e) => update(index, { kind: e.target.value as EditRow["kind"] })}>
              <option value="message">{t("quickActions.kind.message")}</option>
              <option value="slash">{t("quickActions.kind.slash")}</option>
            </select>
            <select aria-label={t("quickActions.editor.send")} value={row.send} onChange={(e) => update(index, { send: e.target.value as EditRow["send"] })}>
              <option value="now">{t("quickActions.send.now")}</option>
              <option value="fill">{t("quickActions.send.fill")}</option>
            </select>
            <span className="qa-row-buttons">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={t("quickActions.editor.up")} title={t("quickActions.editor.up")}>▲</button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === rows.length - 1} aria-label={t("quickActions.editor.down")} title={t("quickActions.editor.down")}>▼</button>
              <button type="button" onClick={() => onChange(rows.filter((_, i) => i !== index))}>{t("quickActions.editor.remove")}</button>
            </span>
          </div>
          <textarea
            className="qa-command"
            rows={row.kind === "slash" ? 1 : 2}
            aria-label={t("quickActions.editor.command")}
            placeholder={row.kind === "slash" ? t("quickActions.editor.commandSlash") : t("quickActions.editor.commandMessage")}
            value={row.command}
            onChange={(e) => update(index, { command: e.target.value })}
          />
          {ships && (
            <fieldset className="qa-ships">
              <legend>{t("quickActions.editor.ships")}</legend>
              <label>
                <input type="checkbox" checked={row.ships === "all"} onChange={(e) => update(index, e.target.checked ? { ships: "all", except: [] } : { ships: [], except: undefined })} />
                {t("quickActions.editor.allShips")}
              </label>
              {ships.map((ship) => {
                // With "all", a ticked ship is one that has the item (the unticked ones are in `except`).
                const all = row.ships === "all";
                const list = (all ? row.except : Array.isArray(row.ships) ? row.ships : []) ?? [];
                const on = all ? !list.includes(ship.id) : list.includes(ship.id);
                return (
                  <label key={ship.id}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        const add = all ? !e.target.checked : e.target.checked;
                        const next = add ? [...list, ship.id] : list.filter((s) => s !== ship.id);
                        update(index, all ? { except: next } : { ships: next });
                      }}
                    />
                    {ship.name}
                  </label>
                );
              })}
            </fieldset>
          )}
          {row.shared && <p className="qa-note">{t("quickActions.editor.shared")}</p>}
          {errors[index] && <p className="qa-error">{tKey(errors[index], errors[index])}</p>}
        </div>
      ))}
      {errors["-1"] && <p className="qa-error">{tKey(errors["-1"], errors["-1"])}</p>}
    </div>
  );
}
