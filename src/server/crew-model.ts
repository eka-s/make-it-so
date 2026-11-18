// Deciding the model a crew member uses, and extracting model information from ACP responses.
// Both are pure functions (no side effects).

/** One selectable model (an option of `model` in ACP's `configOptions`). */
export type ModelOption = { value: string; name: string };

/** The model the session is currently using, and the list of selectable models. */
export type ModelState = { current: string; options: ModelOption[] };

/** Where the model actually used comes from. */
export type ModelSource =
  /** A per-mission override (changed from the screen, saved in the DB). */
  | "mission"
  /** `model` in ship.yml or roster.yml (the ship's setting takes priority over the roster). */
  | "config"
  /** Not specified (the provider's default stays). */
  | "default";

/**
 * Decides the model to use. The priority is
 * mission override > ship.yml > roster.yml > provider default.
 * ship.yml and roster.yml are already merged when the config is loaded (`configured`), so
 * the only thing checked here is whether there is an override.
 */
export function resolveCrewModel(input: {
  override?: string | null;
  configured?: string | null;
}): { model: string | undefined; source: ModelSource } {
  if (input.override) return { model: input.override, source: "mission" };
  if (input.configured) return { model: input.configured, source: "config" };
  return { model: undefined, source: "default" };
}

/**
 * Extracts model information from the response of ACP's `session/new` / `session/set_config_option`.
 * Returns null when `configOptions` has no `id: "model"` option (a provider that does not support model switching)
 * or when the shape is unexpected.
 */
export function parseModelState(result: unknown): ModelState | null {
  const options = (result as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(options)) return null;
  const model = options.find((o) => (o as { id?: unknown })?.id === "model") as
    | { currentValue?: unknown; options?: unknown }
    | undefined;
  if (!model || typeof model.currentValue !== "string" || !Array.isArray(model.options)) return null;
  const list: ModelOption[] = [];
  for (const o of model.options) {
    const { value, name } = (o ?? {}) as { value?: unknown; name?: unknown };
    if (typeof value === "string") list.push({ value, name: typeof name === "string" ? name : value });
  }
  return { current: model.currentValue, options: list };
}

/**
 * Extracts the list of values of the option with the given id from `configOptions` in the response of ACP's `session/new`.
 * Returns an empty array when there is no option with that id or the shape is unexpected.
 */
function parseOptionValues(result: unknown, id: string): string[] {
  const options = (result as { configOptions?: unknown } | null)?.configOptions;
  if (!Array.isArray(options)) return [];
  const option = options.find((o) => (o as { id?: unknown })?.id === id) as { options?: unknown } | undefined;
  if (!option || !Array.isArray(option.options)) return [];
  return option.options
    .map((o) => (o as { value?: unknown })?.value)
    .filter((v): v is string => typeof v === "string");
}

/** List of selectable permission mode values (`id: "mode"`). */
export function parseModeValues(result: unknown): string[] {
  return parseOptionValues(result, "mode");
}

/**
 * List of selectable agent values (provider-side agent definitions; `id: "agent"`). In claude, custom agents such as those in
 * the cwd's `.claude/agents/` appear alongside `default`.
 */
export function parseAgentValues(result: unknown): string[] {
  return parseOptionValues(result, "agent");
}
