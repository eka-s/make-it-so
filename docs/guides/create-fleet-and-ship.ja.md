[English](create-fleet-and-ship.md)

# 艦隊と艦を一から作る

何もない状態から、動く最小の設定を作り、クルーを 1 人ずつ増やします。

## 前提

- Node.js 22.13 以上。
- 使うプロバイダーのエージェント CLI が、使える状態であること（claude なら `npx` と Claude Code のログイン、kiro なら `kiro-cli` とログイン）。起動コマンドが見つからないときは、手順 1 の出力とサーバーの起動ログで警告します。ログイン済みかどうかは確認できません。

## 手順

1. 最小の設定を作ります。

   ```
   npm run init -- --provider claude --ship my-ship --port 3939
   ```

   | 引数 | 既定 | 意味 |
   |---|---|---|
   | `--provider` | `claude` | 使うプロバイダー（`claude` か `kiro`） |
   | `--ship` | `my-ship` | 艦の ID（ディレクトリ名） |
   | `--port` | `3939` | 艦のポート |

   作られるもの（ホームディレクトリの `~/.make-it-so/` の中）: `config.yml`、`roster.yml`（クルー 1 人）、`~/.make-it-so/ships/{艦ID}/ship.yml`（そのクルーが副長）。**既存のファイルは上書きしません。** 1 つでも既にあれば、何も書かずに、衝突したファイルを示して止まります。

2. ビルドして起動します。

   ```
   npm run build && npm start
   ```

   ブラウザで `http://127.0.0.1:3939/` を開きます。艦が複数あるときは、`npm start -- --ship <艦ID>` のように、`--ship` を付けます（[複数の艦を動かす](run-multiple-ships.ja.md)）。

3. 話しかけて、動くことを確かめます。入力欄に書いて Ctrl+Enter で送ります。

## クルーを増やす

1. `~/.make-it-so/roster.yml` に、メンバーを足します。

   ```yaml
   crew:
     alex:
       name: Alex
     sam:
       name: Sam
       model: sonnet
   ```

2. `~/.make-it-so/ships/{艦ID}/ship.yml` の `crew:` に、役職を足します。

   ```yaml
   crew:
     lead:
       member: alex
       rank: commander
     engineer:
       member: sam
       rank: chief
   ```

   役職名は、英数字・`_`・`-`（先頭は英数字）の範囲で、自由です。`rank` で、タスクの権限が決まります（[基本概念](../concepts.ja.md#階級)）。

3. サーバーを再起動します。設定は起動時に読みます。

## 人格・アイコンを付ける

- 人格: `~/.make-it-so/personnel/{ID}.md` に、口調や性格を書きます（無ければ人格なし）。
- アイコン: `~/.make-it-so/personnel/{ID}.png` を置くか、画面のクルーの人事記録からアップロードします。

## うまくいかないとき

起動時の検証で止まったときは、メッセージに原因が出ます。一覧は[設定リファレンス](../reference/configuration.ja.md#起動時の検証とエラー)を参照してください。
