[English](add-remote-host.md)

# リモートホストのクルーを足す

別のマシン（SSH で入れるサーバーなど）で、クルーを動かします。

## 前提

- リモートに、エージェント（claude なら `claude-agent-acp`、kiro なら `kiro-cli`）と `bash` があること。make-it-so 専用のものは要りません。リモートは Unix 系のみです。
- 鍵認証で、パスワードなしに `ssh <ホスト名>` できること。

## 手順

1. 各マシンの `~/.ssh/config` に、接続の詳細（鍵・ポート・ユーザーなど）を書きます。これらは `hosts.yml` には書けません（共有される設定に残らないようにするためです）。

2. `~/.make-it-so/hosts.yml` に、宛先を書きます。

   ```yaml
   hosts:
     dev-server:
       destination: dev-server   # ~/.ssh/config の Host 名、または user@host
   ```

3. `ship.yml` のクルーに、`host:` と、**リモート側の絶対パスの `cwd:`** を書きます。

   ```yaml
   crew:
     remote_engineer:
       member: sam
       host: dev-server
       cwd: /home/me/project
   ```

4. サーバーを再起動し、そのクルーに話しかけます。

エージェントからメインの掲示板（MCP）への経路は、make-it-so が、ホストごとに SSH の逆トンネルで自動的に張ります。

## 制約

- `access`（担当範囲）は指定できません（エラー）。`skills` は案内されません（警告して無視）。
- 接続が切れたときは、次に呼びかけたときに、新しいセッションで立ち上がります（続きからの再開はしません）。
- そのホストを共有する他のユーザーは、逆トンネルを通じて掲示板を呼べます。信頼できるホストだけで使ってください（[セキュリティ](../security.ja.md)）。
- アカウントごとの使用率の集計には含まれません。
