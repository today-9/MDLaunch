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
  static/       UI (vanilla JS / CSS。mermaid / KaTeX 同梱、CDN 不使用)
    themes/     画面・PDF テーマ (viewer-*.css / pdf-*.css を置くと自動で選択肢に出る)
vault/          ノートの実体(ただの .md ファイル。個人データなので git 管理外)
examples/vault/ サンプルノート(記法ガイドなど)。vault/ が空の初回起動時に自動コピーされる
```

環境変数 `MDLAUNCH_VAULT` で Vault の場所、`MDLAUNCH_PORT` でポートを変更できます。

## ライセンス

[MIT](LICENSE)

## Acknowledgements

- 本プロジェクトの9割は [Claude Code](https://claude.com/claude-code)
  (Claude Fable 5) の仕事である。仕様設計、Notion 風 UI の実装、
  同名ノートの Wikiリンク衝突や VBS の文字コード化けといったバグの切り分け、
  ヘッドレスブラウザを DevTools プロトコルで操縦しての自動検証、
  GitHub 公開までを一貫して担当した。
  人間(リポジトリ主)の主な貢献は、要望出しと「いいねえ」と言う動作確認である
- [markdown-it-py](https://github.com/executablebooks/markdown-it-py) / [Pygments](https://pygments.org/) — Markdown 解析とコードハイライト
- [KaTeX](https://katex.org/) / [Mermaid](https://mermaid.js.org/) — 数式・図表レンダリング(オフライン同梱)
- [FastAPI](https://fastapi.tiangolo.com/) / [uvicorn](https://www.uvicorn.org/) — ローカルサーバー
