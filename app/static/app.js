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
let allTags = [];      // [{tag, count, color}] — サイドバー更新時に反映
let tagColors = {};    // タグ名 → 色名

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
  search: (q, tags) => {
    const p = new URLSearchParams({ q });
    for (const t of tags || []) p.append("tag", t);
    return fetchJSON(`/api/search?${p}`);
  },
  note: (path) => fetchJSON(`/api/note?path=${encodeURIComponent(path)}`),
  create: (body) => fetchJSON("/api/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  open: (path) => fetchJSON(`/api/open?path=${encodeURIComponent(path)}`, { method: "POST" }),
  newFolder: (folder) => fetchJSON("/api/newfolder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder }),
  }),
  renameFolder: (folder, name) => fetchJSON("/api/rename-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder, name }),
  }),
  updateMeta: (path, fields) => fetchJSON("/api/update-meta", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...fields }),
  }),
  move: (path, folder) => fetchJSON("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, folder }),
  }),
  setTagColor: (tag, color) => fetchJSON("/api/tag-color", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag, color }),
  }),
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
  allTags = data.tags;
  tagColors = {};
  for (const t of data.tags) if (t.color) tagColors[t.tag] = t.color;
  renderTree(data.tree);
  renderTags(data.tags);
  $("#note-count").textContent = `${data.count} ノート`;
  $("#stale-banner").hidden = !data.stale;
}

let treeRootDropReady = false;

function renderTree(tree) {
  const container = $("#tree");
  container.innerHTML = "";
  allFolders = [];
  container.appendChild(buildTreeChildren(tree));
  if (!treeRootDropReady) {
    makeDropTarget(container, "");   // ツリーの余白へドロップ = ルートへ移動
    treeRootDropReady = true;
  }
  markCurrentInTree();
  paintSelection();
}

let allFolders = [];

/* ---------- ツリーの複数選択 ---------- */
const selectedPaths = new Set();
let selectionAnchor = null;

function paintSelection() {
  document.querySelectorAll(".tree-note").forEach((r) => {
    r.classList.toggle("selected", selectedPaths.has(r.dataset.path));
  });
}

function clearSelection() {
  selectedPaths.clear();
  selectionAnchor = null;
  paintSelection();
}

function treeNoteRows() {
  return [...document.querySelectorAll("#tree .tree-note")];
}

function handleTreeClick(e, path) {
  if (e.ctrlKey || e.metaKey) {
    if (selectedPaths.has(path)) selectedPaths.delete(path);
    else selectedPaths.add(path);
    selectionAnchor = path;
    paintSelection();
    return;
  }
  if (e.shiftKey && selectionAnchor) {
    const rows = treeNoteRows().map((r) => r.dataset.path);
    const a = rows.indexOf(selectionAnchor);
    const b = rows.indexOf(path);
    if (a !== -1 && b !== -1) {
      selectedPaths.clear();
      for (const p of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) selectedPaths.add(p);
      paintSelection();
      return;
    }
  }
  clearSelection();
  showNote(path);
}

/* ---------- ドラッグ&ドロップ移動 ---------- */
async function movePathsTo(paths, folder) {
  let moved = 0;
  let currentNew = null;
  for (const p of paths) {
    try {
      const res = await api.move(p, folder);
      if (res.path !== p) moved++;
      if (currentPath === p) currentNew = res.path;
    } catch { /* 個別失敗はスキップ */ }
  }
  clearSelection();
  toast(moved ? `${moved} 件を「${folder || "ルート"}」へ移動しました` : "移動はありませんでした");
  await refreshSidebar();
  if (currentNew && currentNew !== currentPath) showNote(currentNew);
}

function makeDropTarget(elem, folderPath) {
  elem.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    elem.classList.add("drop-target");
  });
  elem.addEventListener("dragleave", () => elem.classList.remove("drop-target"));
  elem.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    elem.classList.remove("drop-target");
    if (selectedPaths.size) movePathsTo([...selectedPaths], folderPath);
  });
}

