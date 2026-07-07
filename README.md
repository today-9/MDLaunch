# MDLaunch 🗂️

フォルダに置いたただの `.md` ファイルを、Notion ライクな UI で **眺める・探す・増やす** ためのローカル Web アプリ。
編集は VSCode に任せる思想。クラウド不要・CDN 不要で、社内環境でもそのまま動きます。

## 起動と終了

- **起動**: `MDLaunch.vbs` をダブルクリック(推奨)。ウィンドウは出ず、ブラウザにアプリが開きます。すでに起動中ならタブを開くだけなので、何度クリックしてもOK
- **終了**: アプリのサイドバー左下「⏻ 終了」ボタン
- ログを見たいとき: `MDLaunch.bat`(コンソール表示あり)や `uv run python -m app.launch`

ポートは環境変数 `MDLAUNCH_PORT`(既定 8321)、Vault の場所は `MDLAUNCH_VAULT` で変更できます。

## 機能

| 機能 | 説明 |
|---|---|
| 一覧 | サイドバーのフォルダツリー / タグフィルタ / 更新順一覧 |
| 検索 | `Ctrl + K` でタイトル+全文のインクリメンタル検索 |
| 追加 | 「＋ 新規ノート」→ frontmatter 付きテンプレートを作成して VSCode で開く |
| ビューワー | GFM(テーブル・タスクリスト)、コードハイライト、Mermaid、`[[Wikiリンク]]`、バックリンク |

## ノートの書き方

`vault/` に `.md` を置くだけ。先頭の frontmatter は任意です:

```markdown
---
title: ノートのタイトル
icon: 💡
tags: [idea, work]
---

本文。[[別のノート]] へのリンクも書ける。
```

- `title` を省略するとファイル名がタイトルになります
- `icon` は絵文字1文字。ページアイコンとして表示されます
- VSCode 側で保存すると、開いている画面に約5秒で反映されます

## 構成

```
app/            FastAPI サーバー + フロントエンド
  vault.py      インデックス・検索・Markdown レンダリング
  main.py       API エンドポイント
  static/       UI (vanilla JS / CSS, mermaid 同梱)
vault/          ノートの実体(ただの .md ファイル)
```

環境変数 `MDLAUNCH_VAULT` で Vault の場所を変更できます。
