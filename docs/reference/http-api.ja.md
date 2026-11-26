[English](http-api.md)

# HTTP API リファレンス

make-it-so のサーバーが提供する HTTP API、SSE（サーバー送信イベント）、MCP 掲示板のリファレンスです。クライアント（画面）は、このAPIだけでサーバーとやり取りします。

## 目次

- [共通事項](#共通事項)
- [設定・状態](#設定状態)
- [クルーとの会話](#クルーとの会話)
- [ミッション](#ミッション)
- [タイムライン](#タイムライン)
- [クルーの人事記録・アイコン](#クルーの人事記録アイコン)
- [タスク](#タスク)
- [承認待ち（permission）](#承認待ちpermission)
- [PIN](#pin)
- [検索](#検索)
- [Memory（ビューア用）](#memoryビューア用)
- [モデル](#モデル)
- [エージェント・デバッグ](#エージェントデバッグ)
- [SSE（サーバー送信イベント）](#sseサーバー送信イベント)
- [MCP 掲示板](#mcp-掲示板)
- [設定サーバーの API](#設定サーバーの-api--settings)
- [エラーコード](#エラーコード)

## 共通事項

- **形式:** リクエスト・レスポンスとも JSON（アイコンのアップロードだけは、画像のバイト列）。JSON のボディは 1MB まで。
- **待ち受け:** 既定は `127.0.0.1`。**認証はありません**（[安全上の注意](../security.ja.md)）。CORS のヘッダーは付けません。`Host` が IP アドレスか `localhost` でない要求（`403`、`{ error: "forbidden_host" }`）、`Origin` がサーバー自身のオリジンと違う要求（`403`、`{ error: "forbidden_origin" }`）、`Sec-Fetch-Site` が `same-origin`・`none` 以外の要求（`403`、`{ error: "forbidden_site" }`。ただし、リンクをたどって、ページを開く GET（トップレベルの移動）は通します）は、すべての経路で拒否します。`Host` は `名前[:ポート]` の形だけ、`Origin` は `http:` だけを受け付けます。`Origin` のない要求（`curl` など）は通します。
- **画面の配信:** `npm start` では、`/api` 以外の GET は、ビルド済みの画面（`index.html`）を返します。存在しない `/api/...` は 404 です。
- **エラーの形:** `{ "error": "<メッセージまたはコード>", "message"?: "<英語の説明>" }`。画面は、`error` がコード（`agent_busy` など）のときは、辞書で訳します（[エラーコード](#エラーコード)）。
- **ミッション:** ミッションを受け取るAPIは、`missionId` を、ボディまたはクエリで受け取ります。
  - ボディ（`POST` 系）: 省略・空・文字列でない場合は、既定ミッション（`bridge`）。存在しない ID は `404`。
  - クエリ（`GET` のタイムライン系）: 省略すると、既定ミッション（`bridge`）。
- **クルーの指定（`:role`）:** `ship.yml` の役職名。存在しない役職は `404`。

## 設定・状態

| メソッド・パス | 内容 |
|---|---|
| `GET /api/health` | `{ status: "ok", shipId, pid, uptime, agents }`。`agents` は、役職名 → ステータス。`shipId` と `pid` は、設定サーバーが、そのポートで動いている艦を見分け、止めるために使う |
| `GET /api/config` | `{ defaultTarget, shipName, language, crewLanguage }`。`defaultTarget` は、既定の話し相手の役職（commander、いなければ最初のクルー。クルーが無ければ `null`） |
| `PUT /api/config/language` | UI の言語を変える。ボディ `{ language: "en" \| "ja" }`。艦のDBに保存する。応答 `{ language }`。未対応の値は `400`（`invalid_language`） |
| `PUT /api/config/crew-language` | クルーが話す言語を変える。形は同じ。新しく作られるセッションから反映する |
| `GET /api/quick-actions` | この艦で有効なカスタムメニューの項目。`{ actions: [{ id, name, kind, command, send, shared }] }`。`kind` は `message` か `slash`、`send` は `now` か `fill`。`shared` は、他の艦も同じ項目を使っているかどうか。YAML として読めない `quick-actions.yml` は `409` |
| `PUT /api/quick-actions` | この艦の一覧を置き換える。ボディ `{ actions: [{ id?, name, kind, command, send }], seen?: string[] }`。既知の `id` の項目は更新（共有している項目は、使っているすべての艦で変わる）、`id` のない項目は新規でこの艦だけで有効、含めなかった項目はこの艦から外す（「すべての艦」で有効な項目は、この艦だけを切る）。`seen` は、編集画面が読み込んだ項目のIDで、そのあとに増えた項目は、そのままにする。検証するのは、この艦の項目だけ。応答は `GET` と同じ。不正な入力は `400`（`errors` はリスト内の位置ごと）。YAML として読めない `quick-actions.yml` は `409` |
| `GET /api/crew` | クルーの編成。役職名 → `{ name, provider, acp_agent, rank, icon?, host? }`。`icon` は画像のURL、`host` はリモートのクルーだけ |
| `GET /api/crew/status?missionId=` | クルーの稼働状況（ホストごとのグループの配列）。下記 |
| `GET /api/crew/:role/tasks?limit=&missionId=` | クルーの実行中タスクと履歴。`limit` の既定は 5。応答 `{ current, history, hasMore }`。`current` は `{ taskId, taskName }` または `null` |
| `POST /api/bridge/refresh-credits` | アカウントごとの使用率を取り直し、SSE（`credits:usage`）で配信して、応答にも返す。応答 `{ status: "ok", data }`。失敗は `500` |

### `GET /api/crew/status`

応答は、ホストごとのグループの配列です（ローカルが先頭、リモートは、クルーの並びで最初に現れた順）。

```json
[
  {
    "host": { "label": "workstation", "kind": "local" },
    "tunnel": null,
    "crew": [
      { "role": "first_officer", "status": "idle", "unreportedCount": 0,
        "contextPercent": null, "commands": [], "commandsLive": false }
    ]
  }
]
```

| フィールド | 内容 |
|---|---|
| `host` | `{ label, kind: "local" \| "remote", address? }`。リモートの `address` は、`ssh -G` で解決した接続先（名前と同じ、または解決できなければ無い） |
| `tunnel` | リモートホストへの逆トンネルの状態: `connected` \| `connecting` \| `idle`。ローカルは `null` |
| `status` | `idle` \| `working` \| `starting` \| `restarting`（優先順位は、再起動中 > 起動中 > 作業中 > 待機） |
| `unreportedCount` | 未報告のタスク件数 |
| `contextPercent` | コンテキストの使用率（%）。`missionId` を指定したときの、そのミッションの会話用セッションの値。セッションが無い、または `missionId` なしなら `null` |
| `commands` | 会話用セッションで使えるスラッシュコマンド `{ name, description, hint? }[]`。起動前は、前回の一覧（控え）。`missionId` なし、または控えも無ければ空 |
| `commandsLive` | `commands` が、動いているセッションから届いた最新のものか |

`missionId` を指定すると、そのミッションに限って判定します。省略すると、全ミッションを横断します。

## クルーとの会話

| メソッド・パス | 内容 |
|---|---|
| `POST /api/crew/:role/message` | 艦長がクルーにメッセージを送る（どの役職も同じ入口）。ボディ `{ text, missionId? }` |
| `POST /api/crew/:role/report` | クルーに `report` を送る（クルーが、自分が見られる未報告タスクを報告する）。ボディ `{ missionId? }` |
| `POST /api/a2ui/:itemId/answer` | 返信の下に出ている A2UI のフォーム（`render_ui` を参照）の、ボタンを艦長が押した。`itemId` は、その返信の ID。サーバーは、A2UI のアクションを、フォームを出したクルーに送り（`a2ui-action` と印を付けたコードブロックに、A2UI v1.0 の action メッセージを入れ、艦長のコメントがあれば、続ける）、そのフォームへの回答として記録する（`ui_answered`。艦長の発言としては記録しない）。ボディ `{ action, dataModel?, comment? }`。`action` は、A2UI のレンダラーが報告するアクション（`name`、`surfaceId`、`sourceComponentId`、`timestamp`、`context`。ほかの項目は捨てる。`surfaceId` は、フォームが作った surface であること）、`dataModel` は、その時点のその surface の値（フォームを回答したときの状態で見せるために保持する）、`comment` は、フォームのコメント欄に書いた内容。`202` で `{ messageId, status: "accepted" }` を返す。フォームのない返信は `404`、形の違うアクションや、フォームが作っていない surface は `400`、すでに回答済み、または閉じてあれば `409`（`form_closed`）、ミッションが処理中なら `429` |
| `POST /api/a2ui/:itemId/dismiss` | フォームを、回答せずに閉じる（`ui_dismissed`）。クルーには何も送らず、返信には、閉じたことを示す印が残る。ボディなし。`200` で `{ status: "dismissed" }` を返す。`404`・`409` は上と同じ |
| `POST /api/bridge/cancel` | そのミッションの、進行中のターンを止める。ボディ `{ missionId? }` |

- ミッションに未回答の A2UI のフォーム（`render_ui` を参照）がある間は、`message` と `report` は `409`（`form_open`）で断られます。艦長は、先に、そのフォームに答えるか、回答せずに閉じます。
- `message` と `report` は、受け付けると `202`（`{ messageId, status: "accepted" }`）を返し、応答は、SSE で届きます。
- 次の場合に失敗します。

| ステータス | 条件 |
|---|---|
| `400` | `text` が無い、または文字列でない（`message` のみ） |
| `404` | 役職、またはミッションが存在しない |
| `429` | そのミッションが、前のメッセージを処理中（**並行性はミッション単位**。別のミッションは受け付ける） |
| `500` | 送信中の例外 |

- `cancel` は、停止を要求します（セッションがあればキャンセルを送り、起動中なら起動を中断し、猶予の15秒を過ぎても終わらなければ、強制終了します）。応答 `{ status: "ok", message: "Cancel sent" }`。進行中のターンが無ければ `409`。停止後の失敗は、エラーではなく「キャンセル済み」として記録します。

## ミッション

| メソッド・パス | 内容 |
|---|---|
| `GET /api/missions` | ミッション一覧（アーカイブ済みも含めて全件）。`{ id, name, createdAt, archivedAt }[]` |
| `POST /api/missions` | 作成。ボディ `{ name, id? }`（`id` を省略すると自動で付ける。名前の前後の空白は除く）。`201` で作成したミッションを返す。`name` が無い・空は `400`、`id` の重複は `409`。`id` は、英数字で始まる 1〜64 文字の、英数字と `.`・`_`・`-`・`:` だけ（それ以外は `400`） |
| `PATCH /api/missions/:id` | アーカイブ・復元。ボディ `{ archived: boolean }`。ミッションを返す。`archived` が真偽値でなければ `400`、存在しなければ `404` |

- アーカイブは削除ではなく、一覧に出すかどうかの切り替えです（`archivedAt` が、`null` なら表示中）。
- ミッションの変更は、SSE では配信しません（呼び出したクライアントが、応答で一覧を更新します）。

## タイムライン

チャットの内容の**唯一の情報源**です。永続化された履歴と、実行中のものを、同じ形（`TimelineItem`）で返します。

| メソッド・パス | 内容 |
|---|---|
| `GET /api/timeline?missionId=&limit=` | 直近の履歴と、実行中のものを返す。応答 `{ items, hasMore, openUiItemId }`（`openUiItemId` は、艦長がまだ回答も、回答せずに閉じることもしていない A2UI のフォームがある返信の ID。なければ `null`） |
| `GET /api/timeline/captain-history?missionId=` | ミッションの、艦長の過去の発言（新しい順）。入力欄の ↑ の履歴に使う。`{ items: [{ id, text, timestamp }] }`。最大20件で、同じ文は1回だけ（最後に使ったもの）。ボタンとカスタムメニューが送る定型の発言（`report`、`engage`、`make it so`、すぐ送信する項目）は除く |
| `GET /api/timeline/older?before=&missionId=&limit=` | `before`（アイテムのID。手元にある一番古いもの）より前の、永続化された履歴を返す。位置は、時刻とIDの組で決めるので、同じミリ秒のイベントも取りこぼさない。応答 `{ items, hasMore }`。`before` が無ければ `400`、そのミッションの履歴に無いIDなら `404`。`limit` が正の整数でなければ、既定の件数になる |
| `GET /api/timeline/range?missionId=&after=&inclusive=&before=&dir=&limit=` | 2つのアイテムの間を返す |

- `limit` の既定は 20 です。
- `range`: `after` と `before` の少なくとも一方が必要です（無ければ `400`、`range_unbounded`）。`dir` は `asc`（古い側から）か `desc`（新しい側から、既定は `asc`）、`inclusive=1` で `after` のアイテム自身を含みます。`limit` は既定 20、最大 100。指定したIDが、そのミッションの履歴に無ければ `404`（`item_not_found`）。応答は、`items` と、範囲を読み尽くしたかを示す `complete` を持ちます。
- アイテムのIDは、`event-<n>`（艦長の発言・通知）、ターンのID、タスクのID のいずれかです。

### `TimelineItem`

| フィールド | 型 | 内容 |
|---|---|---|
| `id` | 文字列 | アイテムのID（上記） |
| `missionId` | 文字列 | 属するミッション |
| `role` | 文字列 | `captain`、またはクルーの役職名 |
| `text` | 文字列 | 本文（Markdown） |
| `timestamp` | 文字列 | 発生時刻（ISO形式） |
| `status` | `streaming` \| `done` \| `error` | 実行中のもの、またはタスク・エラーの状態。永続化された通常の発言には無い |
| `cancelled` | 真偽値 | キャンセルされたターン |
| `credits` | `{ credits, turnDurationMs, unit }` | 使用量。`unit` は `usd` または `kiro_credits` |
| `taskName`・`instruction` | 文字列 | クルータスクの名前と指示。**`taskName` があるものが、タスク**（無ければ、会話のターン） |
| `turnId` | 文字列 | タスクを発行したターン（同じターンのタスクは、1枚のカードにまとめる） |
| `reportMeta` | `{ tasks: { agent, taskId }[] }` | このターンで報告したタスク |
| `partialText` | 文字列 | サーバーが止まって「中断」になったターン・タスクの、それまでに書かれた本文（`messageKey: "interrupted"` のカードの上に出す） |
| `a2ui` | `{ state, messages, comment?, actionName?, locksInput? }` | クルーが、この返信の下に出した A2UI のフォーム（`render_ui`）。完了した返信だけが持つ。`state` は `open`・`answered`・`dismissed`。詳しくは[A2UI のフォーム](data-model.ja.md#a2ui-のフォーム) |
| `messageKey` | 文字列 | サーバーが書いた固定メッセージのキー。画面は、辞書で訳す。無ければ `text` をそのまま出す |

## クルーの人事記録・アイコン

| メソッド・パス | 内容 |
|---|---|
| `GET /api/crew/:role/profile` | 人事記録。設定の要約（名前・ID・階級・プロバイダー・権限モード・`cwd`・ホスト）、ペルソナ、ブリーフィング（セッション開始時に送る全文）を、サーバーが組んで返す |
| `GET /api/crew/:role/icon` | アイコン画像（`Content-Type` は画像、`X-Content-Type-Options: nosniff`、`Cache-Control: no-cache`）。無ければ `404` |
| `PUT /api/crew/:role/icon` | アイコンを保存する。ボディは画像のバイト列。応答 `{ status: "ok", icon }` |
| `DELETE /api/crew/:role/icon` | アイコンを消す（既定のアバターに戻る）。応答 `{ status: "ok" }` |

- **ペルソナ（`persona`）:** `source` が `personnel`（make-it-so が注入する人格ファイルの中身）、`agent`（プロバイダーの agent 定義。`status` が `found` / `not_found` / `remote`）、`none`（人格ファイルが無い）。プロバイダーが実際に使う最終的なプロンプトは取得できません。
- **ブリーフィング:** 送信と同じ関数で、開くたびに組み立てます。組み立てられないとき（ルールのファイルが読めないなど）は、`briefing` が `null` で、理由が `briefingError` に入ります。
- **アイコンの検証（`PUT`）:** PNG・JPG・WebP・GIF だけを受け付けます（SVG は不可）。形式は、中身の先頭のバイトで判定します。1MB を超えると `413`、それ以外の拒否（形式・空・メンバーIDが不正）は `400`（応答の `reason`）。`GET /api/crew` の `icon` は、更新時刻つきのURLで、差し替えるとURLが変わります。

## タスク

| メソッド・パス | 内容 |
|---|---|
| `GET /api/results/:taskId` | タスク1件の詳細。`{ text, status, taskName?, instruction?, credits?, cancelled?, missionId, timestamp }`（`cancelled` は、艦長が中止したタスクだけ `true`。`text` は中止までの出力）。`taskId` は英数字・`_`・`-` だけ（それ以外は `400`）。存在しない、または未完了のタスクは `404` |
| `POST /api/crew/:taskId/cancel` | クルータスクのキャンセルを依頼する。応答 `{ status: "ok" }`。実行中なら、中止までの出力を残して終わり、`cancelled` が付く。順番待ち・起動中のタスクは、実行されずに、`cancelled` で終わる。キューにも実行中にも無いタスク（終了済みなど）は `404` |

## 承認待ち（permission）

クルーがツールの実行許可を求めている間の、保留中の要求です。

| メソッド・パス | 内容 |
|---|---|
| `GET /api/permissions` | `{ permissions: PendingPermission[] }` |
| `POST /api/permissions/:key/respond` | 要求に答える。ボディ `{ optionId }`。成功は `{ status: "ok" }`。`optionId` が無ければ `400`。存在しない・すでに解決済みの `key` は `404`（`{ status: "not_found" }`。**冪等**: 二重に送っても、二重には届かない）。答えが、待っているセッションに届かなかったとき（セッションが終了済み、または、ターンの中止で要求が取り消し済み）は `409`（`{ status: "undeliverable" }`。その要求は一覧から消える） |

`PendingPermission`: `{ key, scope, missionId, ownerMissionId, role, requestId, taskId?, toolName, toolInput, options, receivedAt }`。

- `ownerMissionId` が**本物のミッションID**で、`missionId` は、セッションのスコープです（タスク実行中は `__tasks__:<ミッションID>` の形）。`role` は、承認待ちのクルーの役職名です。画面は、これらをそのまま使います。
- 応答は、要求の来た**セッション**（クルー・ミッション）へ届きます。

## PIN

| メソッド・パス | 内容 |
|---|---|
| `GET /api/pins?missionId=` | ピンの一覧（`missionId` を省略すると、全ミッション）。`{ messageId, role, text, timestamp, pinnedAt, missionId, isFloating }[]` |
| `POST /api/pins` | ピン留め。ボディ `{ messageId, role, text, timestamp, missionId }`（すべて必須）。`201`。存在しないミッションは `404` |
| `DELETE /api/pins/:messageId` | 解除。`204` |

- `role` は、`captain` か、艦のクルーの役職名（それ以外は `400`）。`isFloating` は、互換のための項目で、常に `true` です。
- すでにピン留めされたメッセージは `409`。存在しないピンの解除は `404`。

## 検索

`GET /api/search?q=&missions=&from=&to=&captain=&replies=&tasks=&limit=`

| パラメーター | 内容 |
|---|---|
| `q` | 検索語（**必須**）。空白（全角を含む）で区切ったAND。部分一致、大文字小文字を区別しない |
| `missions` | 対象のミッションID（カンマ区切り）。省略すると、すべてのミッション |
| `from`・`to` | 期間（ISO形式の日時）。`from` を含み、`to` は含まない。不正な値は `400` |
| `captain`・`replies`・`tasks` | 艦長の発言・クルーの返信・タスク（指示と報告）を含めるか。既定は、すべて含める |
| `limit` | 返す件数の上限。既定・最大とも 500 |

応答は、新しい順です。

```json
{ "total": 12, "truncated": false, "hits": [
  { "id": "event-3", "missionId": "bridge", "missionName": "Bridge", "role": "captain",
    "kind": "captain", "timestamp": "2026-11-15T00:00:00.000Z",
    "snippet": { "text": "…", "ranges": [[4, 9]], "cutStart": false, "cutEnd": true },
    "matchedIn": null } ] }
```

- `total` は、件数の上限を除いた一致の総数、`truncated` は、上限で切ったか。
- `kind`: `captain`（艦長の発言）・`reply`（返信）・`task`（タスク）。タスクのとき `matchedIn` が、`report`（報告）か `instruction`（指示）。
- `snippet.ranges` は、抜粋の中の一致範囲（`[開始, 終了)`）。`cutStart`・`cutEnd` は、前後を切り取ったか。
- 検索の対象は、艦長の発言・返信・タスクの指示と報告です。エラー・キャンセル・システム通知は対象外です。

## Memory（ビューア用）

艦の Memory を読むための、読み取り専用のルートです（[ガイド](../guides/memory.ja.md)）。クルーは、下の MCP ツールで書きます。Memory を変えるルートはありません。

| メソッドとパス | 説明 |
|---|---|
| `GET /api/memory/tree?dir=&draft=&deprecated=` | 1つのディレクトリの直下にあるもの（`dir` は、ルートなら `""`）。`{ dir, dirs: { name, path, count }[], docs: MemorySummary[] }`。`count` は、そのディレクトリの下（何階層でも）にあるメモの数。安定（stable）のメモは、いつも載る。`draft=0`、`deprecated=0` で、下書きと非推奨を外す |
| `GET /api/memory/doc?path=` | 1件のメモ。要約のフィールド、`frontmatter`（ファイルにあるままの YAML）、`body`（書かれたままの Markdown。相対リンクは、ビューアが、いま表示しているメモのパスを基準に読む）、`version`。ないメモと、正しくないパスは `404`、リンクを通るパスは `400` |
| `GET /api/memory/history?path=&limit=&diff=` | Memory の変更の履歴を、新しい順に返す。`path` を付けると、そのメモだけ。`{ commit, message, author, at, diff? }[]`。`message` はクルーの一言、`author` はクルー。`limit` の既定は 20、最大は 100。`diff=1` で、各変更の差分も付く（大きいと切り詰める）。Memory のパスでないものは `400`。画面は、まだ使っていない |
| `GET /api/memory/search?q=&draft=&deprecated=&limit=&offset=` | タイトル・説明・タグ・本文を検索する（すべての語が一致すること。先頭の 32 語まで（1〜2 文字の語は先頭の 4 語まで）。日本語も使える）。`{ total, items: MemorySummary[] }`。`limit` の既定は 20、最大は 100 |

- `MemorySummary` は `{ path, type, title, description, tags, status, supersededBy?, crew?, updatedAt? }`。`status` は `draft`・`stable`・`deprecated` のどれか。
- Memory のディレクトリ名として安全でない `dir` は、`400` を返します。`supersededBy` は、Memory のルートからのパスです（クルーが書いたものがパスでないときは、含みません）。
- パスは、ビューアやクルーが何を送っても、サーバーが、入口ごと（読む・書く・消す・一覧する・履歴）に検査します。相対パスで、`.md` で終わり、`.` や `..` の名前、ドットで始まる名前、ドットや空白で終わる名前、`\ # ? % : * " < > |` と制御文字、Windows の予約名（`con`・`nul` など）、途中のシンボリックリンクを、含められません。`index.md` と `log.md` は予約です。また、既存のパス（またはそのディレクトリ）と、大文字小文字だけが違うパスも使えません。検査に通らないパスは、メモなら `404`、ディレクトリなら `400` です。

## モデル

| メソッド・パス | 内容 |
|---|---|
| `GET /api/missions/:missionId/crew-models` | クルーごとのモデル。`{ role, name, options, effective, source, live }[]`。ミッションが無ければ `404` |
| `PUT /api/missions/:missionId/crew-models/:role` | そのミッションのクルーのモデルを変える。ボディ `{ model: string \| null }`（`null` で上書きを消す）。更新後のエントリを返す |

- `options`: 選べるモデル `{ value, name }[]`（空なら、切り替えに対応しない、またはまだセッションを作っていない）。`effective`: 設定で決まったモデル。`source`: `mission`（このミッションで変更した）・`config`・`default`。`live`: 動いているセッションが実際に使っているモデル。
- 決定の優先順位: ミッションの上書き > `ship.yml` > `roster.yml` > プロバイダーの既定。
- エラー: ミッション・役職が無ければ `404`、`model` が不正（空文字・文字列でも `null` でもない）なら `400`、選べないモデルは `400`、モデルを選べないクルー（未対応、またはセッション未作成）は `409`（`model_unavailable`）。
- 動いているセッションにも反映します（ターンの途中なら、次のターンから）。反映に失敗しても、保存は成功します。

## エージェント・デバッグ

| メソッド・パス | 内容 |
|---|---|
| `GET /api/agents` | 全クルーの一覧。`{ name, status, currentTaskId }[]`（`name` は役職名、`currentTaskId` は、実行中のタスクのID、無ければ `null`） |
| `POST /api/agents/:role/restart` | そのクルーの、ミッションのセッションを作り直す。ボディ `{ missionId? }`。成功は `{ status: "ok", message }` |
| `POST /api/debug/simulate-error` | 次のプロンプトでエラー（RPC -32603）を起こし、自動リカバリを発動させる。**`debug: true` のときだけ**有効（無効なら `404`） |

- 再起動: クルーが、会話中・タスク実行中なら `409`（`agent_busy`）、起動中・再起動中でも `409`。役職・ミッションが無ければ `404`。失敗は `500`。

## SSE（サーバー送信イベント）

| エンドポイント | 受け取るイベント |
|---|---|
| `GET /api/events/bridge` | 画面（チャット）向けのイベントすべて（下表） |
| `GET /api/events` | すべてのイベント |

- 形式: `id: <連番>`、`event: <種別>`、`data: <JSON>`。接続時に、`: connected` のコメントを送ります。15秒ごとにハートビート（コメント行）を送ります。
- 再接続した場合は、取りこぼしを、イベントで埋めようとせず、`GET /api/timeline` のスナップショットを取り直します。
- **全ミッションのイベントが、同じチャンネルに流れます。** クライアントは、`missionId` が今開いているミッションと違うイベントを捨てます（`crew:status_changed` は、ミッションを問わず受け取る）。

| 種別 | データ | 内容 |
|---|---|---|
| `timeline:upsert` | `TimelineItem` | アイテムの作成、または全体の置き換え（テキスト以外の変更も） |
| `timeline:append` | `{ id, text }` | ストリーミング中の本文の差分。`id` のアイテムの本文に追記する |
| `timeline:remove` | `{ id }` | アイテムの削除（「結局、表示するものが無かった」場合のみ） |
| `timeline:activity` | `{ id, activity }` | 実行中のアイテムの「操作」（ツール呼び出しとその出力の先頭）が変わった。`id` のアイテムの `activity` を置き換える（本文は変えない）。約 0.4 秒に1回までにまとめて送る |
| `credits:usage` | `{ accounts, untracked }` | アカウントごとの使用率（下記） |
| `permission:requested` | `PendingPermission` | 承認待ちの出現 |
| `permission:resolved` | `{ key }` | 承認待ちの解決 |
| `crew:status_changed` | `{ role, missionId }` | 会話用セッションの起動中・再起動中が始まった・終わった合図。受け取ったら、`GET /api/crew/status` を取り直す |
| `memory:changed` | `{}` | 艦の Memory が変わった合図。受け取ったら、開いている Memory ペインが、表示しているものを取り直す |

型定義には、`task:progress`・`task:complete`・`notification:*`・`log` もありますが、クライアントは使っていません。

`credits:usage` の `accounts` は、`{ key, provider, label, plan?, usage, crews }[]` です。`usage` は `{ usedPercent, resetsAt, label?, secondary? }` または `null`（まだ取れていない）、`crews` は、そのアカウントで動くクルーの表示名です。`untracked` は、アカウントを識別できず、集計していないクルー（リモートホストのクルー）の表示名です。

## MCP 掲示板

`POST /mcp`（本文は 8 MB まで）。艦のポートではなく、専用のリスナーで受けます。`127.0.0.1` だけ（`server.host` が何でも）で、ポートは起動のたびに OS が選びます。URL はセッションに渡します。クルーのセッションが、タスクの委任と報告の取得に使う、内蔵の MCP サーバーです（ステートレスモード。リクエストごとに、サーバーを作って使い捨てます）。

| ツール | 内容 |
|---|---|
| `dispatch_task(agent, task_name, instruction)` | クルーにタスクを委任する。`agent` は、役職名または名簿のメンバーID。実際に送り込まれるのは短い通知だけで、指示の全文は DB に記録し、委任先は `get_task` で読む。**階級が `commander` か `chief` のクルーだけ**が使える（それ以外は、サーバーが拒否する） |
| `get_task(taskId)` | タスクの指示（完了していれば、結果も）を取得する |
| `get_skill(name)` | 呼び出したクルーに案内したスキルの本文（frontmatter を除いたファイル）を取得する。そのクルーに案内したスキルだけを返すので、他のファイルを読むことには使えない。知らない名前には、そのクルーが使える名前の一覧つきのエラーを返す。返すのはスキルの本文だけで、そのそばにあるファイルは渡さない。スキルのファイルを読めないリモートホストのクルーが、スキルを使うための道 |
| `search_memory(query?, type?, tags?, status?, path?, limit?, offset?)` | 艦の Memory を一覧・検索する。`query` のすべての語が一致すること（タイトル・説明・タグ・本文。日本語も使える）。`{ total, items }` を返し、各メモのパス・type・タイトル・説明・タグ・status を載せる |
| `read_memory(path)` | 1件のメモを読む。フィールド、本文、`version`（ファイルの git の blob ID）を返す |
| `write_memory(path, type, description, body, message, title?, tags?, status?, base?)` | メモを作る・更新する。`type` と `description` は必須で、変更を一言で書く `message`（コミットメッセージ）も必須。既存のメモの更新には、読んだときの `version` を `base` として渡す。`base` がない・古いときは、今のメモをつけて断る。更新で `tags` や `status` を省くと、そのまま残る。本文が 1MB、メモが 50,000 件を超えても、警告をつけて成功する。どのクルーも使える（ランクの確認はしない） |
| `deprecate_memory(path, message, superseded_by?)` | メモを `deprecated`（非推奨）にする（残り、そう表示される）。`superseded_by` は、後継のメモの、先頭に `/` をつけたパス |
| `delete_memory(path, message)` | メモを消す（履歴には残る） |
| `get_memory_history(path?, limit?, diff?)` | 変更履歴（新しい順。既定 20 件、最大 100 件）: コミット、メッセージ、作者（クルー）、時刻。`path` を渡すと、そのメモの履歴（消したメモも）で、`diff: true` で、各変更が何をしたかを添える（20,000 字で切る） |
| `render_ui(messages)` | 艦長に、クルーの返信の下で、操作できるフォームを見せる。`messages` は、A2UI v1.0 のメッセージ（基本カタログ）で、`createSurface` から始まる、それだけで完結した、surface が1つだけの内容にする。A2UI ライブラリの厳格な規則で検査し（未知の部品の種類、root がない、存在しない部品への参照、孤立した部品、バージョンの違い、1つのメッセージに複数の操作、は断る）、誤りがあれば、何も表示せず、エラーを返す。ツールの説明に、完全な例がある。艦長への返信の中でだけ使え（委任されたタスクの作業中は不可）、1つの返信に1回まで。すぐに戻り、フォームは、返信が終わったときに出る。フォームが未回答の間は、そのミッションで、艦長は、ほかに何も送れない。艦長がボタンを押すと、クルーに、`a2ui-action` と印を付けたコードブロックで、A2UI の action メッセージ（`{ "version": "1.0", "action": { name, surfaceId, sourceComponentId, timestamp, context } }`）が届き、艦長がフォームのコメント欄に書いていれば、そのコメントが続く（フォームごとに1回だけ）。フォームは記録され（`ui_shown`）、再起動しても残る |
| `list_unreported_tasks()` | 未報告のタスクを、整形したテキストで返す。commander は全件、それ以外は、自分が発行した分だけ。呼ばれた時点のIDが「今回の報告対象」として記録され、ターンが正常に完了すれば、報告済みになる |

- **秘密の値:** 呼び出しには、HTTP ヘッダー `x-makeitso-token` が必要です。値は起動のたびに、1 つのエージェントとミッションのために導き、そのセッションの MCP 設定へ、同じエージェントとミッションを示す識別ヘッダーと並べて入れます。ない場合や違う場合（別のエージェントやミッション用の値も含む）は、どのツールも動かす前に、`401` `{ "error": "unauthorized" }` を返します。
- **呼び出し元の識別:** セッションを作るときに、そのセッション専用の MCP サーバー設定へ入れた HTTP ヘッダー `x-makeitso-agent`・`x-makeitso-mission` で、呼び出し元の（クルー、ミッション）を判定します。モデルの自己申告には頼りません。ヘッダーが無い呼び出しは、どのツールも動かす前に `401` で断ります。
- タスクIDは、役職ごとの連番です（例: `chief_engineer_0001`）。

## デスクトップアプリ自身のパス

デスクトップアプリでは、ページのリクエストを、メモリ上の接続を通して、艦の Express が答えますが、1つだけ例外があります。`/__shell/` の下のパスは、ページを包むアプリが答え、艦には届きません（艦ではなく、ウィンドウのことなので、ルーターの作法の外に、わざと置いています）。デスクトップアプリの外では、何も答えず、ページも尋ねません。どちらも、`POST` 以外は `405`、読み取れない本文は `400` です。

- `/__shell/window`: ページが `POST` で `{ height, room }`（ヘッダーの高さと、両端に空ける余白。CSS のピクセルの整数2つ）を送ると、`{ zoom }`（アプリが正確に知っている、ページの拡大率）が返ります。アプリは、これで、どの OS でも、ウィンドウの幅を足りるように保ち、macOS では、ウィンドウのボタンをヘッダーの中央に置きます。
- `/__shell/appearance`: ページが `POST` で `{ theme, language }` と、クルーのいるページでは `crewLanguage` を送ると（`theme` は `classic` / `light` / `dark`、言語は `en` / `ja`）、`204` が返ります。ページが今、何を表示しているかをアプリに伝え、表示メニューで印を付けるためです。アプリからページへの向きは、リクエストではありません。表示メニューで選んだものは、`makeitso:appearance` イベントとしてページに送られ、ページは、自分のスイッチと同じように反映します。

## 設定サーバーの API（`--settings`）

設定サーバー（既定 `http://127.0.0.1:3938`）の API です。画面（設定画面）が使う、**内部向けの API** で、互換性は約束しません。[共通事項](#共通事項)の `Host`・`Origin` の検査は、同じように行います。保存系は、変えた項目だけを書き、誤りがあれば何も書かずに、項目ごとのエラー（メッセージのキー）を `400` で返します。YAML として読めないファイルは、上書きせず `409` を返します。

| メソッド・パス | 内容 |
|---|---|
| `GET /api/settings/overview` | ディレクトリ・各ファイルの有無・人格の数・艦の一覧 |
| `GET /api/settings/config`・`PUT /api/settings/config` | `config.yml` の項目と値の取得・保存。ボディ `{ values }` |
| `GET /api/settings/hosts`・`PUT /api/settings/hosts` | `hosts.yml` のホストの取得・保存。ボディ `{ hosts: [{ name, destination }] }` |
| `GET /api/settings/quick-actions`・`PUT /api/settings/quick-actions` | `quick-actions.yml` の項目と、選べる艦の取得・保存（`{ actions, ships: [{ id, name }] }`）。ボディ `{ actions: [{ id?, name, kind, command, send, ships }] }`。`ships` は `"all"` か艦IDの一覧 |
| `GET /api/settings/roster`・`POST /api/settings/roster` | 名簿の取得・メンバーの追加（ボディ `{ id, name, provider?, model?, permission_mode?, rules?, skills? }`） |
| `PUT /api/settings/roster/:id`・`DELETE /api/settings/roster/:id` | メンバーの保存・削除（入力の誤りは `400`、無いメンバーは `404`。艦が配属しているメンバーは `409`（`usedBy` を返す）） |
| `GET /api/settings/roster/:id/persona`・`PUT /api/settings/roster/:id/persona` | 人格（`personnel/{id}.md`）の取得・保存。ボディ `{ text }` |
| `GET /api/settings/roster/:id/icon`・`PUT /api/settings/roster/:id/icon`・`DELETE /api/settings/roster/:id/icon` | アイコン。`PUT` のボディは、画像のバイト列（形式は先頭のバイトで判定。1MB まで。`413`） |
| `GET /api/settings/ships/:id` | 艦の設定（`fields`）と、フォームの選択肢（`options`）。無ければ `404` |
| `POST /api/settings/ships` | 最小の艦を作る。ボディ `{ id, port, name?, member }` |
| `PUT /api/settings/ships/:id` | 艦の設定の保存。ボディ `{ fields }`。起動時と同じ検証を通す |
| `DELETE /api/settings/ships/:id` | 艦のディレクトリごと削除する。ボディ `{ confirm: "<艦ID>" }` が必須（`400`）。動いている艦は `409`、`ship.yml` を読めない艦も `409` |
| `GET /api/settings/runtime` | `{ ships: [{ id, port, state, pid?, url, devCommand }], shipUi, desktop }`。`state` は `running`・`stopped`・`conflict`。`desktop` は、デスクトップアプリの設定では `true`：艦には、画面のアドレスがなく（`url` は `null`）、ウィンドウで開きます。ウィンドウで開いている艦と、ブラウザ版で動いている艦は、`running` に数えます（ブラウザ版の設定も、デスクトップアプリで開いている艦を、同じように数えます） |
| `POST /api/settings/ships/:id/start`・`POST /api/settings/ships/:id/stop` | 艦の起動・停止（独立したプロセス）。起動は、無い艦で `404`、動いている艦・同時の起動・ポートの衝突・ポートが無い艦で `409` |
| `GET /api/settings/ships/:id/log` | 艦の標準出力の末尾（`{ text }`） |
| `POST /api/settings/import/scan` | 既存のプロジェクトを読み取って、下書きを返す（何も書かない）。ボディ `{ path }`。応答 `{ dir, isDirectory, found, drafts }` |
| `POST /api/settings/import` | 下書き（変更後）を保存する。名簿の新しいメンバーと艦を、まとめて 1 回で保存し、拒否されたら元に戻す。失敗は `400`（`errors: { ship, members }`） |
| `GET /api/config` | 画面の言語（`{ language, crewLanguage }`。`config.yml` から） |

## エラーコード

`error` が次のコードのとき、画面は、辞書（`error.<コード>`）で訳します。コードが無い、または辞書に無ければ、`message` を出します。

| コード | ステータス | 内容 |
|---|---|---|
| `agent_busy` | 409 | クルーが作業中（会話中・タスク実行中）または起動中・再起動中のため、再起動できない |
| `model_unavailable` | 409 | このクルーのモデルは、選べない（未対応、またはセッションをまだ作っていない） |
| `form_open` | 409 | クルーが出したフォームが、艦長の回答を待っているため、フォームに答えるか閉じるまで、メッセージ・報告を送れない |
| `form_closed` | 409 | フォームは、すでに回答済み、または閉じてある |
| `invalid_language` | 400 | 未対応の言語 |
| `range_unbounded` | 400 | `timeline/range` に `after` も `before` も無い |
| `item_not_found` | 404 | `timeline/range` の指定したアイテムが、そのミッションの履歴に無い |

このほかのエラーは、`{ "error": "<英語のメッセージ>" }` で、メッセージをそのまま表示します。
