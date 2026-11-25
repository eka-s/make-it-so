/** Three lines. `short`: the middle one is shorter (the header's button, which is also the frame's own shape in the classic theme). */
export function HamburgerIcon({ short = false }: { short?: boolean }) {
  return (
    <svg className="app-icon" viewBox="0 0 16 16" aria-hidden="true">
      <line x1="2" y1="4" x2="14" y2="4" />
      <line x1="2" y1="8" x2={short ? 11 : 14} y2="8" />
      <line x1="2" y1="12" x2="14" y2="12" />
    </svg>
  );
}
