/* MDLaunch フロントエンド */
"use strict";

const $ = (sel) => document.querySelector(sel);
const contentEl = $("#content");
const breadcrumbEl = $("#breadcrumb");
const editBtn = $("#edit-btn");
const pdfBtn = $("#pdf-btn");

let currentPath = null;
let currentTag = null;
let currentUpdated = null;

mermaid.initialize({ startOnLoad: false, theme: "neutral" });

/* ---------- API ---------- */
function setOffline(offline) {
  $("#offline-banner").hidden = !offline;
}

async function fetchJSON(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    setOffline(true);
    e.offline = true;
    throw e;
  }
  setOffline(false);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const api = {
  tree: () => fetchJSON("/api/tree"),
  search: (q, tag) => {
    const p = new URLSearchParams({ q });
    if (tag) p.set("tag", tag);
    return fetchJSON(`/api/search?${p}`);
  },
  note: (path) => fetchJSON(`/api/note?path=${encodeURIComponent(path)}`),
  create: (body) => fetchJSON("/api/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  open: (path) => fetchJSON(`/api/open?path=${encodeURIComponent(path)}`, { method: "POST" }),
  shutdown: () => fetchJSON("/api/shutdown", { method: "POST" }),
  themes: () => fetchJSON("/api/themes"),
};

/* ---------- テーマ ---------- */
function setThemeLink(kind, id) {
  $(`#${kind}-theme-css`).href = `/static/themes/${kind}-${id}.css`;
}

async function initThemes() {
  // PDF 生成用ヘッドレス起動時は ?pdftheme= が最優先(localStorage が無い環境で使われる)
  const urlPdfTheme = new URLSearchParams(location.search).get("pdftheme");
  const themes = await api.themes();
  const defs = [["viewer", themes.viewer, "light"], ["pdf", themes.pdf, "standard"]];
  for (const [kind, list, fallback] of defs) {
    const sel = $(`#${kind}-theme-sel`);
    sel.innerHTML = "";
    for (const t of list) {
      const opt = el("option", "", t.label);
      opt.value = t.id;
      sel.appendChild(opt);
    }
    let active = localStorage.getItem(`mdlaunch-${kind}-theme`) || fallback;
    if (kind === "pdf" && urlPdfTheme) active = urlPdfTheme;
    if (![...sel.options].some((o) => o.value === active)) active = fallback;
    sel.value = active;
    setThemeLink(kind, active);
    sel.addEventListener("change", () => {
      setThemeLink(kind, sel.value);
      localStorage.setItem(`mdlaunch-${kind}-theme`, sel.value);
    });
  }
}

/* ---------- ユーティリティ ---------- */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function addCopyButton(target, getText) {
  const wrap = el("div", "copy-wrap");
  target.parentNode.insertBefore(wrap, target);
  wrap.appendChild(target);
  const btn = el("button", "copy-btn", "コピー");
  btn.addEventListener("click", async () => {
    btn.textContent = (await copyText(getText())) ? "✓ コピーしました" : "✗ 失敗";
    setTimeout(() => (btn.textContent = "コピー"), 1500);
  });
  wrap.appendChild(btn);
}

function fmtDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  if (days < 7) return `${days + 1}日前`;
  return d.toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
}

/* ---------- サイドバー ---------- */
async function refreshSidebar() {
  const data = await api.tree();
  renderTree(data.tree);
  renderTags(data.tags);
  $("#note-count").textContent = `${data.count} ノート`;
}

function renderTree(tree) {
  const container = $("#tree");
  container.innerHTML = "";
  container.appendChild(buildTreeChildren(tree));
  markCurrentInTree();
}

function buildTreeChildren(node) {
  const frag = document.createDocumentFragment();
  for (const [name, child] of Object.entries(node.folders)) {
    const folder = el("div", "tree-folder open");
    const head = el("div", "tree-folder-name");
    head.appendChild(el("span", "chev", "▶"));
    head.appendChild(el("span", "", "📁 " + name));
    head.addEventListener("click", () => folder.classList.toggle("open"));
    folder.appendChild(head);
    const children = el("div", "tree-children");
    children.appendChild(buildTreeChildren(child));
    folder.appendChild(children);
    frag.appendChild(folder);
  }
  for (const note of node.notes) {
    const btn = el("button", "tree-note");
    btn.dataset.path = note.path;
    btn.appendChild(el("span", "", note.icon));
    btn.appendChild(el("span", "t", note.title));
    btn.addEventListener("click", () => showNote(note.path));
    frag.appendChild(btn);
  }
  return frag;
}

