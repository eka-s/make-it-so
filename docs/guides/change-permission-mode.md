[日本語](change-permission-mode.ja.md)

# Changing the Permission Mode

Change how much the crew asks the captain to confirm before running tools.

## Values

| Value (claude) | Meaning |
|---|---|
| `default` | Confirm every operation that needs confirmation |
| `acceptEdits` | Do not confirm file edits |
| `plan` | Only make a plan, do not execute |
| `auto` | Decide automatically. **The default when not specified** (even commands that change state, like `touch`, pass without approval) |
| `bypassPermissions` | Confirm nothing |

kiro does not accept a permission mode (a warning is output and it runs with the default). A value that cannot be chosen (**including typos**) also produces a warning and runs with the default. **Warnings appear only in the server's log (`logs/` and the terminal you started it from). They do not appear on the screen.** The claude default is `auto` (pass without confirmation), so if you want a crew member to ask for confirmation, check after startup that there is no warning in the log.

## Steps

1. Write `permission_mode` in the configuration file.
   - A member's default: `crew.<member>.permission_mode` in `~/.make-it-so/roster.yml`
   - An override per ship: `crew.<role>.permission_mode` in `ship.yml` (this takes precedence)
2. Apply it. It is **applied when a session is created**, so it does not affect running sessions. Restart the server, or restart the session from the crew member's personnel record.

## Notes

- With `bypassPermissions`, the crew member edits files and runs commands with its own privileges, without confirmation. **On a server without authentication, this allows operations that affect their surroundings.** Use it only after understanding the scope ([Security](../security.md)).
- When permission is requested, you respond in the tray above the input box on the screen ([Screen behavior](../reference/behavior.md#pending-permissions)).
