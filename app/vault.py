"""Vault: .md ファイル群の読み込み・インデックス・検索・レンダリング"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import frontmatter
import yaml
from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
from mdit_py_plugins.front_matter import front_matter_plugin
from mdit_py_plugins.tasklists import tasklists_plugin
from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name
from pygments.util import ClassNotFound

# タグに付けられる色名(style.css の [data-tc=…] と対応)
TAG_COLOR_NAMES = {
    "gray", "brown", "orange", "yellow", "green", "teal",
    "blue", "indigo", "purple", "pink", "red",
}

WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]")
# コードブロック・インラインコードを保護するための分割(奇数番目がコード)
CODE_SPLIT_RE = re.compile(r"(^(?:```|~~~).*?^(?:```|~~~)\s*$|`[^`\n]+`)", re.S | re.M)


def _sub_outside_code(text: str, repl) -> str:
    parts = CODE_SPLIT_RE.split(text)
    return "".join(p if i % 2 else WIKILINK_RE.sub(repl, p) for i, p in enumerate(parts))


def _iter_wikilinks_outside_code(text: str):
    parts = CODE_SPLIT_RE.split(text)
    for i, p in enumerate(parts):
        if i % 2 == 0:
            yield from WIKILINK_RE.finditer(p)


def seed_vault(vault_dir: Path, examples_dir: Path) -> bool:
    """Vault にノートが1つもなければ examples の内容を種として撒く"""
    if not examples_dir.is_dir():
        return False
    if vault_dir.exists() and any(vault_dir.rglob("*.md")):
        return False
    shutil.copytree(examples_dir, vault_dir, dirs_exist_ok=True)
    return True


@dataclass
class Note:
    rel_path: str          # vault からの相対パス (posix, .md 付き)
    title: str
    icon: str
    tags: list[str]
    updated: datetime
    created: datetime
    body: str              # frontmatter を除いた本文
    links: list[str] = field(default_factory=list)   # リンク先ノートの rel_path

    @property
    def folder(self) -> str:
        return os.path.dirname(self.rel_path).replace("\\", "/")

    def summary(self, query: str | None = None) -> str:
        text = re.sub(r"[#>*`\[\]!\-|]", " ", self.body)
        text = re.sub(r"\s+", " ", text).strip()
        if query:
            idx = text.lower().find(query.lower())
            if idx > 40:
                text = "…" + text[idx - 30:]
        return text[:120]


def _highlight_code(code: str, lang: str, attrs: str) -> str:
    if lang == "mermaid":
        from html import escape
        return f'<pre class="mermaid">{escape(code)}</pre>'
    try:
        lexer = get_lexer_by_name(lang or "text")
    except ClassNotFound:
        lexer = get_lexer_by_name("text")
    # "<pre" 始まりだと markdown-it がそのまま採用するので、二重ラップを避けられる
    body = highlight(code, lexer, HtmlFormatter(nowrap=True))
    return f'<pre class="codehilite"><code>{body}</code></pre>'


class Vault:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.notes: dict[str, Note] = {}
        self._mtimes: dict[str, float] = {}
        self._resolve_cache: dict[str, list[str]] = {}
        self.md = (
            MarkdownIt("gfm-like", {"highlight": _highlight_code, "linkify": True})
            .use(front_matter_plugin)
            .use(tasklists_plugin)
            .use(dollarmath_plugin, double_inline=True, allow_digits=False)
        )

    # ---------- インデックス ----------

    def refresh(self) -> None:
        seen: set[str] = set()
        for path in self.root.rglob("*.md"):
            if any(part.startswith(".") for part in path.relative_to(self.root).parts):
                continue
            rel = path.relative_to(self.root).as_posix()
            seen.add(rel)
            mtime = path.stat().st_mtime
            if self._mtimes.get(rel) == mtime:
                continue
            try:
                self.notes[rel] = self._load(path, rel)
                self._mtimes[rel] = mtime
            except Exception:
                continue
        for gone in set(self.notes) - seen:
            self.notes.pop(gone, None)
            self._mtimes.pop(gone, None)
        self._resolve_links()

    def _load(self, path: Path, rel: str) -> Note:
        post = frontmatter.load(path)
        meta = post.metadata or {}
        stat = path.stat()
        tags = meta.get("tags") or []
        if isinstance(tags, str):
            tags = [t.strip() for t in tags.split(",") if t.strip()]
        return Note(
            rel_path=rel,
            title=str(meta.get("title") or path.stem),
            icon=str(meta.get("icon") or "📄"),
            tags=[str(t) for t in tags],
            updated=datetime.fromtimestamp(stat.st_mtime),
            created=datetime.fromtimestamp(stat.st_ctime),
            body=post.content,
        )

    def resolve(self, name: str) -> list[str]:
        """[[リンク名]] を候補 rel_path のリストに解決する。

        名前だけでなく [[フォルダ/ノート名]] のようなパス末尾でも指定できる。
        優先度: 完全パス一致 > パス末尾一致 > タイトル一致。
        戻り値が2件以上のときは曖昧なリンク。
        """
        key = name.strip().replace("\\", "/").lower().strip("/")
        if key.endswith(".md"):
            key = key[:-3]
        cached = self._resolve_cache.get(key)
        if cached is not None:
            return cached
        exact: list[str] = []
        suffix: list[str] = []
        by_title: list[str] = []
        for rel, note in self.notes.items():
            rel_noext = rel[:-3].lower()
            if rel_noext == key:
                exact.append(rel)
            elif rel_noext.endswith("/" + key):
                suffix.append(rel)
            elif note.title.lower() == key:
                by_title.append(rel)
        result = exact or suffix or by_title
        # 浅いパス優先 → アルファベット順で決定的に
        result.sort(key=lambda r: (r.count("/"), r))
        self._resolve_cache[key] = result
        return result

    def _resolve_links(self) -> None:
        self._resolve_cache: dict[str, list[str]] = {}
        for note in self.notes.values():
            note.links = []
            for m in _iter_wikilinks_outside_code(note.body):
                candidates = self.resolve(m.group(1))
                if candidates and candidates[0] != note.rel_path:
                    note.links.append(candidates[0])

    def backlinks(self, rel: str) -> list[Note]:
        return sorted(
            (n for n in self.notes.values() if rel in n.links),
            key=lambda n: n.updated, reverse=True,
        )

    # ---------- 検索 ----------

    def search(self, query: str, tags: list[str] | None = None) -> list[dict]:
        q = unicodedata.normalize("NFKC", query).lower()
        results = []
        for note in self.notes.values():
            if tags and not all(t in note.tags for t in tags):
                continue
            title_l = unicodedata.normalize("NFKC", note.title).lower()
            body_l = unicodedata.normalize("NFKC", note.body).lower()
            if not q:
                score = 1
            elif q in title_l:
                score = 100 - title_l.find(q)
            elif q in body_l:
                score = 10
            elif all(w in body_l or w in title_l for w in q.split()):
                score = 5
            else:
                continue
            results.append((score, note))
        results.sort(key=lambda r: (-r[0], -r[1].updated.timestamp()))
        return [
            {
                "path": n.rel_path, "title": n.title, "icon": n.icon,
                "tags": n.tags, "folder": n.folder,
                "updated": n.updated.isoformat(),
                "summary": n.summary(query if query else None),
            }
            for _, n in results[:50]
        ]

    # ---------- レンダリング ----------

    def render(self, rel: str) -> dict:
        note = self.notes.get(rel)
        if note is None:
            raise KeyError(rel)

        def sub_wikilink(m: re.Match) -> str:
            from html import escape

            name = m.group(1).strip()
            label = escape((m.group(2) or name).strip())
            candidates = self.resolve(name)
            if not candidates:
                return f'<span class="wikilink broken" title="ノートが見つかりません">{label}</span>'
            if len(candidates) > 1:
                others = ", ".join(candidates)
                return (
                    f'<a class="wikilink ambiguous" data-path="{escape(candidates[0])}" '
                    f'title="⚠ 同名ノートが{len(candidates)}件: {escape(others)} — [[フォルダ名/ノート名]] で指定してください">{label}</a>'
                )
            return f'<a class="wikilink" data-path="{escape(candidates[0])}">{label}</a>'

        body = _sub_outside_code(note.body, sub_wikilink)
        html = self.md.render(body)
        return {
            "path": note.rel_path,
            "title": note.title,
            "icon": note.icon,
            "tags": note.tags,
            "folder": note.folder,
            "updated": note.updated.strftime("%Y-%m-%d %H:%M"),
            "created": note.created.strftime("%Y-%m-%d %H:%M"),
            "html": html,
            "backlinks": [
                {"path": b.rel_path, "title": b.title, "icon": b.icon, "summary": b.summary()}
                for b in self.backlinks(rel)
            ],
        }

    # ---------- 一覧・ツリー ----------

    def tree(self) -> dict:
        root: dict = {"folders": {}, "notes": []}
        # 実ディレクトリを先に登録する(ノートが1つもない空フォルダも見えるように)
        for p in sorted(self.root.rglob("*")):
            if not p.is_dir():
                continue
            rel_parts = p.relative_to(self.root).parts
            if any(part.startswith(".") for part in rel_parts):
                continue
            node = root
            for part in rel_parts:
                node = node["folders"].setdefault(part, {"folders": {}, "notes": []})
        for note in sorted(self.notes.values(), key=lambda n: n.title.lower()):
            node = root
            for part in Path(note.rel_path).parts[:-1]:
                node = node["folders"].setdefault(part, {"folders": {}, "notes": []})
            node["notes"].append({"path": note.rel_path, "title": note.title, "icon": note.icon})
        return root

    def all_tags(self) -> list[dict]:
        counts: dict[str, int] = {}
        for note in self.notes.values():
            for t in note.tags:
                counts[t] = counts.get(t, 0) + 1
        colors = self.tag_colors()
        return [
            {"tag": t, "count": c, "color": colors.get(t)}
            for t, c in sorted(counts.items(), key=lambda x: (-x[1], x[0]))
        ]

    # ---------- タグの色 ----------
    # 色はノート個別ではなく Vault 全体の属性なので、frontmatter ではなく
    # vault/.mdlaunch/tags.json に {"colors": {"タグ名": "色名"}} で持つ

    def _tags_meta_path(self) -> Path:
        return self.root / ".mdlaunch" / "tags.json"

    def tag_colors(self) -> dict[str, str]:
        try:
            data = json.loads(self._tags_meta_path().read_text(encoding="utf-8"))
            colors = data.get("colors", {})
            return {str(t): str(c) for t, c in colors.items() if c in TAG_COLOR_NAMES}
        except (OSError, ValueError, AttributeError):
            return {}

    def set_tag_color(self, tag: str, color: str | None) -> None:
        tag = tag.strip()
        if not tag:
            raise ValueError("empty tag")
        if color and color not in TAG_COLOR_NAMES:
            raise ValueError(f"unknown color: {color}")
        colors = self.tag_colors()
        if color:
            colors[tag] = color
        else:
            colors.pop(tag, None)
        path = self._tags_meta_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"colors": colors}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # ---------- 作成・VSCode 連携 ----------

    def create_note(self, title: str, folder: str = "", tags: list[str] | None = None) -> str:
        safe = re.sub(r'[\\/:*?"<>|]', "-", title).strip() or "Untitled"
        target_dir = (self.root / folder).resolve() if folder else self.root
        if not target_dir.is_relative_to(self.root):
            raise ValueError("folder is outside the vault")
        target_dir.mkdir(parents=True, exist_ok=True)
        path = target_dir / f"{safe}.md"
        n = 1
        while path.exists():
            n += 1
            path = target_dir / f"{safe} {n}.md"
        tag_line = "[" + ", ".join(tags) + "]" if tags else "[]"
        path.write_text(
            f"---\ntitle: {title}\nicon: 📄\ntags: {tag_line}\n---\n\n",
            encoding="utf-8",
        )
        self.refresh()
        return path.relative_to(self.root).as_posix()

    def create_folder(self, folder: str) -> str:
        target = (self.root / folder.strip()).resolve()
        if not folder.strip() or not target.is_relative_to(self.root) or target == self.root:
            raise ValueError("invalid folder")
        target.mkdir(parents=True, exist_ok=True)
        return target.relative_to(self.root).as_posix()

    def update_meta(self, rel: str, title: str | None = None, tags: list[str] | None = None) -> None:
        """frontmatter の title / tags だけを書き換える(本文・他のキーは保持)"""
        if rel not in self.notes:
            raise KeyError(rel)
        path = self.root / rel
        post = frontmatter.load(path)
        if title is not None:
            post.metadata["title"] = title
        if tags is not None:
            post.metadata["tags"] = tags
        # 既定の CSafeDumper (libyaml) は絵文字など非BMP文字を \U エスケープしてしまうため、
        # 純 Python の SafeDumper を明示して人間が読める frontmatter を保つ
        frontmatter.dump(post, path, encoding="utf-8", allow_unicode=True, Dumper=yaml.SafeDumper)
        self._mtimes.pop(rel, None)
        self.refresh()

    def move_note(self, rel: str, folder: str = "") -> str:
        """ノートを別フォルダへ移動する。戻り値は新しい rel_path"""
        if rel not in self.notes:
            raise KeyError(rel)
        src = (self.root / rel).resolve()
        if folder.strip():
            target_dir = (self.root / folder.strip()).resolve()
            if not target_dir.is_relative_to(self.root):
                raise ValueError("folder is outside the vault")
        else:
            target_dir = self.root
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / src.name
        n = 1
        while dest.exists() and dest != src:
            n += 1
            dest = target_dir / f"{src.stem} {n}.md"
        if dest != src:
            shutil.move(str(src), str(dest))
            self.notes.pop(rel, None)
            self._mtimes.pop(rel, None)
        self.refresh()
        return dest.relative_to(self.root).as_posix()

    def rename_folder(self, folder: str, new_name: str) -> str:
        """フォルダの名前を変更する(場所は変えない)。戻り値は新しいフォルダの rel パス"""
        src = (self.root / folder.strip()).resolve()
        if (
            not folder.strip()
            or not src.is_relative_to(self.root)
            or src == self.root
            or not src.is_dir()
        ):
            raise ValueError("invalid folder")
        new_name = new_name.strip()
        if not new_name or re.search(r'[\\/:*?"<>|]', new_name):
            raise ValueError("invalid name")
        dest = src.parent / new_name
        if dest == src:
            return src.relative_to(self.root).as_posix()
        if dest.exists():
            raise ValueError("already exists")
        src.rename(dest)
        self.refresh()
        return dest.relative_to(self.root).as_posix()

    def open_in_vscode(self, rel: str) -> None:
        path = (self.root / rel).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("path outside vault")
        code = shutil.which("code")
        if code:
            subprocess.Popen([code, "-g", str(path)])
        else:
            # code コマンドが無ければ .md の既定アプリで開く
            os.startfile(path)