function markCurrentInTree() {
  document.querySelectorAll(".tree-note").forEach((b) => {
    b.classList.toggle("current", b.dataset.path === currentPath);
  });
  document.querySelectorAll(".tag-item").forEach((b) => {
    b.classList.toggle("current", b.dataset.tag === currentTag && currentPath === null);
  });
}

function renderTags(tags) {
  const container = $("#tag-list");
  container.innerHTML = "";
  if (!tags.length) {
    container.appendChild(el("div", "side-footer", "タグはまだありません"));
    return;
  }
  for (const t of tags) {
    const btn = el("button", "tag-item");
    btn.dataset.tag = t.tag;
    btn.appendChild(el("span", "", "🏷️ " + t.tag));
    btn.appendChild(el("span", "cnt", String(t.count)));
    btn.addEventListener("click", () => showHome(t.tag));
    container.appendChild(btn);
  }
  markCurrentInTree();
}

/* ---------- ホーム(一覧) ---------- */
async function showHome(tag = null) {
  currentPath = null;
  currentTag = tag;
  if (location.hash) history.replaceState(null, "", location.pathname);
  editBtn.hidden = true;
  pdfBtn.hidden = true;
  breadcrumbEl.textContent = tag ? `🏷️ ${tag}` : "🏠 ホーム";
  let results;
  try {
    ({ results } = await api.search("", tag));
  } catch {
    return;
  }
  contentEl.innerHTML = "";

  contentEl.appendChild(el("div", "home-title", tag ? `🏷️ ${tag}` : "すべてのノート"));

  if (!results.length) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "big", "🗂️"));
    empty.appendChild(el("div", "", "ノートがありません。「＋ 新規ノート」から作成しましょう。"));
    contentEl.appendChild(empty);
    markCurrentInTree();
    return;
  }

  contentEl.appendChild(el("div", "home-section-label", "更新順"));
  const sorted = [...results].sort((a, b) => b.updated.localeCompare(a.updated));
  for (const n of sorted) {
    const card = el("button", "note-card");
    card.appendChild(el("span", "nc-icon", n.icon));
    card.appendChild(el("span", "nc-title", n.title));
    card.appendChild(el("span", "nc-summary", n.summary));
    card.appendChild(el("span", "nc-date", fmtDate(n.updated)));
    card.addEventListener("click", () => showNote(n.path));
    contentEl.appendChild(card);
  }
  markCurrentInTree();
}

