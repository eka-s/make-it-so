import { MessageProcessor, STRICT_VALIDATION, basicCatalog } from "@a2ui/web_core/v1_0";

/**
 * The pre-1.0 spellings of a data binding / function call. The v1.0 schema still accepts them, but the v1.0 web renderer
 * does not resolve them (a text field shows "[object Object]"), and models trained on the older spec write them, so they are
 * refused here with the spelling to use. A child-list template (`{ "componentId": ..., "path": ... }`) is a different thing — its
 * `path` is written without the `@` in v1.0 — and is left alone.
 */
const LEGACY_KEYS: Record<string, string> = { path: "@path", call: "@call" };

/** Finds `{ "path": ... }` / `{ "call": ... }` objects (the legacy spellings) inside a component, returning where they are. */
function legacyBindings(value: unknown, where: string, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => legacyBindings(v, `${where}/${i}`, found));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (!("componentId" in record)) {
      for (const [legacy, current] of Object.entries(LEGACY_KEYS)) {
        if (typeof record[legacy] === "string" && !(current in record)) found.push(`${where}: use "${current}" instead of "${legacy}"`);
      }
    }
    for (const [k, v] of Object.entries(record)) legacyBindings(v, `${where}/${k}`, found);
  }
  return found;
}

/** What a screen may be made of: no deleteSurface (nothing to delete, the screen is judged on its own). */
const ALLOWED_MESSAGES = ["createSurface", "updateComponents", "updateDataModel"];

/**
 * Checks A2UI v1.0 messages against the basic catalog by running them through a throwaway renderer-side processor with the strict
 * rules the library offers for an agent to check its messages by (an unknown component type, a missing root, a reference to a
 * component that does not exist, an orphan component, a wrong version or several operations in one message are all refused), so a crew
 * member learns of a mistake from the tool result instead of the captain seeing a blank screen. The messages must make exactly one
 * surface (the captain's values are kept for one surface). Returns the problems as text, or undefined when the messages are fine.
 * Each call is judged on its own: the messages must be self-contained (they start with createSurface).
 */
export function a2uiProblems(messages: Array<Record<string, unknown>>): string | undefined {
  const legacy = messages.flatMap((m, i) => {
    const components = (m.createSurface as { components?: unknown } | undefined)?.components ?? (m.updateComponents as { components?: unknown } | undefined)?.components;
    return legacyBindings(components, `messages[${i}]/components`);
  });
  if (legacy.length > 0) return `A2UI v1.0 data bindings and function calls are written with "@path" and "@call":\n${legacy.join("\n")}`;
  const processor = new MessageProcessor([basicCatalog]);
  try {
    const errors = processor.processMessagesWithErrors(messages, {
      validationConfig: { ...STRICT_VALIDATION, targetVersion: "1.0", allowedMessages: ALLOWED_MESSAGES },
    });
    if (errors.length > 0) return errors.map((e) => JSON.stringify(e.error)).join("\n");
    if (processor.getSurfaces().size !== 1) return "The messages must make exactly one surface (start with a createSurface).";
    return undefined;
  } finally {
    processor.dispose();
  }
}
