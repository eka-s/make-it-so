// The defaults of config.yml. load-config.ts applies them and the settings screen shows them, so both read them from here.

export const PROVIDERS = ["kiro", "claude"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONFIG_DEFAULTS = {
  provider: "claude" as Provider,
  kiro: { command: "kiro-cli", args: ["acp"] },
  // The adapter version is pinned: an update of the adapter can change its behavior.
  claude: { command: "npx", args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.106.0"] },
  host: "127.0.0.1",
  debug: false,
  logLevel: "info" as LogLevel,
  maxFileSizeMb: 5,
};