/* ---------- ノート表示 ---------- */
async function showNote(path) {
  let note;
  try {
    note = await api.note(path);
  } catch (e) {
    // サーバー停止中は現在の画面を維持(バナーで通知済み)。404 のときだけホームへ
    if (!e.offline) showHome();
    return;
  }
  currentPath = path;
  currentTag = null;
  currentUpdated = note.updated;
  editBtn.hidden = false;
  pdfBtn.hidden = false;
  if (decodeURIComponent(location.hash.slice(1)) !== path) {
    location.hash = encodeURIComponent(path);
  }

  breadcrumbEl.innerHTML = "";
  const parts = note.folder ? note.folder.split("/") : [];
  const home = el("span", "", "🏠");
  home.style.cursor = "pointer";
  home.addEventListener("click", () => showHome());
  breadcrumbEl.appendChild(home);
  for (const p of parts) {
    breadcrumbEl.appendChild(el("span", "sep", "/"));
    breadcrumbEl.appendChild(el("span", "", p));
  }
  breadcrumbEl.appendChild(el("span", "sep", "/"));
  breadcrumbEl.appendChild(el("span", "", `${note.icon} ${note.title}`));

  contentEl.innerHTML = "";
  contentEl.appendChild(el("div", "page-icon", note.icon));
  contentEl.appendChild(el("div", "page-title", note.title));

  const meta = el("div", "page-meta");
  for (const t of note.tags) {
    const pill = el("span", "pill", t);
    pill.addEventListener("click", () => showHome(t));
    meta.appendChild(pill);
  }
  meta.appendChild(el("span", "", `更新: ${note.updated}`));
  contentEl.appendChild(meta);

  const md = el("div", "md");
  md.innerHTML = note.html;
  contentEl.appendChild(md);

  // Wikiリンク
  md.querySelectorAll(".wikilink[data-path]").forEach((a) => {
    a.addEventListener("click", () => showNote(a.dataset.path));
  });
  // チェックボックスは表示専用
  md.querySelectorAll("input[type=checkbox]").forEach((c) => (c.disabled = true));
  // 外部リンクは新しいタブで
  md.querySelectorAll('a[href^="http"]').forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
  });

  // 数式 (KaTeX) — TeX ソースを控えてからレンダリング
  md.querySelectorAll(".math").forEach((m) => {
    const tex = m.textContent.trim();
    const displayMode = m.classList.contains("block");
    try {
      katex.render(tex, m, { displayMode, throwOnError: false });
    } catch (e) { console.warn(e); }
    if (displayMode) {
      addCopyButton(m, () => tex);
    } else {
      m.title = "クリックで TeX をコピー";
      m.classList.add("copyable");
      m.addEventListener("click", async () => {
        if (await copyText(tex)) toast("TeX をコピーしました");
      });
    }
  });

  // コードブロックにコピーボタン(Mermaid は図になるので除外)
  md.querySelectorAll("pre").forEach((pre) => {
    if (pre.classList.contains("mermaid")) return;
    addCopyButton(pre, () => pre.textContent.replace(/\n$/, ""));
  });

  // Mermaid
  const mermaids = md.querySelectorAll("pre.mermaid");
  if (mermaids.length) {
    try { await mermaid.run({ nodes: mermaids }); } catch (e) { console.warn(e); }
  }

  // バックリンク
  if (note.backlinks.length) {
    const bl = el("div", "backlinks");
    bl.appendChild(el("div", "backlinks-label", `↩ ${note.backlinks.length} 件のバックリンク`));
    for (const b of note.backlinks) {
      const card = el("button", "backlink-card");
      card.appendChild(el("div", "bl-title", `${b.icon} ${b.title}`));
      card.appendChild(el("div", "bl-summary", b.summary));
      card.addEventListener("click", () => showNote(b.path));
      bl.appendChild(card);
    }
    contentEl.appendChild(bl);
  }

  contentEl.scrollIntoView();
  $("#main").scrollTop = 0;
  markCurrentInTree();
}

editBtn.addEventListener("click", () => {
  if (currentPath) api.open(currentPath);
});

pdfBtn.addEventListener("click", async () => {
  if (!currentPath) return;
  const title = document.querySelector(".page-title")?.textContent || "note";
  pdfBtn.disabled = true;
  pdfBtn.textContent = "生成中…";
  try {
    const theme = localStorage.getItem("mdlaunch-pdf-theme") || "standard";
    const r = await fetch(`/api/pdf?path=${encodeURIComponent(currentPath)}&theme=${encodeURIComponent(theme)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title}.pdf`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("PDF を保存しました");
  } catch {
    // サーバー側生成が使えない環境では印刷ダイアログにフォールバック
    const prev = document.title;
    document.title = title;
    window.print();
    document.title = prev;
  } finally {
    pdfBtn.disabled = false;
    pdfBtn.textContent = "PDF に保存";
  }
});

/* ---------- 検索パレット ---------- */
const paletteOverlay = $("#palette-overlay");
const paletteInput = $("#palette-input");
const paletteResults = $("#palette-results");
let paletteItems = [];
let paletteSel = 0;
let searchTimer = null;

function openPalette() {
  paletteOverlay.hidden = false;
  paletteInput.value = "";
  paletteInput.focus();
  runSearch("");
}
function closePalette() {
  paletteOverlay.hidden = true;
}

async function runSearch(q) {
  const { results } = await api.search(q);
  paletteItems = results;
  paletteSel = 0;
  paletteResults.innerHTML = "";
  if (!results.length) {
    paletteResults.appendChild(el("div", "palette-empty", "見つかりませんでした"));
    return;
  }
  results.forEach((n, i) => {
    const item = el("button", "palette-item" + (i === 0 ? " selected" : ""));
    item.appendChild(el("span", "", n.icon));
    item.appendChild(el("span", "pi-title", n.title));
    item.appendChild(el("span", "pi-summary", n.summary));
    item.addEventListener("click", () => { closePalette(); showNote(n.path); });
    paletteResults.appendChild(item);
  });
}

function movePaletteSel(delta) {
  const items = paletteResults.querySelectorAll(".palette-item");
  if (!items.length) return;
  paletteSel = (paletteSel + delta + items.length) % items.length;
  items.forEach((it, i) => it.classList.toggle("selected", i === paletteSel));
  items[paletteSel].scrollIntoView({ block: "nearest" });
}

paletteInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(paletteInput.value), 120);
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); movePaletteSel(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); movePaletteSel(-1); }
  else if (e.key === "Enter" && paletteItems[paletteSel]) {
    closePalette();
    showNote(paletteItems[paletteSel].path);
  } else if (e.key === "Escape") closePalette();
});
paletteOverlay.addEventListener("click", (e) => {
  if (e.target === paletteOverlay) closePalette();
});