function buildTreeChildren(node, prefix = "") {
  const frag = document.createDocumentFragment();
  for (const [name, child] of Object.entries(node.folders)) {
    const folderPath = prefix ? `${prefix}/${name}` : name;
    allFolders.push(folderPath);
    const folder = el("div", "tree-folder open");
    const head = el("div", "tree-folder-name");
    head.appendChild(el("span", "chev", "▶"));
    head.appendChild(el("span", "", "📁 " + name));
    const fmore = el("button", "note-more", "⋯");
    fmore.title = "メニュー";
    fmore.addEventListener("click", (e) => openFolderMenu(e, folderPath));
    head.appendChild(fmore);
    head.addEventListener("click", () => folder.classList.toggle("open"));
    head.addEventListener("contextmenu", (e) => openFolderMenu(e, folderPath));
    makeDropTarget(head, folderPath);
    folder.appendChild(head);
    const children = el("div", "tree-children");
    children.appendChild(buildTreeChildren(child, folderPath));
    folder.appendChild(children);
    frag.appendChild(folder);
  }
  for (const note of node.notes) {
    const row = el("div", "tree-note");
    row.dataset.path = note.path;
    row.draggable = true;
    row.appendChild(el("span", "", note.icon));
    row.appendChild(el("span", "t", note.title));
    const more = el("button", "note-more", "⋯");
    more.title = "メニュー";
    more.addEventListener("click", (e) => openNoteMenu(e, note.path));
    row.appendChild(more);
    row.addEventListener("click", (e) => handleTreeClick(e, note.path));
    row.addEventListener("contextmenu", (e) => openNoteMenu(e, note.path));
    row.addEventListener("dragstart", (e) => {
      // 未選択のノートを掴んだら、それを単独選択として扱う
      if (!selectedPaths.has(note.path)) {
        selectedPaths.clear();
        selectedPaths.add(note.path);
        selectionAnchor = note.path;
        paintSelection();
      }
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", [...selectedPaths].join("\n"));
    });
    frag.appendChild(row);
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

const TAG_LIMIT = 8;
let showAllTags = false;

function renderTags(tags) {
  const container = $("#tag-list");
  container.innerHTML = "";
  if (!tags.length) {
    container.appendChild(el("div", "side-footer", "タグはまだありません"));
    return;
  }
  const visible = showAllTags ? tags : tags.slice(0, TAG_LIMIT);
  for (const t of visible) {
    const btn = el("button", "tag-item");
    btn.dataset.tag = t.tag;
    const dot = el("span", "tag-dot");
    if (t.color) dot.dataset.tc = t.color;
    btn.appendChild(dot);
    btn.appendChild(el("span", "t", t.tag));
    btn.appendChild(el("span", "cnt", String(t.count)));
    btn.addEventListener("click", () => showHome(t.tag));
    btn.addEventListener("contextmenu", (e) => openTagColorPop(e, t.tag));
    container.appendChild(btn);
  }
  if (tags.length > TAG_LIMIT) {
    const toggle = el("button", "tag-item tag-toggle",
      showAllTags ? "− 折りたたむ" : `＋ あと ${tags.length - TAG_LIMIT} 件を表示`);
    toggle.addEventListener("click", () => {
      showAllTags = !showAllTags;
      renderTags(tags);
    });
    container.appendChild(toggle);
  }
  markCurrentInTree();
}

/* ---------- タグの色 ---------- */
const TAG_PALETTE = [
  { id: null, label: "なし" },
  { id: "gray", label: "グレー" },
  { id: "brown", label: "ブラウン" },
  { id: "orange", label: "オレンジ" },
  { id: "yellow", label: "イエロー" },
  { id: "green", label: "グリーン" },
  { id: "teal", label: "ティール" },
  { id: "blue", label: "ブルー" },
  { id: "indigo", label: "インディゴ" },
  { id: "purple", label: "パープル" },
  { id: "pink", label: "ピンク" },
  { id: "red", label: "レッド" },
];

const tagColorPop = $("#tag-color-pop");

function openTagColorPop(e, tag) {
  e.preventDefault();
  e.stopPropagation();
  tagColorPop.querySelector(".tcp-title").textContent = `「${tag}」の色`;
  const grid = tagColorPop.querySelector(".tcp-grid");
  grid.innerHTML = "";
  const current = tagColors[tag] || null;
  for (const c of TAG_PALETTE) {
    const b = el("button", "tcp-swatch" + (current === c.id ? " current" : ""), c.id ? "あ" : "−");
    if (c.id) b.dataset.tc = c.id;
    b.title = c.label;
    b.addEventListener("click", async () => {
      tagColorPop.hidden = true;
      try {
        await api.setTagColor(tag, c.id);
        await refreshSidebar();
        // 表示中ノートのピルにも即反映(再読み込みせず data 属性だけ更新)
        document.querySelectorAll(".page-meta .pill[data-tag]").forEach((p) => {
          const col = tagColors[p.dataset.tag];
          if (col) p.dataset.tc = col;
          else delete p.dataset.tc;
        });
      } catch {
        toast("色を変更できませんでした");
      }
    });
    grid.appendChild(b);
  }
  tagColorPop.hidden = false;
  const w = tagColorPop.offsetWidth || 190;
  const h = tagColorPop.offsetHeight || 160;
  tagColorPop.style.left = Math.min(e.clientX, window.innerWidth - w - 10) + "px";
  tagColorPop.style.top = Math.min(e.clientY, window.innerHeight - h - 10) + "px";
}

document.addEventListener("click", (e) => {
  if (!tagColorPop.hidden && !tagColorPop.contains(e.target)) tagColorPop.hidden = true;
});

/* ---------- タグ入力ピッカー(チップ式) ---------- */
function createTagPicker(root, initial = []) {
  root.innerHTML = "";
  const selected = [...initial];
  const box = el("div", "tp-box");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "タグ名を入力して Enter";
  input.autocomplete = "off";
  const avail = el("div", "tp-avail");

  function add(tag) {
    tag = tag.trim();
    if (tag && !selected.includes(tag)) selected.push(tag);
    input.value = "";
    render();
  }

  function chip(tag) {
    const c = el("span", "pill tp-chip", tag);
    if (tagColors[tag]) c.dataset.tc = tagColors[tag];
    const x = el("button", "tp-x", "×");
    x.title = "外す";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      selected.splice(selected.indexOf(tag), 1);
      render();
      input.focus();
    });
    c.appendChild(x);
    return c;
  }

  function renderAvail() {
    avail.innerHTML = "";
    const q = input.value.trim().toLowerCase();
    const items = allTags.filter(
      (t) => !selected.includes(t.tag) && (!q || t.tag.toLowerCase().includes(q))
    );
    if (!items.length) {
      avail.appendChild(el("span", "tp-empty",
        q ? `Enter で新しいタグ「${input.value.trim()}」を追加`
          : (allTags.length ? "既存のタグはすべて選択済みです" : "既存のタグはまだありません")));
      return;
    }
    for (const t of items) {
      const b = el("button", "pill", t.tag);
      b.type = "button";
      if (t.color) b.dataset.tc = t.color;
      b.appendChild(el("span", "tp-cnt", String(t.count)));
      b.addEventListener("click", () => { add(t.tag); input.focus(); });
      avail.appendChild(b);
    }
  }

  function render() {
    box.querySelectorAll(".tp-chip").forEach((c) => c.remove());
    for (const t of selected) box.insertBefore(chip(t), input);
    renderAvail();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      // 入力中の Enter はタグ追加。空のときだけダイアログ側の Enter(作成/保存)に渡す
      e.preventDefault();
      e.stopPropagation();
      add(input.value);
    } else if (e.key === "Backspace" && !input.value && selected.length) {
      selected.pop();
      render();
    }
  });
  input.addEventListener("input", () => {
    // カンマ・読点区切りの入力や貼り付けにも対応
    if (/[,、]/.test(input.value)) {
      const parts = input.value.split(/[,、]/);
      const rest = parts.pop();
      for (const p of parts) if (p.trim() && !selected.includes(p.trim())) selected.push(p.trim());
      input.value = rest;
      render();
    } else {
      renderAvail();
    }
  });
  input.addEventListener("focus", () => root.classList.add("focused"));
  input.addEventListener("blur", () => root.classList.remove("focused"));
  box.addEventListener("click", () => input.focus());

  box.appendChild(input);
  root.appendChild(box);
  root.appendChild(avail);
  render();
  return { get: () => [...selected], focus: () => input.focus() };
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
    ({ results } = await api.search("", tag ? [tag] : []));
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
    pill.dataset.tag = t;
    if (tagColors[t]) pill.dataset.tc = tagColors[t];
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
const paletteTagsEl = $("#palette-tags");
let paletteItems = [];
let paletteSel = 0;
let searchTimer = null;
const paletteTags = new Set();   // 選択中のタグフィルタ(AND)
let paletteTagsExpanded = false;

