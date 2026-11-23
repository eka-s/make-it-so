[English](data-model.md)

# データモデル

艦ごとのデータベース（SQLite）の構造と、スキーマ変更（マイグレーション）の規則です。

> **スキーマの正本は `src/server/migrations.ts` です。** この文書は列の意味と設計上の約束を説明するもので、列の型や制約の一覧は正本を参照してください。

## 目次

- [概要](#概要)
- [テーブルの一覧](#テーブルの一覧)
- [タイムラインのイベント](#タイムラインのイベント)
- [ミッションとPIN](#ミッションとpin)
- [クルーのタスク](#クルーのタスク)
- [設定とキャッシュ](#設定とキャッシュ)
- [共通の約束](#共通の約束)
- [マイグレーション](#マイグレーション)
- [バックアップと復元](#バックアップと復元)

## 概要

- 艦（`--ship`）ごとに 1 つのファイル `data/bridge.db` を使います（[設定](configuration.ja.md#ディレクトリ配置)）。
- 会話の履歴は**追記専用のイベントログ**として保存します。画面に出す `TimelineItem`（[HTTP API](http-api.ja.md#タイムライン)）は、このログから組み立てます。
- 起動時に、未適用のマイグレーションを自動で適用します。

## テーブルの一覧

| グループ | テーブル |
|---|---|
| タイムライン | `timeline_events`（幹）、各イベント種別の詳細テーブル（14 種） |
| ミッション | `missions`、`pinned_messages`、`mission_crew_model` |
| タスク | `task_started_events`、`task_completed_events`、`task_error_events`、`task_reported_events`、`task_id_counters` |
| A2UI のフォーム | `ui_shown_events`、`ui_answered_events`、`ui_dismissed_events` |
| 設定・キャッシュ | `app_settings`、`provider_model_options`、`provider_commands` |

## タイムラインのイベント

### 構造

履歴は「幹」と「詳細」の 2 段で持ちます（Class Table Inheritance）。

- 幹 `timeline_events` は、「いつ・どのミッションで・どの種類のイベントが起きたか」だけを記録します。
- 種類ごとの中身は、種類ごとの詳細テーブルに置きます。詳細テーブルの `event_id` は主キーであり、幹の `id` への外部キーです。**幹の 1 行に、詳細の 1 行が必ず対応します。**
- 幹と詳細は 1 つのトランザクションで書きます。途中で止まっても、詳細のない幹の行は残りません。

### `timeline_events`

| 列 | 意味 |
|---|---|
| `id` | イベントの通し番号。`TimelineItem` の `seq` になる |
| `event_type` | イベントの種類（下表） |
| `occurred_at` | 発生時刻 |
| `mission_id` | 属するミッション。すべての行に値がある |

### イベントの種類と詳細テーブル

| `event_type` | 詳細テーブル | 意味 | 主な列 |
|---|---|---|---|
| `captain_message` | `captain_message_events` | 艦長の発言 | `text` |
| `turn_started` | `turn_started_events` | ターンの開始 | `turn_id`, `agent` |
| `turn_completed` | `turn_completed_events` | ターンの完了（返答の本文） | `turn_id`, `text`, `credits_json`, `agent` |
| `turn_cancelled` | `turn_cancelled_events` | ターンの中止（途中までの本文） | `turn_id`, `text`, `credits_json`, `agent` |
| `turn_error` | `turn_error_events` | ターンの失敗 | `turn_id`, `partial_output`, `error_message`, `message_key`, `agent` |
| `turn_recovery_started` | `turn_recovery_started_events` | 失敗したターンの再開 | `turn_id`, `text`, `agent` |
| `system_notice` | `system_notice_events` | サーバーからのお知らせ | `text`, `message_key`, `agent` |
| `task_started` | `task_started_events` | タスクの発行 | [クルーのタスク](#クルーのタスク)を参照 |
| `task_completed` | `task_completed_events` | タスクの完了 | 同上 |
| `task_error` | `task_error_events` | タスクの失敗 | 同上 |
| `task_reported` | `task_reported_events` | タスクの結果を副長へ報告した | 同上 |
| `ui_shown` | `ui_shown_events` | クルーが、返信の下に、A2UI のフォームを見せた | [A2UI のフォーム](#a2ui-のフォーム) |
| `ui_answered` | `ui_answered_events` | 艦長が、A2UI のフォームに回答した | 同上 |
| `ui_dismissed` | `ui_dismissed_events` | 艦長が、A2UI のフォームを、回答せずに閉じた | 同上 |

画面に項目として出るのは、`captain_message`、`turn_completed`、`turn_cancelled`、`turn_error`、`system_notice`、`task_completed`、`task_error` です。`turn_started`、`turn_recovery_started`、`task_started`、`task_reported`、`ui_shown`、`ui_answered`、`ui_dismissed` は、履歴を完全に保つための記録で、単独では項目になりません。

### 列の意味

| 列 | 意味 |
|---|---|
| `turn_id` | ターンの識別子。開始・完了・中止・失敗を結びつける |
| `agent` | そのターンの話し手のエージェント名。ロールへの変換は艦の構成に依存するため、読み出し時に行う。古い行では空だったが、[v2](#バージョン一覧)で埋め直した |
| `credits_json` | そのターンの消費量。`{ credits, turnDurationMs, unit }` の JSON。`unit` は `usd`（推定費用）か `kiro_credits`。`unit` が無い古い記録は `kiro_credits` として扱う。空のこともある |
| `partial_output` | 失敗までに出力されていた本文。空のこともある |
| `message_key` | サーバー自身が書いた固定文のキー。クライアントが表示言語に合わせて文面を選ぶ。プロバイダーのエラー文など、固定文でないものは空 |

## ミッションとPIN

### `missions`

| 列 | 意味 |
|---|---|
| `id` | ミッションの識別子。既定のミッションは `bridge`（名前は `Bridge`）で、初期化時に必ず作られる |
| `name` | 表示名 |
| `created_at` | 作成時刻 |
| `archived_at` | 空なら表示中。値があれば、アーカイブした時刻（削除ではなく非表示）|

ミッションに「所属するクルー」はありません。クルーはどのミッションにも常におり、`@` で呼べます。この表は「会話の入れ物の一覧」にすぎません。

### `pinned_messages`

| 列 | 意味 |
|---|---|
| `id` | 連番 |
| `message_id` | PIN したメッセージの識別子。一意 |
| `role`, `text`, `timestamp` | PIN した時点のスナップショット（元のメッセージから再構築しない） |
| `pinned_at` | PIN した時刻 |
| `mission_id` | 属するミッション |

### `mission_crew_model`

ミッションごと・ロールごとのモデルの指定です。

| 列 | 意味 |
|---|---|
| `mission_id`, `role` | 主キー。担当者が変わっても、設定はロールに付いてくる |
| `model` | 指定したモデル |

既定は `ship.yml`/`roster.yml` の `model` です。行があればそれを優先し、行を消すと既定に戻ります。

## クルーのタスク

| テーブル | 列 | 意味 |
|---|---|---|
| `task_started_events` | `task_id`, `agent`, `task_name`, `instruction`, `turn_id`, `dispatched_by` | タスクの発行記録（永続）。`dispatched_by` は発行したエージェント。未報告タスクの見え方（副長は全部、他は自分が発行したもの）を決める |
| `task_completed_events` | `task_id`, `report`, `credits_json`, `cancelled` | 完了と報告本文。`cancelled` が 1 のものは、艦長が中止したタスクで、本文は中止までの出力 |
| `task_error_events` | `task_id`, `partial_output`, `error_message` | 失敗 |
| `task_reported_events` | `task_id`, `turn_id` | 「このタスクを、このターンで報告した」という事実 |
| `task_id_counters` | `agent`（主キー）, `next_seq` | タスク ID の連番 |

- タスク ID は `<役職名>_<4桁の連番>`（例: `chief_engineer_0001`。担当者を、メンバーIDで指定しても、役職名にそろえます）です。連番は `task_id_counters` の 1 行を UPSERT して払い出します。並行して発行しても重複しません。
- 「報告済み」は、完了・失敗の行を書き換えず、`task_reported_events` に行を足して表します。**未報告のタスクは、`task_reported_events` に行がないタスク**です。

## A2UI のフォーム

クルーは、`render_ui` で、返信の下に、操作できるフォーム（A2UI）を出せます。フォームは、**その返信（ターン）の項目の一部**で、独立した項目ではありません。フォームがどうなったかは、別々の事実として記録します。

| テーブル | 列 | 意味 |
|---|---|---|
| `ui_shown_events` | `turn_id`（一意）, `agent`, `messages_json` | クルーがフォームを見せた。`turn_id` は、フォームが出る返信（1つのターンに、フォームは1つまで）で、ほかの2つのテーブルでも、フォームを指す。`messages_json` は、A2UI v1.0 のメッセージ（surface は1つだけ） |
| `ui_answered_events` | `turn_id`（一意）, `action_json`, `data_model_json`, `comment` | 艦長がフォームに回答した（ボタンを押した）。どのフォームか（`turn_id`）、押したことで生じた A2UI のアクション（`action_json`: `name`、`surfaceId`、`sourceComponentId`、`timestamp`、`context`）、その時点のフォームの surface の値、フォームのコメント欄に書いたコメント（なければ空）。クルーが受け取った文面は、保存しない。会話の経緯を作るときに、`action_json` と `comment` から作る |
| `ui_dismissed_events` | `turn_id`（一意） | 艦長がフォームを、回答せずに閉じた |

- タスクの「報告済み」と同じく、フォームがどうなったかは、フォームの行を書き換えず、行を足して表します。**`ui_answered_events` に行があるフォームは回答済み、`ui_dismissed_events` に行があれば閉じた、どちらもなければ未回答（open）**です。
- フォームを載せるのは、**完了した**（`turn_completed`）返信だけです。キャンセルされた、失敗した、終了せずに壊れた返信で出したフォームは、表示されず、ミッションをロックすることもありません。
- 返信の項目は、フォームを `a2ui: { state, messages, comment?, actionName?, locksInput? }` として持ちます。
  - `state: "open"` — 艦長の回答待ち。`messages` は、クルーが送ったとおりのフォームです。`locksInput: true` が付きます。このフォームが、ミッションの入力をロックすることは、サーバーが決め、クライアントは、項目のとおりに受け取ります。
  - `state: "answered"` — `messages` の末尾に、`data_model_json` の値を設定する `updateDataModel` が付くので、フォームは、回答したときの状態で表示されます。`actionName` は押した操作、`comment` は回答と一緒に書いたコメント（なければありません）。
  - `state: "dismissed"` — 回答せずに閉じた。`messages` は空（描くものがない）で、返信には、閉じたことを示す印が残ります。
- ミッションに未回答のフォームがある間は、そのミッションでメッセージを送れません（入力欄がロックされ、サーバーも `409` で断ります）。どの返信にあるかは、`GET /api/timeline` が `openUiItemId` で返すので、クライアントが、読み込み済みの項目から探す必要はありません。
- 回答のときにクルーが受け取るメッセージは、保存しません。読むときに、`action_json` と `comment` から作ります。`a2ui-action` と印を付けたコードブロックに、A2UI v1.0 の action メッセージを入れ、コメントがあれば、`Captain's comment:` とコメントが続きます（ほかのクルーに渡す会話の経緯にも、これが入ります）。文面ではなく、事実を保存するので、文面を作る箇所を変えても、古い行は、そのまま使えます。

## 設定とキャッシュ

| テーブル | 列 | 意味 |
|---|---|---|
| `app_settings` | `key`, `value` | UI から保存した設定。既定は `config.yml` で、行があれば実行時にそれを優先する。キーは `language`、`crew_language` |
| `provider_model_options` | `provider`, `options_json` | プロバイダーごとの「選べるモデル」の最後に分かった内容。セッションを作るまで分からないため、再起動直後の選択肢に使う |
| `provider_commands` | `provider`, `commands_json` | プロバイダーごとの「使えるスラッシュコマンド」の最後に分かった内容。起動前の入力補完に使う |

## 共通の約束

- **イベントのテーブルは更新・削除しない**（追記のみ）。状態の変化も、新しい事実の行として足します。
- すべてのイベントに `mission_id` があります。値は幹だけが持ち、詳細テーブルにはありません。
- 外部キーは有効（`PRAGMA foreign_keys = ON`）、ジャーナルは WAL モードです。
- 書き込みは、種類ごとに専用の関数だけを通します。呼び出し側が表へ直接 `INSERT` することはありません。

## マイグレーション

スキーマのバージョンは、SQLite の `PRAGMA user_version` に持ちます。

### バージョン一覧

| 版 | 名前 | 内容 |
|---|---|---|
| 1 | `baseline` | 版管理を始める前のスキーマ。何度流しても同じ結果になる（空の DB でも、版管理前の DB でも同じ形になる） |
| 2 | `backfill-legacy-agents` | `agent` が空の古い行を `first_officer`（当時の副長）で埋める |
| 3 | `task-dispatcher` | `task_started_events.dispatched_by` を追加。既存行は `first_officer` で埋める |
| 4 | `provider-commands` | `provider_commands` を追加 |
| 5 | `task-cancelled` | `task_completed_events.cancelled` を追加。既存行は 0（中止ではない） |
| 6 | `ui-events` | `ui_shown_events`、`ui_answered_events`、`ui_dismissed_events` を追加 |

### 規則

- 公開済みのマイグレーションは**書き換えません**。変更は、`MIGRATIONS` の末尾に次の版番号で足します。
- 各マイグレーションは 1 つのトランザクションで動きます。失敗したら、その版の変更はすべて取り消され、起動を止めます。
- 古いデータの扱い（空の列の意味など）は、読み出し側の特別扱いにせず、マイグレーションでデータを一度だけ直します。
- このプログラムより新しい版の DB は、一切変更せずに、エラーで開きません。

手順は[アーキテクチャ](../architecture.ja.md)を参照してください。

## バックアップと復元

- 既存の DB を書き換える前に、`data/bridge.db.bak-v<旧版>` へコピーを残します。同名のバックアップがあるときは、末尾に時刻を付けます（上書きしません）。
- 空の DB（作ったばかりのもの）にはバックアップを作りません。
- コピーの前に WAL の内容をメインのファイルへ書き戻すため、**そのファイル 1 つで完全なバックアップ**になります。
- 艦を止めたとき（`Ctrl+C`・`SIGTERM`）にも、WAL をメインのファイルへ取り込んでから閉じます。強制終了のあとは、`-wal` に未反映の分が残るので、コピーは `bridge.db*` をまとめて行います。
- 復元するには、サーバーを止めて、古い `bridge.db*`（`-wal`・`-shm` を含む）を退避してから、バックアップを `bridge.db` に置きます。手順は[ガイド](../guides/backup-and-restore.ja.md)にまとめます。
