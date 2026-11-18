[日本語](switch-language.ja.md)

# Switching the Language

There are two language settings.

| Setting | Applies to | How to switch |
|---|---|---|
| UI language | The text on the screen | The language label in the header (click it) |
| Crew language | The language the crew speaks | The same popup, second switch |

The supported values are `en` and `ja`.

## Switching from the screen

The header shows a small label such as `EN / 日本語`: the UI language first, then the crew language. Hover over it to see what it means, and click it to open a popup with two switches, "UI" and "Crew".

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
