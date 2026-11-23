import { ActionMessageSchema, type ActionMessage } from "@a2ui/web_core/v1_0";

/** The `action` of an A2UI v1.0 action message: what the renderer reports when the captain presses a button of a form. */
export type A2uiAction = ActionMessage["action"];

/**
 * The A2UI action in a request body, or undefined if it is not one. Only the fields of the A2UI v1.0 action message the renderer
 * reports are taken (name, surfaceId, sourceComponentId, timestamp, context); the author-written `userMessage` and the extension
 * `metadata` are left out, so what the captain "says" is never worded by the form's author.
 */
export function parseA2uiAction(value: unknown): A2uiAction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, surfaceId, sourceComponentId, timestamp, context } = value as Record<string, unknown>;
  const parsed = ActionMessageSchema.safeParse({ version: "1.0", action: { name, surfaceId, sourceComponentId, timestamp, context } });
  return parsed.success ? parsed.data.action : undefined;
}

/**
 * The message the crew member receives (and the conversation context carries) for the captain's answer to a form it drew: the A2UI
 * action message itself, as JSON in a fenced block marked `a2ui-action`, then the comment the captain wrote with it (if any). The
 * comment is outside the block because an A2UI action has no place for free text.
 */
export function a2uiAnswerText(action: A2uiAction, comment = ""): string {
  const message: ActionMessage = { version: "1.0", action };
  const note = comment.trim() ? `\nCaptain's comment:\n${comment.trim()}` : "";
  return `\`\`\`a2ui-action\n${JSON.stringify(message)}\n\`\`\`${note}`;
}

/** The id of the surface a form's messages create (undefined if they create none). */
export function a2uiSurfaceId(messages: Array<Record<string, unknown>>): string | undefined {
  for (const message of messages) {
    const surfaceId = (message.createSurface as { surfaceId?: unknown } | undefined)?.surfaceId;
    if (typeof surfaceId === "string") return surfaceId;
  }
  return undefined;
}
