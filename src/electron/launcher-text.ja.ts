// The Japanese text of the ship chooser (the only Japanese in src/electron; see no-hardcoded-japanese.test.ts).
export const LAUNCHER_TEXT_JA = {
  title: "船を選んでください",
  none: "まだ船がありません。",
  noneHint: "`npm run init`、または設定画面（`npm start -- --settings`）で作れます。",
  broken: "開けません",
  opening: "開いています…",
} as const;