function renderPaletteTags() {
  const chipsEl = $("#palette-tags-chips");
  const toggle = $("#palette-tags-toggle");
  chipsEl.innerHTML = "";
  if (!allTags.length) {
    paletteTagsEl.hidden = true;
    return;
  }
  paletteTagsEl.hidden = false;
  paletteTagsEl.classList.toggle("expanded", paletteTagsExpanded);
  // 選択中のタグを先頭に(折りたたみ時も必ず見えるように)
  const ordered = [
    ...allTags.filter((t) => paletteTags.has(t.tag)),
    ...allTags.filter((t) => !paletteTags.has(t.tag)),
  ];
  for (const t of ordered) {
    const b = el("button", "pill" + (paletteTags.has(t.tag) ? " on" : ""), t.tag);
    b.type = "button";
    if (t.color) b.dataset.tc = t.color;
    b.appendChild(el("span", "tp-cnt", String(t.count)));
    b.addEventListener("click", () => {
      if (paletteTags.has(t.tag)) paletteTags.delete(t.tag);
      else paletteTags.add(t.tag);
      renderPaletteTags();
      runSearch(paletteInput.value);
      paletteInput.focus();
    });
    chipsEl.appendChild(b);
  }
  // 1行に収まらないときだけ「＋N / たたむ」トグルを出す
  const chips = [...chipsEl.children];
  const overflowCount = chips.filter((c) => c.offsetTop > chips[0].offsetTop).length;
  toggle.hidden = !overflowCount && !paletteTagsExpanded;
  toggle.textContent = paletteTagsExpanded ? "− たたむ" : `＋${overflowCount}`;
}

