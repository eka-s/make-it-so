import "./GapRow.css";
import type { Gap } from "./chat-state";
import { useT } from "./i18n/I18nProvider";

type GapRowProps = {
  gap: Gap;
  /** "top": load the messages that follow the older chunk. "bottom": load the messages before the newer chunk. */
  onFill: (gap: Gap, side: "top" | "bottom") => void;
};

/**
 * Drawn between two loaded stretches of the history when the messages in between are not
 * loaded (after jumping to an old pin). Each button loads one page from its own end of the
 * hole; the row disappears when nothing is left in between.
 */
export function GapRow({ gap, onFill }: GapRowProps) {
  const t = useT();
  const busy = gap.loading !== undefined;
  return (
    <div className="gap-row" role="group" aria-label={t("gap.hint")}>
      <button className="gap-row-btn" disabled={busy} onClick={() => onFill(gap, "top")}>
        {gap.loading === "top" ? t("common.loading") : t("gap.next")}
      </button>
      <span className="gap-row-hint">{t("gap.hint")}</span>
      <button className="gap-row-btn" disabled={busy} onClick={() => onFill(gap, "bottom")}>
        {gap.loading === "bottom" ? t("common.loading") : t("gap.previous")}
      </button>
    </div>
  );
}
