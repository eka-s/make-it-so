# 学習ドキュメント: リモートエージェント(SSH経由)の実装を理解する

別PC・サーバ上のAIエージェントを、make-it-soのチャットでローカルのクルーと同じように扱えるようにした実装を、ネットワークの基礎から順に理解するための資料。

- 仕様としてのまとめは `docs/guides/add-remote-host.md` にある。この文書は「なぜそうなっているか」を腹落ちさせるための解説。
- 読み方: 第1章で全体像をつかみ、第2章の基礎知識は知らない用語だけ拾い読みし、第3章でコードと対応づける。迷ったら第6章の用語集へ。

---

## 1. 全体像: 今回何を作ったのか

### 1.1 やりたかったこと

make-it-soの「メイン」(DB・UI・タスク管理)は、AIエージェント(kiro-cli、claude-agent-acp)を**自分の子プロセスとして起動**して会話している。つまりエージェントは必ずメインと同じPCにいた。これを「別のPCやサーバにいるエージェントでも、同じように使いたい」。

### 1.2 解き方の方針

「通信の通り道だけを差し替える」。エージェントとの会話は、もともと標準入出力(stdio)の上に流れるメッセージ(ACP)なので、**そのstdioをSSHで遠くのPCまで延ばす**だけで、メイン側のロジックは変えずに済む。

### 1.3 できあがった構成

```
┌───────────────── メインのPC ─────────────────┐       ┌──────────── リモートPC ────────────┐
│                                              │       │                                    │
│  make-it-so メイン (port 3939)               │       │                                    │
│   ├─ CrewManager                             │       │                                    │
│   ├─ MCP掲示板  http://127.0.0.1:3939/mcp ◄──┼───┐   │                                    │
│   │                                          │   │   │                                    │
│   ├─ ssh ①「会話用」 ────────────────────────┼───┼──►│ bash → claude-agent-acp           │
│   │     (stdinにACPを書き、stdoutから読む)   │   │   │        ▲                           │
│   │                                          │   │   │        │ HTTPで /mcp を呼ぶ        │
│   └─ ssh ②「逆トンネル」(ホストごとに1本) ───┼───┴───┼─ 127.0.0.1:3939 (待ち受け)         │
│                                              │       │                                    │
└──────────────────────────────────────────────┘       └────────────────────────────────────┘
```

- **ssh ①(会話用)**: クルー1人につき1本。リモートでエージェントを起動し、そのstdinとstdoutがそのままSSHの暗号化された線の上を流れる。
- **ssh ②(逆トンネル)**: ホストごとに1本。リモートのエージェントが「リモート自身のlocalhost:3939」に話しかけると、その通信がSSHの線を逆向きに通ってメインの掲示板(`/mcp`)に届く。

この2本が今回の実装のすべて。以降の章は、この図の各部分(stdio、SSH、トンネル、localhost…)を一つずつ説明する。

---

## 2. 基礎知識

### 2.1 プロセスと標準入出力(stdio)・パイプ

プログラムが動いている実体を**プロセス**と呼ぶ。あるプロセスが別のプログラムを起動すると、起動した側が**親プロセス**、された側が**子プロセス**になる。make-it-soのメインが親、kiro-cliやclaude-agent-acpが子。

すべてのプロセスは、次の3本の「出入り口」を持っている。

| 名前 | 略称 | 役割 |
|---|---|---|
| 標準入力 | stdin | 外から文字を受け取る入口 |
| 標準出力 | stdout | 普通の出力を出す出口 |
| 標準エラー出力 | stderr | エラーやログを出す出口 |

ターミナルで動かすと、stdinはキーボード、stdout/stderrは画面につながっている。しかし親が子を起動するときは、これらを**パイプ**(一方向の筒)につなぎ替えられる。親は筒に書き込めば子のstdinに届き、子がstdoutに出した文字は筒を通って親が読める。

```
親(make-it-so)  ──書く──► [パイプ] ──► 子のstdin
親(make-it-so)  ◄──読む── [パイプ] ◄── 子のstdout
```

make-it-soの `BaseAcpClient.spawn` はまさにこれをやっていて、`stdio: ["pipe", "pipe", "pipe"]` が「3本ともパイプにつなぐ」という指定。

**ここが今回の要点**: 子プロセスと親は「筒」でしか話していない。だから、その筒の向こう側が**同じPCの子プロセス**でも**SSHで繋がった遠くのPCのプロセス**でも、親から見れば同じ。これが「通り道だけ差し替える」で済んだ理由。

