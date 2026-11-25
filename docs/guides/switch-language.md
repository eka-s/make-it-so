[日本語](switch-language.ja.md)

# Switching the Language

There are two language settings.

| Setting | Applies to | How to switch |
|---|---|---|
| UI language | The text on the screen | The "Settings" section at the bottom of the left pane, or the View menu in the desktop app |
| Crew language | The language the crew speaks | The same section, or the same menu |

The supported values are `en` and `ja`.

## Switching from the screen

The "Settings" section at the bottom of the left pane has radio buttons for the theme, the UI language and the crew language. In the desktop app the View menu has the same choices (the words of the menu follow the UI language). The left pane can be hidden with the button at the left of the header; show it again to reach the choices (in a narrow window it opens over the conversation).

- When you switch, it is saved in the ship's DB. From then on, that value takes precedence over the default in `config.yml`.
- The UI language takes effect immediately.
- The crew language takes effect **from sessions created afterwards**. It does not affect running sessions, so to apply it right away, restart the session from the crew member's personnel record.

## Changing the default

For a ship that has never been switched from the screen, the default is written in `config.yml`.

```yaml
language: ja          # UI language (default: en)
crew_language: ja     # crew language (default: same as language)
```

An unsupported value is an error at startup.