$("#palette-tags-toggle").addEventListener("click", () => {
  paletteTagsExpanded = !paletteTagsExpanded;
  renderPaletteTags();
  paletteInput.focus();
});

function openPalette() {
  paletteOverlay.hidden = false;
  paletteInput.value = "";
  paletteTags.clear();
  paletteTagsExpanded = false;
  renderPaletteTags();
  paletteInput.focus();
  runSearch("");
}
function closePalette() {
  paletteOverlay.hidden = true;
}

async function runSearch(q) {
  const { results } = await api.search(q, [...paletteTags]);
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
let newTagPicker = null;

function openNewDialog() {
  newOverlay.hidden = false;
  $("#new-title").value = "";
  $("#new-folder").value = "";
  newTagPicker = createTagPicker($("#new-tag-picker"));
  $("#new-title").focus();
}
function closeNewDialog() { newOverlay.hidden = true; }

async function createNote() {
  const title = $("#new-title").value.trim();
  if (!title) { $("#new-title").focus(); return; }
  const folder = $("#new-folder").value.trim();
  const tags = newTagPicker ? newTagPicker.get() : [];
  try {
    const { path } = await api.create({ title, folder, tags });
    closeNewDialog();
    await refreshSidebar();
    showNote(path);
  } catch { /* オフライン時はバナー表示のみ */ }
}

/* ---------- 汎用入力ダイアログ ---------- */
const inputOverlay = $("#input-overlay");
let inputResolve = null;

function askInput({ title, label, value = "", placeholder = "", suggestions = [] }) {
  return new Promise((resolve) => {
    inputResolve = resolve;
    $("#input-title").textContent = title;
    $("#input-label").textContent = label;
    const field = $("#input-field");
    field.value = value;
    field.placeholder = placeholder;
    const dl = $("#input-suggestions");
    dl.innerHTML = "";
    for (const s of suggestions) {
      const opt = document.createElement("option");
      opt.value = s;
      dl.appendChild(opt);
    }
    inputOverlay.hidden = false;
    field.focus();
    field.select();
  });
}

function closeInput(result) {
  inputOverlay.hidden = true;
  if (inputResolve) {
    inputResolve(result);
    inputResolve = null;
  }
}

$("#input-ok").addEventListener("click", () => closeInput($("#input-field").value));
$("#input-cancel").addEventListener("click", () => closeInput(null));
inputOverlay.addEventListener("click", (e) => { if (e.target === inputOverlay) closeInput(null); });
inputOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") closeInput($("#input-field").value);
  if (e.key === "Escape") closeInput(null);
});

