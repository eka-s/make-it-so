[日本語](create-fleet-and-ship.ja.md)

# Creating a Fleet and a Ship from Scratch

Starting from nothing, create the smallest working configuration, then add crew members one at a time.

## Prerequisites

- Node.js 22.13 or later.
- The agent CLI of the provider you use is ready (for claude, `npx` and a Claude Code login; for kiro, `kiro-cli` and a login). If the launch command cannot be found, a warning appears in the output of step 1 and in the server's startup log. Whether you are logged in cannot be checked.

## Steps

1. Create the minimal configuration.

   ```
   npm run init -- --provider claude --ship my-ship --port 3939
   ```

   | Argument | Default | Meaning |
   |---|---|---|
   | `--provider` | `claude` | The provider to use (`claude` or `kiro`) |
   | `--ship` | `my-ship` | The ship's ID (the directory name) |
   | `--port` | `3939` | The ship's port |

   What is created (inside `~/.make-it-so/` in the home directory): `config.yml`, `roster.yml` (one crew member), and `~/.make-it-so/ships/{ship ID}/ship.yml` (that crew member is the commander). **Existing files are not overwritten.** If even one already exists, it writes nothing, shows the conflicting file, and stops.

2. Build and start.

   ```
   npm run build && npm start
   ```

   Open `http://127.0.0.1:3939/` in the browser. When there are several ships, add `--ship`, as in `npm start -- --ship <ship ID>` ([Running multiple ships](run-multiple-ships.md)).

3. Talk to the crew member to confirm that it works. Write in the input box and send with Ctrl+Enter.

## Adding crew members

1. Add members to `~/.make-it-so/roster.yml`.

   ```yaml
   crew:
     alex:
       name: Alex
     sam:
       name: Sam
       model: sonnet
   ```

2. Add roles under `crew:` in `~/.make-it-so/ships/{ship ID}/ship.yml`.

   ```yaml
   crew:
     lead:
       member: alex
       rank: commander
     engineer:
       member: sam
       rank: chief
   ```

   A role name is free as long as it consists of alphanumerics, `_`, and `-` (starting with an alphanumeric). `rank` determines the task permissions ([Concepts](../concepts.md#ranks)).

3. Restart the server. The configuration is read at startup.

## Adding a persona and an icon

- Persona: write the tone and personality in `~/.make-it-so/personnel/{ID}.md` (no persona if absent).
- Icon: place `~/.make-it-so/personnel/{ID}.png`, or upload it from the crew member's personnel record on the screen.

## When things go wrong

If startup stops at validation, the message shows the cause. For the list, see the [Configuration Reference](../reference/configuration.md#startup-validation-and-errors).