参考:
- [Ruby: open3(子プロセスの標準入出力をパイプでつなぐ)](https://docs.ruby-lang.org/ja/3.1/library/open3.html) — 言語は違うが、`popen3` が3本のパイプをつなぐ仕組みの説明は同じ考え方
- [Microsoft: リダイレクトされた入出力を持つ子プロセスの作成](https://learn.microsoft.com/ja-jp/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output) — Windowsでの同じ仕組みの解説

### 2.2 JSON-RPC と ACP / MCP

stdioの筒の上を「どんな文字列」が流れるかの取り決めがプロトコル。

- **JSON-RPC 2.0**: 「メソッド名と引数を書いたJSONを送ると、結果のJSONが返ってくる」という最小限の取り決め。1行1メッセージで流すことが多い。
  ```json
  {"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{"sessionId":"…","prompt":[{"type":"text","text":"1+1は？"}]}}
  {"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}
  ```
  `id` で「どの問い合わせへの返事か」を対応づける。返事を待たない一方通行は `id` なしの**通知**(notification)。
- **ACP (Agent Client Protocol)**: JSON-RPCの上に作られた「クライアント(make-it-so)とAIエージェントの会話用メソッド集」。`initialize`、`session/new`、`session/prompt`、`session/request_permission`(ツール使用の許可を求める)などがある。**stdioで流す**のが基本。
- **MCP (Model Context Protocol)**: こちらも JSON-RPC ベースで、「AIが使えるツールを公開する仕組み」。make-it-soの掲示板(`dispatch_task`、`get_task` など)はMCPのサーバーとして実装され、**HTTPで**呼ばれる。

つまり2種類の通信がある。

| | 向き | 乗り物 | 今回のSSHでの扱い |
|---|---|---|---|
| ACP(会話) | メイン → エージェント | stdio | ssh ①で運ぶ |
| MCP(掲示板) | エージェント → メイン | HTTP | ssh ②(逆トンネル)で運ぶ |

参考:
- [JSON-RPC 2.0 公式仕様(英語)](https://www.jsonrpc.org/specification)
- [JSON-RPC の日本語メモ(Scrapbox)](https://scrapbox.io/standard/JSON-RPC) — 概要をつかむ用
- [Agent Client Protocol(英語)](https://agentclientprotocol.com) / [Model Context Protocol(英語)](https://modelcontextprotocol.io)

### 2.3 IPアドレス・ポート・localhost・listen

- **IPアドレス**: ネットワーク上の機器の住所(例 `192.168.1.10`)。
- **ポート番号**: 1台の機器の中で「どのプログラム宛てか」を区別する番号(0〜65535)。IPが「建物の住所」ならポートは「部屋番号」。make-it-soの艦は `3939` などを使う。
- **listen(待ち受け)**: プログラムが「このポートに来た接続を受け付けます」と待機すること。サーバーは listen し、クライアントが connect する。
- **localhost / 127.0.0.1**: **「自分自身」を指す特別な住所**(ループバックアドレス)。`127.0.0.1:3939` に接続すると、**どのPCから見ても「そのPC自身」の3939番**に繋がる。ネットワークの外には出ない。

ここが今回いちばん混乱しやすい点: **「localhost」は、誰が言うかで指す先が変わる。**

- メインのPCで `127.0.0.1:3939` → メインのPC自身(掲示板がいる)
- リモートPCで `127.0.0.1:3939` → リモートPC自身(普通は誰もいない)

逆トンネルは、この「リモートPC自身の3939番」に**あえて穴を開けて**、メインの3939番へ繋ぐ仕掛け。

また、サーバーを `127.0.0.1` にだけ bind(listen)すると、外部のPCからは繋げず、自分のPCからだけ繋げる。make-it-soが既定でそうしているのは、認証がないサーバーをLANに晒さないため(`config.ts` の `server.host` のコメント参照)。

参考:
- [@IT: ローカルループバックアドレス「127.0.0.1」「::1」「localhost」とは？](https://atmarkit.itmedia.co.jp/ait/articles/0610/14/news021.html)

### 2.4 NATとファイアウォール: なぜ「外から繋げない」のか

家庭やオフィスのPCは、ルーターの内側(プライベートネットワーク)にいる。

- **NAT**: 内側のプライベートなアドレスと、外のグローバルなアドレスを付け替える仕組み。
- **ファイアウォール**: 通信を許可・拒否するルール。一般に「内→外は許可、外→内は原則拒否」。

その結果、**自宅PCから外のサーバーに繋ぐのは簡単だが、外のサーバーから自宅PCに繋ぐのは難しい**。外からの接続は、ルーターが「内側のどの機器宛てか」を知らないので届かない。これを解くのが**ポート開放**(ルーターに例外を設定)だが、入口を増やすのでセキュリティ上は避けたい。

今回の「掲示板への呼び戻し」はまさにこの問題。リモートのエージェントがメイン(NATの内側かもしれない)に自力で繋ぎに行くのは難しい。そこで**メイン側から外向きに張ったSSHの線を逆向きに使う**(逆トンネル)ことで、ポート開放なしで解決している。

参考:
- [ITトレンド: ファイアウォールとは(NATとの違い含む)](https://it-trend.jp/firewall/article/60-0002)

### 2.5 SSHとは

**SSH (Secure Shell)** は、ネットワーク越しに別のPCへ**安全に**ログインしたり、コマンドを実行したりする仕組み。通信はすべて暗号化される。

#### 公開鍵認証

パスワードの代わりに「鍵のペア」で本人確認する方式。

- **秘密鍵**: 自分だけが持つ。誰にも渡さない。(例 `~/.ssh/id_ed25519`)
- **公開鍵**: 接続先に置いておく。見られても問題ない。(例 `~/.ssh/id_ed25519.pub`)
- 接続先の `~/.ssh/authorized_keys` に公開鍵を登録しておくと、「その公開鍵に対応する秘密鍵を持っている人」だけがログインできる。秘密鍵そのものはネットワークに流れない。

実験環境では `ssh-keygen -t ed25519` で鍵を作り、公開鍵をコンテナの `authorized_keys` に入れた。

#### ホスト鍵(known_hosts)

逆方向の確認もある。初めて繋ぐ相手は「本当に目的のサーバーか」を確認する必要があり、サーバーの**ホスト鍵**の指紋を `~/.ssh/known_hosts` に記録する。次回以降、鍵が変わっていたら「なりすましの可能性」として接続を拒否する(`Host key verification failed`)。実験では使い捨てコンテナ相手なので、`~/.ssh/config` の `dock` に `StrictHostKeyChecking no` を書いて確認を省いたが、**本番では省かない**こと(`accept-new` なら初回だけ自動で受け入れて以降は検証する)。

#### その他

- **ssh-agent**: 秘密鍵を預かって、毎回パスフレーズを入力しなくて済むようにする常駐プログラム。
- **~/.ssh/config**: 接続先ごとの設定(ユーザー名、鍵、ポートなど)をまとめるファイル。make-it-soの `fleet/hosts.yml` では `destination` に `Host` 名を書くだけにして、鍵・ポート・ホスト鍵の扱いなどの接続の詳細はすべてここに書く(第3.7節)。

参考:
- [Zenn: SSH公開鍵認証の解説](https://zenn.dev/irukaboat/articles/4ddde6e79648cc)
- [京都産業大学: SSHログインの手引き(PDF)](https://jweb.kyoto-su.ac.jp/ccinfo/pdf/ssh_login.pdf)
- [OpenSSH公式マニュアル ssh(1)(英語)](https://man.openbsd.org/ssh) / [ssh_config(5)(英語)](https://man.openbsd.org/ssh_config)

### 2.6 `ssh host コマンド` でリモートコマンドを実行する

```bash
ssh user@server ls /tmp
```

のようにコマンドを付けると、ログインして対話するのではなく**そのコマンドだけをリモートで実行**し、結果をこちらに返す。重要なのは、このとき**リモートコマンドのstdin/stdout/stderrが、手元のsshコマンドのstdin/stdout/stderrにそのまま繋がる**こと。

```
手元: [make-it-soの子プロセス "ssh"]                  リモート: [claude-agent-acp]
        stdin  ───暗号化された線───►  stdin
        stdout ◄──暗号化された線────  stdout
```

だから、2.1で説明した「子プロセスのstdioとパイプで話す」を、**子プロセスを `ssh …` に置き換えるだけ**で遠隔化できる。メインから見れば、相変わらず `ssh` という子プロセスのstdioと話しているだけ。

`-T` オプションは「疑似端末(pty)を割り当てない」。ptyを付けると改行コードの変換などが起きるので、JSONを正確に流したいときは付けない。

### 2.7 SSHポートフォワーディング(トンネル)と逆トンネル

SSHの線には、コマンドのstdioだけでなく**任意のTCP通信**を相乗りさせられる。これが**ポートフォワーディング**(通称 **SSHトンネル**)。「暗号化された1本の線(トンネル)の中を、別の通信が通っていく」様子からそう呼ぶ。

| 種類 | オプション | 意味 |
|---|---|---|
| ローカルフォワード | `-L` | 手元のポートに来た通信を、SSH経由でリモート側の宛先へ送る |
| **リモートフォワード(逆トンネル)** | **`-R`** | **リモートのポートに来た通信を、SSH経由で手元側の宛先へ送る** |
| ダイナミックフォワード | `-D` | 手元にSOCKSプロキシを立て、通信を丸ごとリモート経由にする |

#### ローカルフォワード(`-L`)のイメージ

```
手元 localhost:8080 ──► [SSHの線] ──► リモートPCが 内部サーバー:80 に接続
```
手元のブラウザで `localhost:8080` を開くと、実際にはリモート側のネットワークにあるサービスが見える。

#### リモートフォワード(`-R`、逆トンネル)のイメージ ← 今回使うもの

```
リモート 127.0.0.1:3939 ──► [SSHの線(逆向き)] ──► 手元PCが 127.0.0.1:3939 に接続
```
リモートPC上で `127.0.0.1:3939` に繋ぐと、実際には**手元PC(メイン)の3939番**に繋がる。

「逆」と呼ばれる理由: 普通はサーバー側にサービスがあり、クライアントが取りに行く。逆トンネルは**手元側(クライアント側)にあるサービスを、サーバー側から使えるように“逆向きに”公開する**から。しかも接続を張るのは手元側(外向き)なので、2.4で述べたNAT/ファイアウォールの内側にいても成立する。

書式は `-R [bind_address:]port:host:hostport`。今回は:

```
-R 127.0.0.1:3939:127.0.0.1:3939
    └ リモートで待ち受ける場所 ┘ └ 手元から見た転送先 ┘
```
- 左側(リモートで待ち受ける): リモートPCの `127.0.0.1:3939`。`127.0.0.1` を明示しているので、リモートPC内のプロセスからしか使えない(他のPCには公開されない)。
- 右側(転送先): **手元のPCから見た** `127.0.0.1:3939`、つまりメインの掲示板。

参考:
- [Zenn: SSHトンネルの解説](https://zenn.dev/aster_void/articles/cfef337bc36faa)
- [Qiita: SSHポートフォワーディング(mechamogera)](https://qiita.com/mechamogera/items/b1bb9130273deb9426f5)
- [GIGAZINE: SSHトンネルの張り方を図解したコマンド集(英語版ページ)](https://www.gigazine.net/gsc_news/en/20210209-ssh-tunnel)

### 2.8 シェルの「クォート」と、ログインシェル

#### クォート(引用符)

シェル(bashなど)は、コマンドラインの文字列を解釈してから実行する。空白で単語を区切り、`$HOME` を展開し、`;` や `&&` でコマンドをつなぐ。この解釈から文字列を守るのが**クォート**。

- **シングルクォート `'…'`**: 中身を一切解釈しない。最も安全。ただし中に `'` 自身は書けない。
- **ダブルクォート `"…"`**: `$変数` や `` `コマンド` `` は展開される。
- **バックスラッシュ `\`**: 直後の1文字だけを守る。

シングルクォートの中に `'` を入れたいときの定番テクニック: `'` を一度閉じて `\'` を書き、また開く。`it's` は `'it'\''s'` と書く。(`ssh.ts` の `shellQuote` はこの変換をしている。)

参考:
- [Qiita: bashのクォート(kojiro513)](https://qiita.com/kojiro513/items/3e589d2277e75911a5d8)
- [こいき・かん: シェルのエスケープ](https://www.koikikukan.com/archives/i/2019/03/13-000300.html)

#### ログインシェルと非ログインシェル

bashには、起動のしかたで読み込む設定ファイルが変わるルールがある。

- **ログインシェル**(`bash -l` や実際にログインしたとき): `~/.bash_profile`(または `~/.profile`)などを読む。PATHなどの環境変数はここで設定するのが定石。
- **非ログインシェル**: `~/.bashrc` 等しか読まない場合がある。

`ssh host コマンド` のように**非対話でコマンドを実行**した場合、PATHの設定(nvmで入れたnodeなど)が反映されず、`command not found` になることがある。そこで今回は `bash -lc '…'`(`-l`=ログインシェルとして、`-c`=この文字列を実行)で包んでいる。実験環境では、トークンを `/etc/profile.d/` に書き出していたので、ログインシェル経由でないと環境変数が見えなかった、という理由もあった。

参考:
- [Debian ハンドブック: シェル環境](https://www.debian.org/doc/manuals/debian-handbook/sect.shell-environment.ja.html)
- [NIGスパコン FAQ: bashの設定ファイルの読み込み順](https://sc.ddbj.nig.ac.jp/guides/FAQ/faq_software/faq_bash/)
- [@IT: Linux Tips(bashの設定ファイル)](https://atmarkit.itmedia.co.jp/flinux/rensai/linuxtips/168bpronrc.html)

---

## 3. 今回の実装を読み解く

### 3.1 登場するファイルと役割

| ファイル | 役割 |
|---|---|
| `src/server/ssh.ts` | sshコマンドを組み立てる**純関数**(設定やログに依存しない=テストしやすい) |
| `src/server/ssh.test.ts` | 上記のvitestによる単体テスト |
| `src/server/host-tunnel.ts` | ホストごとの逆トンネル(ssh ②)を常駐管理 |
| `src/server/base-acp-client.ts` | `spawn` が `host` を受け取り、あれば `ssh` で包んで起動 |
| `src/server/crew-manager.ts` | リモートのクルーは、トンネル確立(`ensureTunnel`)を待ってから起動 |
| `src/server/config.ts` | `fleet/hosts.yml` の `hosts`、`ship.yml` の `host:` を読み、制約を検証 |
| `src/server/skills.ts` | リモート向けにはローカルパスを案内する文を出さない |

### 3.2 ssh ①: 会話用のコマンド(`buildRemoteSpawn`)

`ship.yml` が次のとき:

```yaml
ensign:
  member: remote
  host: dock
  cwd: /work
```

メインが実行するコマンドは概ね次のようになる(実験環境の例)。

```bash
ssh -T -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -p 2222 -i ~/…/id_test root@127.0.0.1 \
    "bash -lc 'cd '\''/work'\'' && exec '\''npx'\'' '\''--yes'\'' '\''@agentclientprotocol/claude-agent-acp'\'''"
```

読み解き:

1. `ssh … root@127.0.0.1` — 接続先。実験ではコンテナ(`-p 2222` で公開したポート)。
2. 最後の引数が**リモートで実行する文字列**。これをリモートのユーザーのシェルが受け取り、`bash -lc '…'` を起動する。
3. `bash -lc 'SCRIPT'` の `SCRIPT` は `cd '/work' && exec 'npx' '--yes' '…'`。
   - `cd /work`: リモートでの作業ディレクトリ。`cwd` に指定した**リモート側のパス**。
   - `exec`: シェルを**エージェントそのもので置き換える**(シェルが間に残らない)。こうしておくと、stdinが閉じたときの終了の伝わり方がシンプルになる。

#### なぜクォートが二重なのか

文字列は**2つのシェルを通過する**。

1. 1つ目: リモートのログインシェルが、sshに渡された1本の文字列を解釈して `bash -lc '…'` を起動する。
2. 2つ目: その `bash -lc` が `'…'` の中身(`SCRIPT`)を解釈する。

だから `SCRIPT` 内の各単語を `shellQuote` で守り(2つ目の層向け)、さらに `SCRIPT` 全体を `shellQuote` で包む(1つ目の層向け)。`'\''` が大量に出てくるのはこの二重化の結果。パスに空白があっても、引数に `$` が混ざっても、意図した1語として届く。テスト(`ssh.test.ts`)では空白入りパス `/srv/my proj` で確認している。

#### オプションの意味(`commonArgs`)

| オプション | 意味 | なぜ必要か |
|---|---|---|
| `-T` | 疑似端末を割り当てない | JSONを正確に流すため(2.6) |
| `-o BatchMode=yes` | パスワードなどの**対話入力を禁止** | 入力待ちで固まるのを防ぐ(鍵認証前提。失敗したらすぐエラー) |
| `-o ServerAliveInterval=30` | 30秒ごとに生存確認の信号を送る | 切れた接続を検知するため |
| `-o ServerAliveCountMax=3` | 返事が3回なければ切断とみなす | 約90秒で「死んでいる」と判断 |

ポート(`-p`)や秘密鍵(`-i`)などは、make-it-so側ではあえて付けない。`~/.ssh/config` に任せる(第3.7節)。

参考: [ssh_config(5) 公式マニュアル(英語)](https://man.openbsd.org/ssh_config) で各オプションの正確な定義を確認できる。

### 3.3 `base-acp-client.ts` の spawn

```ts
const local = this.buildSpawnArgs(agentName);        // 例: npx --yes @agentclientprotocol/claude-agent-acp
const { command, args } = host
  ? buildRemoteSpawn(host, cwd ?? "~", local.command, local.args)   // 例: ssh … "bash -lc '…'"
  : local;
this.process = spawn(command, args, { stdio: ["pipe","pipe","pipe"], … });
```

ポイントは「**ローカルで起動するはずだったコマンドを、そのままsshで包む**」だけという点。これ以降の処理(1行ずつ読んでJSONを解釈、`session/new` を送る等)は一切変わらない。ローカルのプロセスの cwd は起動ディレクトリのままで、`cwd` 引数は**リモート側のパス**としてコマンド内の `cd` に使われる。

### 3.4 ssh ②: 逆トンネル(`buildTunnelSpawn` と `host-tunnel.ts`)

実行されるコマンド:

```bash
ssh -T -o BatchMode=yes … -o ExitOnForwardFailure=yes \
    -R 127.0.0.1:3939:127.0.0.1:3939 root@127.0.0.1 \
    'echo makeitso-tunnel-ready; exec cat'
```

#### 「なぜホストごとに1本？」

最初の案は、クルーのセッションごとに `-R` を付けることだった。しかしこれは壊れる。

- 同じホストに3人のクルーがいると、3本のsshがそれぞれ「リモートの3939を待ち受けたい」と要求する。
- リモートの3939番は1つしかないので、先に取った1本だけが成功し、他は失敗(または警告)になる。
- さらに、その1本が落ちた瞬間に、**他の2人のクルーのMCPも道連れで使えなくなる**。

そこで「ホストごとに専用のトンネルを1本だけ、メインが責任を持って維持する」設計にした。クルーの会話用ssh ①は `-R` を付けない素のものになる。

#### `echo …; exec cat` の仕掛け

普通ならトンネル専用の `ssh -N`(コマンドを実行しない)を使うところだが、次の2つの問題を解くために、あえてリモートでコマンドを動かしている。

1. **「トンネルが確立した」ことをどう知るか。**
   `-N` では成功しても何も表示されない。そこでリモートで `echo makeitso-tunnel-ready` を実行させ、**この目印が標準出力に届いたら確立済み**と判断する。sshサーバーは「転送の要求」を「コマンド実行の要求」より先に処理するため、目印が届いた時点では転送の準備は済んでいる、という前提(`ExitOnForwardFailure=yes` により、転送に失敗したら目印より先にsshが終了する)。
2. **メインが落ちたとき、トンネルが残らないようにしたい。**
   `exec cat` は、標準入力から読んだものをそのまま出力するだけのコマンドで、**標準入力が閉じられると終了する**。メインが落ちるとsshの標準入力(パイプ)が閉じる → リモートの `cat` が終了 → ssh も終了 → トンネルが消える。誰も後始末をしなくても、自然に片付く。

#### `host-tunnel.ts` の動き

```
ensureTunnel(host)
  └─ HostTunnel.waitReady()
        ├─ まだなら connect() で ssh を起動
        ├─ 標準出力に "makeitso-tunnel-ready" が出たら ready=true、待っている呼び出しを解放
        ├─ 20秒待っても ready にならなければエラー(原因はstderrの最後の行を添える)
        └─ sshが終了したら、2秒 → 4秒 → 8秒 … 最大30秒の間隔で再接続(指数バックオフ)
```

- **指数バックオフ**: 失敗するたびに待ち時間を倍にしていく方式。相手が落ちているときに、短い間隔でひたすら再試行して負荷をかけたり、ログを埋め尽くしたりするのを避ける。
- `crew-manager.ts` は、リモートのクルーを起動する前に `await ensureTunnel(host)` する。トンネルが無いのにエージェントを起動すると、MCP(`dispatch_task` など)が最初から使えなくなるため。

### 3.5 掲示板(MCP)の呼び出しはこう通る

リモートのエージェントが `dispatch_task` を使うときの経路を追う。

```
 ① リモートのエージェント
      │  HTTP POST http://127.0.0.1:3939/mcp   (← session/new で教えられたURL)
      ▼
 ② リモートPCの 127.0.0.1:3939  ← ssh ② が待ち受けている穴
      │  （SSHの暗号化された線を、逆向きに通る）
      ▼
 ③ メインのPCの 127.0.0.1:3939  ← make-it-so の掲示板
```

エージェントは「自分のlocalhostに話している」つもりだが、実際にはメインに届いている。`base-acp-client.ts` の `newSession` が渡す MCP の URL は `http://127.0.0.1:${config.port}/mcp` のままで**一切変更していない**(リモートでも同じ文字列が使える、というのが逆トンネルの便利さ)。識別用のHTTPヘッダー(`x-makeitso-agent`、`x-makeitso-mission`)も、同じ設定の中でそのまま付けて呼べる(トンネルはHTTPの中身には手を加えず、バイト列をそのまま運ぶだけ)。

### 3.6 なぜ孤児プロセスが残らないのか

「メインを止めたら、リモートのエージェントも消えるか」を実機で確認し、消えることを確かめた。

- ssh ①: メインが落ちるとsshの標準入力が閉じ、リモートのエージェントも標準入力のEOF(終端)を受け取って終了する(これは**エージェント側の挙動に依存**している。今回の `claude-agent-acp` では確認できた)。
- ssh ②: 3.4で説明した `cat` の仕掛け。

エージェントによっては標準入力のEOFで終了しないものもあり得るので、別のエージェントを接続するときは同じ確認をしておくと安心。

### 3.7 設定と検証(`config.ts`)

`fleet/hosts.yml`(gitで共有される、ホスト名と宛先の対応表):
```yaml
hosts:
  dev-server:
    destination: dev-server    # ~/.ssh/config の Host 名、または user@host
```

接続の詳細は、**各PCの `~/.ssh/config`** に書く:
```
Host dev-server
  HostName 192.0.2.10
  User me
  IdentityFile ~/.ssh/id_ed25519
```

こう分けた理由: `fleet` はgitで共有されるので、鍵のパスやホスト鍵の検証を省く設定が誤って残ると困る。そこで `hosts.yml` には `destination` 以外のキーを**書けなくした**(書くと、移し先を示して起動時エラーになる)。`destination` が `-` で始まる値も、`ssh` にオプションとして解釈されるのを避けるために拒否する。

`ship.yml`:
```yaml
crew:
  chief_engineer:
    member: builder
    host: dev-server
    cwd: /srv/project        # リモート側の絶対パス(必須)
```

起動時に次をチェックして、違反なら**黙って動かさずエラーで止める**(既存方針と同じ):

- `host` が未定義の名前を指している
- `host` があるのに `cwd` が無い、またはPOSIXの絶対パスでない
- `host` と `access`(targets)を併用している(第1版は未対応)

`cwd` をローカルの `path.resolve` で変換しないのは、**Windowsのメインがリモート(Linux)のパス `/srv/project` を `C:\srv\project` のように壊さないため**。

### 3.8 リモートのクルーに出さない案内

メインの案内文には、メイン側のローカルファイルのパス(`workspace`、`report-format.md`、`skills/…`)が含まれる。リモートにはそのファイルが存在しないので、**案内すると逆に混乱させる**。そこで `buildCommonAnnouncement(…, { remote: true })` は、タスク通知のルール(`get_task` を使う)だけを返す。

---

## 4. 実験環境(Docker)で何を確かめたか

「別のPC」を手元に作るため、Dockerコンテナにsshdとエージェントを入れて**擬似リモートホスト**にした。

- `127.0.0.1:2222` をコンテナのsshポートに公開。
- コンテナ内にはメインのパス(`/home/<ユーザー>/…`)が存在しない=本物のリモートに近い。
- 認証はコンテナ専用の鍵(SSH)と、エージェント用の長期トークン(環境変数、`bash -l` 経由で読み込み)。

確認した順序(コードを書く前に土台を確かめるため):

1. **ステップ1**: `ssh` 越しに `initialize` → `session/new` → `session/prompt` が通る(stdioがSSH越しで壊れない)。
2. **ステップ2**: `ssh -R` で、リモートのエージェントがメインの `/mcp` の `get_task` を呼べる。
3. **実装後**: 副長(ローカル)→ `dispatch_task` → リモートのクルー → 結果「2」まで一気通貫。トンネルは1本で、メインを止めるとリモート側の `claude-agent-acp`・`cat`・sshセッションがすべて消える。

---

## 5. よくある失敗と対処

| 症状 | 原因の例 | 見るところ・対処 |
|---|---|---|
| `Permission denied (publickey)` | 公開鍵が `authorized_keys` に無い/権限が広すぎる/鍵の指定違い | `~/.ssh` は 700、`authorized_keys` は 600。`identityFile` を確認。手動で `ssh -i … host` を試す |
| `Host key verification failed` | `known_hosts` に未登録、またはホスト鍵が変わった(再構築したコンテナなど) | 手動で一度接続して登録。`~/.ssh/config` に `StrictHostKeyChecking accept-new`(開発用) |
| `remote port forwarding failed for listen port 3939` | リモートのその番号を、別のsshや古い接続が掴んでいる | 古い接続の終了を待つ(`ServerAlive` で数分以内に解放)。メインが再試行する |
| `command not found`(リモート) | 非対話のsshでPATHが通っていない(nvm等) | `bash -lc` 経由でも通らない場合は、`~/.bash_profile` からPATHを設定。もしくは `hosts` 側でフルパス指定(将来の拡張) |
| トンネルが20秒で ready にならない | 鍵の問題、ネットワーク到達性、sshd停止 | メインのログの `[Host:名前] ssh: …` のstderrの最終行 |
| リモートのエージェントが認証エラー | リモート側にトークン(環境変数)が入っていない | リモートで直接 `bash -lc 'echo $CLAUDE_CODE_OAUTH_TOKEN | wc -c'` 等で存在確認(**値は表示しない**) |
| リモートのMCPが `Connection refused` | トンネルが落ちている | `[Host:名前] SSH tunnel closed` のログ。再接続待ち |

**セキュリティ上の注意**
- `ssh` でログインできる = そのアカウント権限でコマンドを実行できる、ということ。リモートのアカウントは**最小限の権限**にする。
- `StrictHostKeyChecking=no` と `UserKnownHostsFile=/dev/null` は**使い捨て環境専用**。本番では使わない。
- トークンや秘密鍵はチャットやリポジトリに貼らない。

---

## 6. 用語集

| 用語 | 意味 |
|---|---|
| プロセス | 動作中のプログラムの実体 |
| 親プロセス/子プロセス | 起動した側/された側 |
| stdin / stdout / stderr | 標準入力/標準出力/標準エラー出力。プロセスの3つの出入り口 |
| パイプ | プロセス間をつなぐ一方向の筒 |
| spawn | 子プロセスを起動すること |
| EOF | 入力の終端(これ以上データが来ない合図)。stdinが閉じるとEOFになる |
| JSON-RPC | JSONでメソッド呼び出しを表す軽量プロトコル |
| ACP | Agent Client Protocol。クライアントとAIエージェントの会話規約 |
| MCP | Model Context Protocol。AIが使うツールを公開する規約 |
| IPアドレス | ネットワーク上の機器の住所 |
| ポート | 機器内の「どのプログラム宛てか」を示す番号 |
| listen / bind | ポートで接続を待ち受ける/そのアドレスとポートに結びつける |
| localhost / 127.0.0.1 | 「自分自身」を指す特別な住所(ループバック) |
| NAT | プライベートとグローバルのアドレスを付け替える仕組み |
| ファイアウォール | 通信の許可・拒否のルール |
| ポート開放 | ルーターに「外からのこのポートを内側のこの機器へ」と例外を設定すること |
| SSH | 暗号化された安全なリモート接続の仕組み |
| 公開鍵認証 | 秘密鍵と公開鍵のペアで本人確認する方式 |
| ホスト鍵 / known_hosts | 接続先の本物確認に使う鍵/確認済みの記録ファイル |
| ssh-agent | 秘密鍵を預かる常駐プログラム |
| ポートフォワーディング | SSHの線に別のTCP通信を相乗りさせる機能 |
| SSHトンネル | 上記の通称。暗号化された線の中を別の通信が通る様子から |
| ローカルフォワード(-L) | 手元のポート → リモート側の宛先 |
| リモートフォワード / 逆トンネル(-R) | リモートのポート → 手元側の宛先 |
| ExitOnForwardFailure | ポート転送に失敗したらsshごと終了するオプション |
| ServerAliveInterval | 生存確認の送信間隔 |
| BatchMode | 対話入力を禁止するオプション |
| クォート | シェルの解釈から文字列を守る引用符 |
| ログインシェル | `bash -l`。`.bash_profile`等を読み込む起動方法 |
| 指数バックオフ | 再試行の間隔を倍々に延ばしていく方式 |
| 純関数 | 同じ入力なら必ず同じ出力で、外部状態に依存しない関数(テストしやすい) |
| 孤児プロセス | 親が死んだあとも残ってしまった子プロセス |

---

## 7. 参考URL一覧

日本語を優先し、一次情報(公式)は英語のものを併記した。URLは検索で見つけたもので、内容の細部は各ページで確認してほしい。

**SSHトンネル・ポートフォワーディング**
- [Zenn: SSHトンネル](https://zenn.dev/aster_void/articles/cfef337bc36faa)
- [Qiita: SSHポートフォワーディング](https://qiita.com/mechamogera/items/b1bb9130273deb9426f5)
- [GIGAZINE: SSHトンネルの張り方(英語版ページ)](https://www.gigazine.net/gsc_news/en/20210209-ssh-tunnel)

**SSH認証・設定**
- [Zenn: SSH公開鍵認証](https://zenn.dev/irukaboat/articles/4ddde6e79648cc)
- [京都産業大学: SSHログイン(PDF)](https://jweb.kyoto-su.ac.jp/ccinfo/pdf/ssh_login.pdf)
- [OpenSSH ssh(1)(英語)](https://man.openbsd.org/ssh) / [ssh_config(5)(英語)](https://man.openbsd.org/ssh_config)

**標準入出力・パイプ**
- [Ruby: open3](https://docs.ruby-lang.org/ja/3.1/library/open3.html)
- [Microsoft: リダイレクトされた入出力を持つ子プロセス](https://learn.microsoft.com/ja-jp/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output)

**プロトコル**
- [JSON-RPC 2.0 仕様(英語)](https://www.jsonrpc.org/specification) / [日本語メモ](https://scrapbox.io/standard/JSON-RPC)
- [Agent Client Protocol(英語)](https://agentclientprotocol.com) / [Model Context Protocol(英語)](https://modelcontextprotocol.io)

**ネットワーク基礎**
- [@IT: ローカルループバックアドレス](https://atmarkit.itmedia.co.jp/ait/articles/0610/14/news021.html)
- [ITトレンド: ファイアウォール](https://it-trend.jp/firewall/article/60-0002)

**シェル**
- [Qiita: bashのクォート](https://qiita.com/kojiro513/items/3e589d2277e75911a5d8)
- [こいき・かん: エスケープ](https://www.koikikukan.com/archives/i/2019/03/13-000300.html)
- [Debian ハンドブック: シェル環境](https://www.debian.org/doc/manuals/debian-handbook/sect.shell-environment.ja.html)
- [NIGスパコン FAQ: bashの設定ファイル](https://sc.ddbj.nig.ac.jp/guides/FAQ/faq_software/faq_bash/)
- [@IT: Linux Tips(bashの設定ファイル)](https://atmarkit.itmedia.co.jp/flinux/rensai/linuxtips/168bpronrc.html)

---

## 8. 理解チェック

読み終えたら、次の問いに自分の言葉で答えられるか確かめてみてほしい(答えは本文中にある)。

1. メインから見て、エージェントがローカルにいてもリモートにいても同じように扱えるのはなぜか。
2. リモートのエージェントが `127.0.0.1:3939` に話しかけると、なぜメインの掲示板に届くのか。
3. 逆トンネルがNATやファイアウォールの内側にあるメインでも成り立つのはなぜか。
4. 逆トンネルを、クルーごとではなくホストごとに1本にしたのはなぜか。
5. `echo …; exec cat` というコマンドは、何と何を実現しているか。
6. `ssh.ts` でクォートが二重になっているのはなぜか。
7. `ship.yml` の `cwd` を、メインのOS上でパス変換しないのはなぜか。
8. 別のエージェントをリモートで動かすとき、孤児プロセスについて何を確認しておくべきか。
