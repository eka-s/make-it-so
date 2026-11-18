// Matches several space-separated tokens with AND (e.g. "te A" narrows to
// names containing both "te" and "A"). Case-insensitive.
export function matchesFilter(name: string, filterText: string): boolean {
  const tokens = filterText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const lowerName = name.toLowerCase();
  return tokens.every((token) => lowerName.includes(token.toLowerCase()));
}