/* ---------- 新規ノート ---------- */
const newOverlay = $("#new-overlay");

function openNewDialog() {
  newOverlay.hidden = false;
  $("#new-title").value = "";
  $("#new-folder").value = "";
  $("#new-tags").value = "";
  $("#new-title").focus();
}
function closeNewDialog() { newOverlay.hidden = true; }

async function createNote() {
  const title = $("#new-title").value.trim();
  if (!title) { $("#new-title").focus(); return; }
  const folder = $("#new-folder").value.trim();
  const tags = $("#new-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
  try {
    const { path } = await api.create({ title, folder, tags });
    closeNewDialog();
    await refreshSidebar();
    showNote(path);
  } catch { /* オフライン時はバナー表示のみ */ }
}

$("#new-cancel").addEventListener("click", closeNewDialog);
$("#new-create").addEventListener("click", createNote);
newOverlay.addEventListener("click", (e) => { if (e.target === newOverlay) closeNewDialog(); });
newOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") createNote();
  if (e.key === "Escape") closeNewDialog();
});

/* ---------- グローバル ---------- */
$("#search-btn").addEventListener("click", openPalette);
$("#home-btn").addEventListener("click", () => showHome());
$("#new-btn").addEventListener("click", openNewDialog);
$("#quit-btn").addEventListener("click", async () => {
  if (!confirm("MDLaunch サーバーを終了しますか?")) return;
  try { await api.shutdown(); } catch { /* すでに停止 */ }
  document.body.innerHTML =
    '<div class="farewell">🗂️ MDLaunch を終了しました。<br>このタブは閉じてOKです。また使うときは MDLaunch.vbs をダブルクリック。</div>';
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    paletteOverlay.hidden ? openPalette() : closePalette();
  }
  if (e.key === "Escape" && !paletteOverlay.hidden) closePalette();
});

/* 定期リフレッシュ(VSCode 側の編集を拾って再描画。サーバー死活監視も兼ねる) */
setInterval(async () => {
  try {
    await refreshSidebar();
    if (currentPath) {
      const note = await api.note(currentPath);
      if (note.updated !== currentUpdated) {
        const scroll = $("#main").scrollTop;
        await showNote(currentPath);
        $("#main").scrollTop = scroll;
      }
    }
  } catch { /* オフライン時はバナー表示のみ */ }
}, 5000);

window.addEventListener("hashchange", () => {
  const path = decodeURIComponent(location.hash.slice(1));
  if (path && path !== currentPath) showNote(path);
  else if (!path && currentPath) showHome();
});

/* 初期化 */
(async () => {
  try { await initThemes(); } catch { /* テーマは既定のまま */ }
  try { await refreshSidebar(); } catch { /* バナー表示済み */ }
  const path = decodeURIComponent(location.hash.slice(1));
  path ? showNote(path) : showHome();
})();
