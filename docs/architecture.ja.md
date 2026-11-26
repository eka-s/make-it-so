[English](architecture.md)

# アーキテクチャ（開発者向け）

make-it-so のコードを読む・変更する人のための文書です。利用者向けの説明は[基本概念](concepts.ja.md)と[ガイド](guides/README.ja.md)にあります。

## 目次

- [開発環境とコマンド](#開発環境とコマンド)
- [プロセスの構成](#プロセスの構成)
- [コードの構成](#コードの構成)
- [依存の渡し方](#依存の渡し方)
- [クライアントの構成](#クライアントの構成)
- [テスト](#テスト)
- [スキーマを変えるとき](#スキーマを変えるとき)
- [HTTP のルートを足すとき](#http-のルートを足すとき)
- [プロバイダーを足すとき](#プロバイダーを足すとき)
- [コメントと言語の規約](#コメントと言語の規約)

## 開発環境とコマンド

Node.js のバージョンは `.tool-versions` に従います。SQLite は Node 組み込みの `node:sqlite` を使います。

| コマンド | 内容 |
|---|---|
| `npm run init -- [...]` | 最小の設定を作る（[ガイド](guides/create-fleet-and-ship.ja.md)） |
| `npm run dev -- --ship <艦ID>` | サーバー（tsx watch）とクライアント（Vite）を同時に起動。`--settings` なら、設定サーバーを起動する（画面は `http://localhost:13938`） |
| `npm run dev:server` / `npm run dev:client`（どちらも `-- --ship <艦ID>`） | どちらか一方だけ |
| `npm run build` | `dist/` を空にして（`npm run clean`）から、サーバーを `tsc`（`tsconfig.build.json`）で `dist/server` と `dist/electron` へ、クライアントを Vite で `dist/client` へ |
| `npm start -- --ship <艦ID>` / `npm start -- --settings` | ビルド済みを起動（`node dist/server/cli.js`）。API と画面を同じポートで配信する |
| `npm run start:electron`（`-- --ship <艦ID>` か `-- --settings`） | ビルド済みで、デスクトップアプリを起動（[ガイド](guides/desktop-app.ja.md)）。画面はポートなしで配信する |
| `npm run pack` / `npm run dist` | デスクトップアプリを作る（`release/mac-arm64/Make-It-So.app` と、dmg） |
| `npm run typecheck` | サーバーとクライアントの型検査 |
| `npm run lint` | eslint |
| `npm test` | vitest（艦の指定は不要） |

- ビルドは艦に依存しません（`vite.config.ts` は開発サーバーのときだけ設定を読む）。艦が複数あっても、`--ship` なしでビルドできます。
- 画面の配信（`npm start`）: `createApp` に `clientDir` を渡したときだけ、静的ファイルと、`/api` 以外の GET を `index.html` に回す処理を足します。`index.ts` の `builtClientDir()` は、`dist/server/index.js` として動いているときだけ、隣の `dist/client` を返します（開発中は、古いビルドが残っていても、画面は Vite が配信します）。
- CI（`.github/workflows/ci.yml`）は、`main` への push とプルリクエストで、lint・型検査・テスト・ビルドを実行します。

## プロセスの構成

```
index.ts（配線層）
  ├─ createApp: Express（JSON、SSE、各 router、エラー処理）
  ├─ bridge        ターン（艦長とクルーの会話）の管理・自動リカバリ
  ├─ CrewManager   会話用セッションの管理・ブリーフィングの注入
  ├─ CrewRunner    dispatch_task で発行されたタスクの実行
  ├─ connectCrewEvents  CrewRunner/CrewManager のイベントを DB・タイムライン・SSE・承認へ反映
  ├─ mcp-listener  /mcp 専用のリスナー（127.0.0.1 のみ、OS が選ぶポート）
  ├─ mcp-board     掲示板（/mcp）
  └─ database      SQLite
```

- デスクトップアプリ（`src/electron/`）も、艦を同じ形（`buildShip()`）で動かしますが、画面は、`app://` で、メモリ上の HTTP 接続を通して、艦の Express に渡すので、画面用のポートは開きません（エージェント向けの `/mcp` のリスナーは、そのまま残ります）。艦の一覧と設定は、それぞれ別のプロセスで動き、艦は、そのウィンドウが開いている間だけ動きます。
- 1 プロセス = 1 艦です。クルーは、`BaseAgentClient` が子プロセスとして起動する、プロバイダーのエージェントです（標準入出力の JSON-RPC＝ACP）。リモートホストのクルーは、SSH 越しに同じ方法で起動し、掲示板へは逆トンネルで届きます。
- 各ターン・タスクのツール呼び出し（何を実行し、何が出力されたか）は、`activity/<id>.jsonl` に1行ずつ追記します（`src/server/activity-log.ts`）。DB には書きません。直近 50 件だけ残し（古いファイルは起動時と新規作成時に削除）、1 操作の出力は先頭 2000 文字までです。タイムラインの項目の `activity` として、スナップショットと upsert の両方で同じ形で届きます。実行中は、変わるたびに（約 0.4 秒に1回までにまとめて）`timeline:activity` で、その項目の `activity` だけを置き換えます。クライアントは `activity` をそのまま描画するだけなので、リロードしても、別のブラウザでも、同じ表示になります。1 ターン・1 タスクで記録する操作は 100 件まで、題名は 300 文字までです。
- 実行中のターン・タスクの本文は、メモリに溜めず、ファイル（`turns/`・`agents/`）に書き、スナップショットの取得時に読みます。確定したら DB に書いて、ファイルは消します。サーバーが途中で止まった（Ctrl-C・クラッシュ）ときは、次の起動で、結果の記録が無いターンとタスクを「中断」のエラーとして記録します（残っているファイルの内容を、途中までの本文として残します）。ただし、ファイルが作られる前（セッションの起動中）に止まったターンは、記録が残らないため、見つかりません。1 ターン・1 タスクにつき 1 本の書き込みストリームを持ち、`end` の完了を待つことで、末尾の欠落を防ぎます。
- タイムラインの SSE（`upsert`・`append`・`remove`）は、サーバーのメモリ上の「実行中（live）」のアイテムと、DB の履歴から作ります。

## コードの構成

### サーバー（`src/server/`）

| ファイル | 役割 |
|---|---|
| `cli.ts` | 入口。引数（`cli-args.ts`）で、設定サーバー・艦（`index.ts`）・全艦の起動（`--all`）のどれか1つだけを読み込んで実行する |
| `settings/` | 設定サーバー（`--settings`）。`~/.make-it-so` の読み書きの API と、画面（`settings.html`）の配信。艦の設定は読み込まない |
| `index.ts` | 配線層。**`config.ts` を直接 import してよい唯一のモジュール。** 部品を生成して繋ぎ（`buildShip()` は、配信はせずに `app` を返す）、艦のポートで listen する（`runShip()`） |
| `app.ts` | `createApp(deps)`: Express アプリの組み立て |
| `routes/` | 機能ごとの router（`createXxxRouter(deps)`）。`mission-id.ts` は、ミッション ID の解決を共有する |
| `config.ts` | `--ship` の引数とホームディレクトリを渡して `load-config.ts` を呼び、`config` を作る |
| `load-config.ts`, `fleet-config.ts` | `config.yml`・名簿・艦の設定の読み取りと検証。引数を取る関数で、不備は例外 |
| `bridge.ts` | `createBridge(deps)`: ターンの管理、自動リカバリ、停止 |
| `crew-manager.ts` | `CrewManager`: セッションの管理、ブリーフィング、モデルと権限モードの適用 |
| `crew-runner.ts` | `CrewRunner`: タスクの実行 |
| `crew-events.ts` | `connectCrewEvents`: イベントの反映 |
| `crew-briefing.ts`, `skills.ts`, `crew-paths.ts` | ブリーフィングの組み立て、スキルの読み取り、パス |
| `crew-model.ts` | モデルの決定（`resolveCrewModel`）。純粋関数 |
| `mcp-board.ts` | 掲示板の MCP サーバー |
| `mcp-memory-tools.ts` | 掲示板の MCP の、Memory のツール（ストアの薄い包み） |
| `memory-store.ts`、`memory-document.ts`、`memory-path.ts`、`memory-index-md.ts`、`memory-diff.ts` | 艦の Memory。`createMemoryStore(deps)` が、Markdown のファイル（OKF のバンドル）を書き、検索の索引を DB に、履歴を git（isomorphic-git）に持つ。変更は、すべて1本の待ち行列で処理する。残りは純粋な補助（ファイル形式、パスの規則、`index.md` の文、行の差分）。`routes/memory.ts` は、ビューア用の読み取り専用の側 |
| `memory-skill.ts` | Memory の使い方をクルーに教える、アプリ組み込みのスキル（コードの中の文字列なので、リモートのクルーも `get_skill` で読める） |
| `mcp-listener.ts` | `/mcp` だけを配信するリスナー。ループバックのみで、ポートは OS が選び、掲示板がつながるまでは 503 |
| `ship-lock.ts`, `ship-id.ts` | デスクトップアプリで開いている艦の `desktop.pid` の印（プロセス ID と開始時刻。ブラウザ版と設定が読む）と、艦の ID が、パスやコマンドラインを作る前に、満たすべき唯一のパターン |
| `a2ui-action.ts`, `a2ui-validate.ts` | A2UI: 回答の action メッセージと、クルーが作ったメッセージの厳格な検証 |
| `database.ts`, `migrations.ts` | SQLite と、スキーマの版管理 |
| `timeline.ts` | 実行中のアイテムと、スナップショットの合成 |
| `*-agent-client.ts`, `base-acp-client.ts`, `agent-client.interface.ts`, `agent-client-factory.ts` | ACP クライアント |
| `ssh.ts`, `host-tunnel.ts`, `crew-hosts.ts` | リモートホスト（SSH コマンドの組み立て、逆トンネルの常駐管理） |
| `usage-fetcher.ts`, `account-usage.ts`, `account-identity.ts` | 使用量の取得と、アカウントごとの集計 |
| `quick-actions.ts` | カスタムメニュー（`quick-actions.yml`）: 項目の読み込み・検証・保存と、1つの艦から見た編集。艦のサーバー（`routes/quick-actions.ts`）と設定サーバーが共有する |
| `messages.ts`, `language.ts` | サーバーが書く固定メッセージ（英語の文言とキー）、言語の決定 |
| `logger.ts` | `configureLogger(...)` で設定する |
| `testing/` | テスト用の補助 |

### デスクトップアプリ（`src/electron/`）と、画面側

| ファイル | 役割 |
|---|---|
| `main.ts` | アプリの入口。起動のしかた（`start-mode.ts`）、艦ごとに1つのインスタンス、ウィンドウ、艦が止まってから終了すること。起動の判断をしてから `index.ts` を読み込むので、設定は、動かす艦のものになる |
| `start-mode.ts`、`argv.ts` | 艦を1隻/艦の一覧/設定、パッケージ版の引数 |
| `in-memory-fetch.ts` | リクエストを、メモリ上の HTTP 接続を通して、Express に渡す（ポートなし）。ローカル用の検査が断るブラウザ由来のヘッダーを外す |
| `shell-requests.ts`、`window-fit.ts` | ページが、パス `/__shell/window`（ヘッダーの高さと、両端に空ける余白。アプリは、ページの拡大率を返す）と `/__shell/appearance`（表示しているテーマと言語。表示メニューの印のため）で、アプリに伝えること。前者から決める、ウィンドウのボタンの位置と、最小の幅 |
| `launcher-page.ts`、`launcher-handler.ts`、`launcher-text.ja.ts` | 艦の一覧（スクリプトなしのページ）と、その応答 |
| `desktop-runtime.ts`、`running-in-browser.ts` | 設定から見た、デスクトップアプリで開いている艦と、ブラウザ版で動いている艦 |
| `application-menu.ts` | メニュー。設定への道と、テーマ、UI の言語、クルーの言語を選ぶ表示メニュー（ページが、表示しているものを報告し、選んだものは、`makeitso:appearance` イベントとしてページに送られる。`/__shell/*` への答えを除くと、アプリからページへの唯一の道） |
| `src/client/shell.ts`、`desktop-shell.css`、`use-shell-window.ts`、`use-shell-appearance.ts` | ページ側。デスクトップアプリ（と macOS）であることの印、macOS でタイトルバーを兼ねるヘッダー（ウィンドウのボタンの余白は、ページの拡大で伸び縮みさせない）、大きさと、表示しているものをアプリに知らせること、表示メニューの選択を反映すること |
| `src/client/layout-mode.ts`、`use-left-pane.ts`、`RadioGroup.tsx` | レイアウトが変わる幅（1か所に置き、スタイルシートのために、ページが `<html>` に印を付ける）、左ペインを出すか（会話の隣に置くか、狭いウィンドウでは、会話の上に重ねるドロワーにするか）、設定セクションのラジオボタン |

### 依存の向き

- ルート・部品は、必要なものを引数で受け取り、`config.ts` や他の部品を直接 import しません。
- `database.ts` は、ロールの解決（`agentToRole`）を、`initDatabase` の引数で受け取ります。

## 依存の渡し方

- **`config.ts` を直接 import してよいのは、`index.ts` だけです。** 他のモジュールは、必要な値（設定の一部・外部コマンド・現在時刻・他の部品）を、ファクトリ `createXxx(deps)` かコンストラクタの引数で受け取ります。`deps` は、そのモジュールが使うものだけを `Pick<…>` などで絞って渡します。
- インポートしただけで副作用（設定の読み込み・ファイルの作成・ネットワーク）が走るモジュールを作りません。モジュールレベルの状態（Map・キャッシュ）は、ファクトリのインスタンスに閉じます。
- 「起動前は null」になりうる変数に、後から setter で入れる形は避けます。依存が揃ってから生成します。（認めている例外が1つあります。`mcp-listener.ts` は、先にポートを取ります。セッションに渡す MCP の URL と、逆トンネルが、掲示板の部品が揃う前にポート番号を必要とするためで、`serve()` でハンドラーを渡されるまでは 503 を返します。）
- `logger`・`timeline` のように、本質的に単一の状態は、起動時に一度だけ `configureLogger(...)`・`configureTimeline(...)` で設定します。

## クライアントの構成

`src/client/`（React + Vite）。**ロジックはサーバーに寄せ、クライアントは、単一のデータソースから描画するだけ**にします（[基本概念](concepts.ja.md#設計の方針)）。

| ファイル | 役割 |
|---|---|
| `server-api.ts` | **API を呼ぶ唯一の場所。** `fetch` や `"/api/..."` を、他のファイルに直書きしない。接続先は同一オリジンの相対パス（サーバーが別のオリジンからの呼び出しを拒否するため、ほかには向けられない） |
| `chat-state.ts` | `chatReducer`: 会話の状態更新（純関数）。**コンポーネントに状態更新のロジックを書かない** |
| `permission-state.ts` | 承認待ちの状態更新（純関数）。サーバーとのやり取りは `usePermissions.ts` |
| `chat-grouping.ts`, `mission-filter.ts`, `search-group.ts` ほか | 並べ替え・絞り込みなどの純関数 |
| `preferences.ts` | `localStorage` に持つ個人用の設定 |
| `i18n/` | 多言語。`en.ts` が辞書の正本、`ja.ts`、`translate.ts`（`t()` の純関数） |

- **クライアントのソースファイル名を `api` で始めないでください。** Vite の開発サーバーは、`/api/` で始まるパスをバックエンドへ中継するため、`/api.ts` のような名前だと、読み込めずに画面が真っ白になります。
- クライアントが、サーバーの値から推測・変換・再構築するロジック（例: エージェント名から役職への対応づけ、時刻の突き合わせによる重複の排除、複数のエンドポイントの結果の合成）が必要になったら、サーバー側の設計の不備のサインです。サーバーで解決します。
- 新しい機能は、まず既存の単一のデータソース（`TimelineItem` / `GET /api/timeline`）を拡張できないかを考え、エンドポイントや SSE の種類を安易に増やしません。

## テスト

- `npm test`（`vitest run`）。`vitest.config.ts` は、艦の設定を読み込みません。
- **子プロセスを起動する部品は、起動関数を引数で差し替えられます**（`BaseAcpClient` の spawn、`createHostTunnels` の ssh）。偽のプロセス（`testing/fake-acp-process.ts`）で、標準入出力の JSON-RPC や接続の状態の遷移を、実プロセスなしで検証します。
- DB は `initDatabase({ path: ":memory:", ... })` でインメモリにします。エージェントは `FakeAgentClient` を、`CrewManager` の `createClient` に渡します。ルーターやアプリ全体は、`startTestServer` / `serveApp` で空いているポートに立てて、`fetch` で叩きます。
- クライアントは、状態更新・並べ替え・設定・API の組み立てを、DOM なしの純関数としてテストします（コンポーネントそのもののテストは、ほとんどありません）。
- **文書とコードのずれの検出:** `testing/docs-drift.test.ts` が、HTTP の全ルートと、設定のキーが、リファレンスに載っていることを確かめます（サーバーが環境変数を読まないことも、固定しています）。ルートや設定を足したら、リファレンスも更新してください。
- **日本語の混入の検出:** `testing/no-hardcoded-japanese.test.ts` が、日本語を許可したファイル以外に、日本語（コメントを含む）が無いことを確かめます。
- 方針: **テストは、リファクタの手段であり、固定すべき資産ではありません。** テストがあるからという理由で、プロダクトコードの変更を避けません。テストが落ちたら、バグか、意図した変更かを判断し、意図した変更なら、テストを直します。実装の細部（モックやモジュールのパス、内部の文字列形式）に結びついたテストは、残す価値が低いです。守るのは、外から見える振る舞い（クライアントとの契約と、起きたバグの回帰）です。
- 関数を切り出すときは、その場で現状の挙動をテストにして固定します。

## スキーマを変えるとき

1. `src/server/migrations.ts` の `MIGRATIONS` の**末尾に**、次の版番号でマイグレーションを足します。
2. **公開済みのマイグレーションは書き換えません。** `database.ts` に、`CREATE TABLE` や `ALTER TABLE` を、直接足しません。
3. 列の追加は、`addColumnIfMissing` を使います。古い行の意味づけ（空の列の扱いなど）は、読み出し側の特別扱いにせず、マイグレーションでデータを一度だけ直します。
4. 版 1（`baseline`）の中で使う、既定ミッションの ID と名前は、定数ではなく文字列のまま書きます（公開済みの内容が、アプリ側の定数の変更で変わらないようにするため）。
5. [データモデル](reference/data-model.ja.md)の表と、バージョン一覧を更新します。
6. 起動して、既存の DB（`data/bridge.db`）が、`.bak-v<旧版>` を残して移行されることを確かめます。

仕組みと規則は、[データモデル](reference/data-model.ja.md#マイグレーション)を参照してください。

## HTTP のルートを足すとき

1. `src/server/routes/` に、`createXxxRouter(deps)` として足します。`index.ts` で生成して `createApp` に渡します（**`index.ts` にルートを直書きしません**）。
2. クライアントからの呼び出しは、`src/client/server-api.ts` に足します。
3. [HTTP API リファレンス](reference/http-api.ja.md)に、行を足します（足さないと、`docs-drift.test.ts` が落ちます）。

## プロバイダーを足すとき

差異は、プロバイダーごとのクライアントに閉じ込めます。上位のコード（`crew-manager.ts`、`config.ts` など）に、`if (provider === "...")` のような分岐を書きません。

1. `BaseAcpClient`（または `BaseAgentClient`）のサブクラスを作ります。起動引数（`buildSpawnArgs`）、セッションの作成と再開、プロバイダー固有の通知（`handleProviderNotification`）などを実装します。
2. `agent-client-factory.ts` に登録します。
3. `usage-fetcher.ts` に、使用量を取得するコマンドの分岐を足します。
4. 掲示板（MCP）の登録を確かめます。`session/new` で動的に注入し、セッションごとの識別ヘッダーと、艦の `/mcp` 用の秘密の値を付けます。これが使えないと、`dispatch_task` などが使えません。
5. 権限の許可リストなど、プロバイダー固有の仕組みを確認します。`Write`・`Read`・`Edit` と掲示板のツールを許可しておかないと、通常の作業が承認待ちだらけになります。
6. ワークスペースの信頼のような、プロバイダー固有の落とし穴が無いかを確認します（Claude Code は、ヘッドレスでは信頼の確認が出ず、未信頼のディレクトリで許可ルールが無視されます）。
7. `targets` / `access`（担当範囲）は、プロンプトでの取り決めで、プロバイダーに依存しないため、足す必要はありません。

## コメントと言語の規約

- コード中のコメント（JSDoc・`//`・`/* */`・JSX のコメントすべて）は**英語**で書きます。テストの名前（`describe`/`it`）も英語です。
- コメントには、**現状の仕様と、その理由（Why）だけ**を書きます。「以前は〜だったが〜に変えた」といった経緯は、コミットメッセージに書きます。
- 特定の作品のキャラクター名は書きません（サンプルや説明には、中立な名前を使います）。
- UI の文言は、辞書（`i18n/`）を通します。サーバーが、タイムラインに書く固定のメッセージは、`messages.ts` のキーを通します。
