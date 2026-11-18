import type { CrewModelEntry } from "./types";
import { useT } from "./i18n/I18nProvider";

/** Model selector. Disabled when the selectable models are unknown (unsupported / session not started). */
export function CrewModelSelect({ entry, onChange }: { entry: CrewModelEntry; onChange: (value: string) => void }) {
  const t = useT();
  const disabled = entry.options.length === 0;
  // Show the option to go back to the default only when none is specified or it is being changed on screen
  const showReset = entry.source === "mission" || entry.effective === null;
  const value = entry.effective ?? (disabled ? "" : entry.live ?? "");
  return (
    <label
      className="crew-status-model"
      onClick={(e) => e.stopPropagation()}
      title={disabled ? t("crew.model.unavailable") : entry.source === "mission" ? t("crew.model.changedHere") : undefined}
    >
      <span className="crew-status-model-label">{entry.source === "mission" ? t("crew.model.labelChanged") : t("crew.model.label")}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {showReset && <option value="">{entry.source === "mission" ? t("crew.model.reset") : t("crew.model.default")}</option>}
        {entry.options.map((o) => <option key={o.value} value={o.value}>{o.name}</option>)}
      </select>
    </label>
  );
}