/* ---------- コンテキストメニュー(ノート/フォルダ共通の開閉) ---------- */
const noteMenu = $("#note-menu");
const folderMenu = $("#folder-menu");
let menuPath = null;
let menuFolder = null;

function placeMenu(menu, e) {
  e.preventDefault();
  e.stopPropagation();
  noteMenu.hidden = true;
  folderMenu.hidden = true;
  menu.hidden = false;
  const w = 200;
  const h = menu.offsetHeight || 120;
  menu.style.left = Math.min(e.clientX, window.innerWidth - w - 10) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - h - 10) + "px";
}

function openNoteMenu(e, path) {
  menuPath = path;
  placeMenu(noteMenu, e);
}

function openFolderMenu(e, folderPath) {
  menuFolder = folderPath;
  placeMenu(folderMenu, e);
}

document.addEventListener("click", (e) => {
  if (!noteMenu.hidden && !noteMenu.contains(e.target)) noteMenu.hidden = true;
  if (!folderMenu.hidden && !folderMenu.contains(e.target)) folderMenu.hidden = true;
});

async function renameNoteDialog(path) {
  try {
    const note = await api.note(path);
    const title = await askInput({
      title: "表示名を変更", label: "新しい表示名", value: note.title,
    });
    if (title == null || !title.trim() || title.trim() === note.title) return;
    await api.updateMeta(path, { title: title.trim() });
    toast("表示名を変更しました");
    await refreshSidebar();
    if (currentPath === path) showNote(path);
  } catch {
    toast("操作に失敗しました");
  }
}

/* タグ編集ダイアログ(チップ式ピッカー) */
const tagsOverlay = $("#tags-overlay");
let editTagPicker = null;
let tagsResolve = null;

function askTags(initial) {
  return new Promise((resolve) => {
    tagsResolve = resolve;
    editTagPicker = createTagPicker($("#edit-tag-picker"), initial);
    tagsOverlay.hidden = false;
    editTagPicker.focus();
  });
}

function closeTags(result) {
  tagsOverlay.hidden = true;
  if (tagsResolve) {
    tagsResolve(result);
    tagsResolve = null;
  }
}

$("#tags-ok").addEventListener("click", () => closeTags(editTagPicker.get()));
$("#tags-cancel").addEventListener("click", () => closeTags(null));
tagsOverlay.addEventListener("click", (e) => { if (e.target === tagsOverlay) closeTags(null); });
tagsOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") closeTags(editTagPicker.get());
  if (e.key === "Escape") closeTags(null);
});

async function editTagsDialog(path) {
  try {
    const note = await api.note(path);
    const tags = await askTags(note.tags);
    if (tags == null) return;
    await api.updateMeta(path, { tags });
    toast("タグを更新しました");
    await refreshSidebar();
    if (currentPath === path) showNote(path);
  } catch {
    toast("操作に失敗しました");
  }
}

