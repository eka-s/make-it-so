// Messages the server writes into the chat timeline (and stores in the database).
// The text is English and is what API consumers / old clients see; the client shows
// the translation of `key` instead (dictionary keys are "msg.<key>").
// Messages are stored with their key, so changing the language later also changes
// how they read. Rows saved before the key existed keep their saved text.

export const SERVER_MESSAGES = {
  recovery_started: "⚠️ A temporary error occurred. Recovering automatically...",
  recovery_rerun: "ℹ️ Re-run automatically after a recovery",
  interrupted: "⚠️ Interrupted: the server stopped before this finished. What was written so far is kept.",
  recovery_failed: "❌ Automatic recovery failed. Please recover manually with the restart button",
} as const;

export type ServerMessageKey = keyof typeof SERVER_MESSAGES;
