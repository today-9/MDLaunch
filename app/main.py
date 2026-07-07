"""MDLaunch — Notion ライクな Markdown ビューワー/ランチャー"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import urllib.parse
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .vault import Vault

VAULT_DIR = Path(os.environ.get("MDLAUNCH_VAULT", Path(__file__).parent.parent / "vault"))
STATIC_DIR = Path(__file__).parent / "static"
PORT = os.environ.get("MDLAUNCH_PORT", "8321")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # ランチャー経由(MDLAUNCH_OPEN=1)なら、起動完了後にブラウザを開く
    if os.environ.get("MDLAUNCH_OPEN") == "1":
        threading.Timer(0.3, webbrowser.open, args=(f"http://127.0.0.1:{PORT}",)).start()
    yield


app = FastAPI(title="MDLaunch", lifespan=lifespan)
vault = Vault(VAULT_DIR)


class NewNote(BaseModel):
    title: str
    folder: str = ""
    tags: list[str] = []


@app.get("/api/tree")
def get_tree():
    vault.refresh()
    return {"tree": vault.tree(), "tags": vault.all_tags(), "count": len(vault.notes)}


@app.get("/api/search")
def search(q: str = "", tag: str | None = None):
    vault.refresh()
    return {"results": vault.search(q, tag)}


@app.get("/api/note")
def get_note(path: str):
    vault.refresh()
    try:
        return vault.render(path)
    except KeyError:
        raise HTTPException(404, f"note not found: {path}")


@app.post("/api/new")
def new_note(req: NewNote):
    rel = vault.create_note(req.title, req.folder, req.tags)
    vault.open_in_vscode(rel)
    return {"path": rel}


@app.post("/api/open")
def open_note(path: str):
    vault.refresh()
    if path not in vault.notes:
        raise HTTPException(404, f"note not found: {path}")
    vault.open_in_vscode(path)
    return {"ok": True}


@app.get("/api/themes")
def get_themes():
    """static/themes/ の viewer-*.css / pdf-*.css を列挙する。

    先頭行の `/* name: 表示名 */` をラベルとして使う。
    """
    result: dict[str, list[dict]] = {"viewer": [], "pdf": []}
    themes_dir = STATIC_DIR / "themes"
    for f in sorted(themes_dir.glob("*.css")):
        kind, _, theme_id = f.stem.partition("-")
        if kind not in result or not theme_id:
            continue
        first_line = f.read_text(encoding="utf-8").split("\n", 1)[0]
        m = re.search(r"name:\s*(.+?)\s*\*/", first_line)
        result[kind].append({"id": theme_id, "label": m.group(1) if m else theme_id})
    return result


def _find_browser() -> str | None:
    for name in ("msedge", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    candidates = [
        rf"{pf86}\Microsoft\Edge\Application\msedge.exe",
        rf"{pf}\Microsoft\Edge\Application\msedge.exe",
        rf"{pf}\Google\Chrome\Application\chrome.exe",
        rf"{pf86}\Google\Chrome\Application\chrome.exe",
    ]
    return next((c for c in candidates if Path(c).exists()), None)


@app.get("/api/pdf")
def export_pdf(path: str, theme: str = "standard"):
    vault.refresh()
    note = vault.notes.get(path)
    if note is None:
        raise HTTPException(404, f"note not found: {path}")
    browser = _find_browser()
    if browser is None:
        raise HTTPException(501, "Edge/Chrome が見つからないためサーバー側 PDF 生成は使えません")
    if not (STATIC_DIR / "themes" / f"pdf-{theme}.css").is_file():
        theme = "standard"

    url = (
        f"http://127.0.0.1:{PORT}/?pdftheme={urllib.parse.quote(theme)}"
        f"#{urllib.parse.quote(path, safe='')}"
    )
    tmpdir = Path(tempfile.mkdtemp(prefix="mdlaunch_pdf_"))
    out = tmpdir / "out.pdf"
    profile = Path(tempfile.gettempdir()) / "mdlaunch_pdf_profile"
    # ヘッドレス起動は稀に空振りするのでリトライする
    for _ in range(3):
        subprocess.run(
            [
                browser, "--headless", "--disable-gpu",
                f"--user-data-dir={profile}",
                f"--print-to-pdf={out}",
                "--no-pdf-header-footer",
                "--virtual-time-budget=10000",
                url,
            ],
            capture_output=True, timeout=60,
        )
        if out.exists() and out.stat().st_size > 0:
            break
    if not (out.exists() and out.stat().st_size > 0):
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise HTTPException(500, "PDF 生成に失敗しました")
    return FileResponse(
        out,
        media_type="application/pdf",
        filename=f"{note.title}.pdf",
        background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
    )


@app.post("/api/shutdown")
def shutdown():
    # レスポンスを返してからプロセスを終了する
    threading.Timer(0.5, os._exit, args=(0,)).start()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
