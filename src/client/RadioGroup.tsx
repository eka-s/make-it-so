import { useId } from "react";
import "./RadioGroup.css";

/**
 * A vertical group of radio buttons with a caption. They are real radio inputs (keyboard and screen readers work as they do for any radio), which the
 * classic theme draws as LCARS bars instead (RadioGroup.css).
 */
export function RadioGroup<T extends string>({ label, options, value, onChange }: {
  label: string;
  /** `lang`: the language of the label, when it is not the page's own (a language named in itself). */
  options: { value: T; label: string; lang?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="radio-group">
      <legend className="radio-group-label">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="radio-group-option">
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span lang={option.lang}>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