async function moveNoteDialog(path) {
  try {
    const note = await api.note(path);
    const folder = await askInput({
      title: "フォルダへ移動", label: "移動先フォルダ(空欄でルートへ)",
      value: note.folder, suggestions: allFolders,
    });
    if (folder == null || folder.trim() === note.folder) return;
    await movePathsTo([path], folder.trim());
  } catch {
    toast("操作に失敗しました");
  }
}

noteMenu.addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act || !menuPath) return;
  const path = menuPath;
  noteMenu.hidden = true;
  if (act === "vscode") api.open(path).catch(() => toast("操作に失敗しました"));
  else if (act === "rename") renameNoteDialog(path);
  else if (act === "tags") editTagsDialog(path);
  else if (act === "move") moveNoteDialog(path);
});

/* ---------- フォルダメニュー ---------- */
async function renameFolderDialog(folderPath) {
  const oldName = folderPath.split("/").pop();
  const name = await askInput({
    title: "フォルダ名を変更", label: "新しいフォルダ名", value: oldName,
  });
  if (name == null || !name.trim() || name.trim() === oldName) return;
  try {
    const res = await api.renameFolder(folderPath, name.trim());
    toast("フォルダ名を変更しました");
    // 表示中のノートがこのフォルダ配下ならパスを追従させる
    if (currentPath && currentPath.startsWith(folderPath + "/")) {
      const newPath = res.folder + currentPath.slice(folderPath.length);
      await refreshSidebar();
      showNote(newPath);
      return;
    }
    await refreshSidebar();
  } catch {
    toast("変更できませんでした(同名フォルダがある可能性)");
  }
}

folderMenu.addEventListener("click", async (e) => {
  const act = e.target.dataset.act;
  if (!act || !menuFolder) return;
  const folderPath = menuFolder;
  folderMenu.hidden = true;
  if (act === "rename") renameFolderDialog(folderPath);
  else if (act === "newnote") {
    openNewDialog();
    $("#new-folder").value = folderPath;
    $("#new-title").focus();
  }
});

/* ---------- 設定ポップオーバー ---------- */
const settingsPop = $("#settings-pop");

$("#settings-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPop.hidden = !settingsPop.hidden;
});
document.addEventListener("click", (e) => {
  if (!settingsPop.hidden && !settingsPop.contains(e.target) && e.target.id !== "settings-btn") {
    settingsPop.hidden = true;
  }
});

/* ---------- 新規フォルダ ---------- */
const folderOverlay = $("#folder-overlay");

function openFolderDialog() {
  folderOverlay.hidden = false;
  $("#folder-name").value = "";
  $("#folder-name").focus();
}
function closeFolderDialog() { folderOverlay.hidden = true; }

async function createFolder() {
  const folder = $("#folder-name").value.trim();
  if (!folder) { $("#folder-name").focus(); return; }
  try {
    await api.newFolder(folder);
    closeFolderDialog();
    await refreshSidebar();
    toast(`フォルダ「${folder}」を作成しました`);
  } catch {
    toast("フォルダを作成できませんでした");
  }
}

$("#new-folder-btn").addEventListener("click", openFolderDialog);
$("#folder-cancel").addEventListener("click", closeFolderDialog);
$("#folder-create").addEventListener("click", createFolder);
folderOverlay.addEventListener("click", (e) => { if (e.target === folderOverlay) closeFolderDialog(); });
folderOverlay.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName === "INPUT") createFolder();
  if (e.key === "Escape") closeFolderDialog();
});

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
  if (e.key === "F2") {
    // ダイアログ表示中は何もしない
    if (!inputOverlay.hidden || !paletteOverlay.hidden || !newOverlay.hidden || !folderOverlay.hidden || !tagsOverlay.hidden) return;
    const target = selectedPaths.size === 1 ? [...selectedPaths][0] : currentPath;
    if (target) {
      e.preventDefault();
      renameNoteDialog(target);
    }
  }
  if (e.key === "Escape") {
    if (!tagColorPop.hidden) tagColorPop.hidden = true;
    else if (!paletteOverlay.hidden) closePalette();
    else if (selectedPaths.size) clearSelection();
  }
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
