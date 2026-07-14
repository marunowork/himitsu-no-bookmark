// page.js — ひみつのブックマーク(タブ内ページ)
// 機能1: ブックマーク一覧表示(クリックで別タブ)
// 機能2: パスフレーズによる暗号化
// 機能3: 暗号化データのインポート/ダウンロード
//
// ポップアップではなく拡張機能の専用タブページとして動作する。
// これにより、ファイル選択ダイアログを開いてもUIが閉じない。

/* ============================================================
 * タブ切り替え
 * ========================================================== */
const tabButtons = document.querySelectorAll("nav.tabs button");
tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabButtons.forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.target).classList.add("active");
  });
});

/* ============================================================
 * 共通: ブックマークツリーの描画
 * (browser.bookmarks の生ノードと、復号後のプレーンオブジェクトの
 *  どちらも {title, url?, children?} の形なので同じ関数で描画できる)
 *
 * options.dnd が true の場合、フォルダ間のドラッグ&ドロップ移動を
 * 有効にする(現状は「インポート」タブの復元済みリストのみで使用)。
 * ========================================================== */
function renderTree(container, nodesArray, keyword, emptyMessage, options = {}) {
  container.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "root";

  let hasAny = false;
  for (const node of nodesArray) {
    const el = buildNode(node, keyword, options);
    if (el) {
      ul.appendChild(el);
      hasAny = true;
    }
  }

  if (hasAny) {
    container.appendChild(ul);
  } else {
    const div = document.createElement("div");
    div.id = "empty";
    div.textContent = emptyMessage;
    container.appendChild(div);
  }

  if (options.dnd) {
    setupRootDropZone(container);
  }
}

function buildNode(node, keyword, options = {}) {
  const dnd = !!options.dnd;
  const deletable = !!options.deletable;
  const isFolder = Array.isArray(node.children);

  if (isFolder) {
    const childEls = [];
    for (const child of node.children) {
      const el = buildNode(child, keyword, options);
      if (el) childEls.push(el);
    }

    const selfMatches = matchesKeyword(node.title, keyword);
    if (!selfMatches && childEls.length === 0 && keyword) return null;

    const li = document.createElement("li");
    const folderRow = document.createElement("div");
    folderRow.className = "folder";
    folderRow.innerHTML = `<span class="arrow">▾</span><span class="icon">📁</span><span class="title"></span>`;
    folderRow.querySelector(".title").textContent = node.title || "(無題のフォルダ)";

    const childrenUl = document.createElement("ul");
    childrenUl.className = "children";
    childEls.forEach((el) => childrenUl.appendChild(el));

    folderRow.addEventListener("click", () => {
      folderRow.classList.toggle("collapsed");
      childrenUl.classList.toggle("hidden");
    });

    if (dnd && node._id) {
      folderRow.draggable = true;
      folderRow.dataset.nodeId = node._id;
      attachDragHandlers(folderRow, node._id, { isFolderDropTarget: true });
    }

    if (deletable && node._id) {
      folderRow.appendChild(createDeleteButton(node));
    }

    li.appendChild(folderRow);
    li.appendChild(childrenUl);
    return li;
  }

  if (!node.url) return null;
  if (keyword && !matchesKeyword(node.title, keyword) && !matchesKeyword(node.url, keyword)) {
    return null;
  }

  const li = document.createElement("li");
  const a = document.createElement("a");
  a.className = "bookmark";
  a.href = node.url;
  a.title = node.url;

  const favicon = document.createElement("span");
  favicon.className = "favicon";
  favicon.style.backgroundImage = `url("https://www.google.com/s2/favicons?domain=${encodeURIComponent(safeHostname(node.url))}&sz=32")`;

  const titleSpan = document.createElement("span");
  titleSpan.className = "title";
  titleSpan.textContent = node.title || node.url;

  a.appendChild(favicon);
  a.appendChild(titleSpan);

  // クリックで別タブで開く(機能1)
  a.addEventListener("click", (ev) => {
    ev.preventDefault();
    browser.tabs.create({ url: node.url });
  });

  if (dnd && node._id) {
    a.draggable = true;
    a.dataset.nodeId = node._id;
    attachDragHandlers(a, node._id, { isFolderDropTarget: false });
  }

  if (deletable && node._id) {
    const row = document.createElement("div");
    row.className = "bookmark-row";
    row.appendChild(a);
    row.appendChild(createDeleteButton(node));
    li.appendChild(row);
    return li;
  }

  li.appendChild(a);
  return li;
}

function matchesKeyword(text, keyword) {
  if (!keyword) return true;
  return (text || "").toLowerCase().includes(keyword);
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/* ============================================================
 * ドラッグ&ドロップによるフォルダ間移動(インポートタブ専用)
 *
 * importedTopNodes(トップレベル配列)を「唯一の真実」として保持し、
 * 各ノードに一意な _id を割り当てて識別する。
 * ドロップ操作のたびにこの配列を書き換えてから再描画する。
 * ========================================================== */
let dndIdCounter = 0;
let draggedNodeId = null;

function generateNodeId() {
  dndIdCounter += 1;
  return `n${Date.now()}_${dndIdCounter}`;
}

/**
 * ノード配列を再帰的に走査し、_id が未設定のノードにIDを付与する。
 * 既にIDを持つノードはそのまま(移動時に再割り当てされないようにするため)。
 */
function assignNodeIds(nodesArray) {
  for (const node of nodesArray) {
    if (!node._id) node._id = generateNodeId();
    if (Array.isArray(node.children)) assignNodeIds(node.children);
  }
}

/** 指定IDのノードを探して返す(見つからなければ null)。*/
function findNodeById(id, nodesArray) {
  for (const node of nodesArray) {
    if (node._id === id) return node;
    if (Array.isArray(node.children)) {
      const found = findNodeById(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

/** 指定IDのノードが格納されている配列と、その中でのインデックスを返す。*/
function findParentArrayAndIndex(id, nodesArray) {
  for (let i = 0; i < nodesArray.length; i++) {
    const node = nodesArray[i];
    if (node._id === id) return { parentArray: nodesArray, index: i };
    if (Array.isArray(node.children)) {
      const result = findParentArrayAndIndex(id, node.children);
      if (result) return result;
    }
  }
  return null;
}

/** ancestorNode の子孫に targetId のノードが含まれるか判定する。*/
function isDescendantOf(ancestorNode, targetId) {
  if (!Array.isArray(ancestorNode.children)) return false;
  for (const child of ancestorNode.children) {
    if (child._id === targetId) return true;
    if (isDescendantOf(child, targetId)) return true;
  }
  return false;
}

/**
 * draggedId のノードを一旦取り除いたうえで、computeDestination が返す
 * 場所(配列と挿入位置)に挿入する。無効な移動(自分自身やその子孫への
 * 移動など)の場合は computeDestination が null を返し、元の位置に戻す。
 * @returns {boolean} 移動が行われたかどうか
 */
function moveNode(draggedId, computeDestination) {
  const draggedLoc = findParentArrayAndIndex(draggedId, importedTopNodes);
  if (!draggedLoc) return false;

  const [draggedNode] = draggedLoc.parentArray.splice(draggedLoc.index, 1);

  const dest = computeDestination(draggedNode);
  if (!dest) {
    // 無効な移動は元に戻す
    draggedLoc.parentArray.splice(draggedLoc.index, 0, draggedNode);
    return false;
  }

  dest.array.splice(dest.index, 0, draggedNode);
  return true;
}

/** フォルダの上にドロップ:そのフォルダの末尾に子として移動する。*/
function moveNodeIntoFolder(draggedId, targetFolderId) {
  return moveNode(draggedId, (draggedNode) => {
    if (targetFolderId === draggedNode._id) return null;

    if (targetFolderId === "ROOT") {
      return { array: importedTopNodes, index: importedTopNodes.length };
    }

    const targetFolder = findNodeById(targetFolderId, importedTopNodes);
    if (!targetFolder || !Array.isArray(targetFolder.children)) return null;
    if (isDescendantOf(draggedNode, targetFolderId)) return null; // 自分の子孫には移動不可

    return { array: targetFolder.children, index: targetFolder.children.length };
  });
}

/** 項目の上にドロップ:その項目の直前(同じ階層)に移動する。*/
function moveNodeBeforeSibling(draggedId, targetId) {
  return moveNode(draggedId, (draggedNode) => {
    if (targetId === draggedNode._id) return null;
    if (isDescendantOf(draggedNode, targetId)) return null; // 自分の子孫の前には移動不可

    const loc = findParentArrayAndIndex(targetId, importedTopNodes);
    if (!loc) return null;

    return { array: loc.parentArray, index: loc.index };
  });
}

/** ルート直下(最上位)の末尾に移動する。*/
function moveNodeToRootEnd(draggedId) {
  return moveNode(draggedId, (draggedNode) => {
    return { array: importedTopNodes, index: importedTopNodes.length };
  });
}

/**
 * 1つの要素(フォルダ行 or ブックマークリンク)にドラッグ&ドロップ用の
 * イベントハンドラを付与する。
 * @param {HTMLElement} el 対象要素
 * @param {string} nodeId この要素が表すノードのID
 * @param {object} opts { isFolderDropTarget: フォルダとして子要素を受け入れるか }
 */
function attachDragHandlers(el, nodeId, opts) {
  el.addEventListener("dragstart", (ev) => {
    draggedNodeId = nodeId;
    ev.dataTransfer.effectAllowed = "move";
    try { ev.dataTransfer.setData("text/plain", nodeId); } catch { /* noop */ }
    // 描画のずれを避けるため、クラス付与は少し遅延させる
    setTimeout(() => el.classList.add("dragging"), 0);
  });

  el.addEventListener("dragend", () => {
    draggedNodeId = null;
    document.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
    document.querySelectorAll(".drag-over, .drag-over-item").forEach((n) => {
      n.classList.remove("drag-over", "drag-over-item");
    });
  });

  el.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ev.dataTransfer.dropEffect = "move";
    el.classList.add(opts.isFolderDropTarget ? "drag-over" : "drag-over-item");
  });

  el.addEventListener("dragleave", () => {
    el.classList.remove("drag-over", "drag-over-item");
  });

  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    el.classList.remove("drag-over", "drag-over-item");

    const draggedId = draggedNodeId || ev.dataTransfer.getData("text/plain");
    if (!draggedId || draggedId === nodeId) return;

    const moved = opts.isFolderDropTarget
      ? moveNodeIntoFolder(draggedId, nodeId)
      : moveNodeBeforeSibling(draggedId, nodeId);

    if (moved) {
      renderImportTree();
    } else {
      showStatus(addBookmarkStatusEl, "そこには移動できません(フォルダを自分自身や、その中には移動できません)。", false);
    }
  });
}

/**
 * ツリーコンテナ自体(空白部分)へのドロップを、ルート直下への移動として
 * 扱えるようにする。項目上でのドロップは stopPropagation されるため、
 * ここには「何もない場所」にドロップした時だけイベントが届く。
 */
function setupRootDropZone(container) {
  container.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
  });

  container.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const draggedId = draggedNodeId || ev.dataTransfer.getData("text/plain");
    if (!draggedId) return;

    const moved = moveNodeToRootEnd(draggedId);
    if (moved) renderImportTree();
  });
}

/* ============================================================
 * 削除機能(インポートタブ専用)
 * ========================================================== */

/**
 * ノード用の削除ボタン要素を作成する。
 * クリックすると確認ダイアログを表示し、承認されればノードを
 * importedTopNodes から取り除いて再描画する。
 */
function createDeleteButton(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "delete-btn";
  btn.title = "削除";
  btn.setAttribute("aria-label", "削除");
  btn.textContent = "🗑";

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    handleDeleteNode(node._id, node);
  });

  // 削除ボタン自体がドラッグ操作の起点にならないようにする
  btn.addEventListener("dragstart", (ev) => ev.stopPropagation());

  return btn;
}

/**
 * 指定ノードを確認のうえ削除する。
 */
function handleDeleteNode(id, node) {
  const isFolder = Array.isArray(node.children);
  const label = node.title || (isFolder ? "(無題のフォルダ)" : node.url);

  const message = isFolder && node.children.length > 0
    ? `フォルダ「${label}」を削除しますか?\n中の${node.children.length}件の項目もすべて削除されます。`
    : `「${label}」を削除しますか?`;

  if (!window.confirm(message)) return;

  const loc = findParentArrayAndIndex(id, importedTopNodes);
  if (!loc) return;

  loc.parentArray.splice(loc.index, 1);
  renderImportTree();
  showStatus(addBookmarkStatusEl, `「${label}」を削除しました。`, true);
}

/* ============================================================
 * 機能1: 一覧タブ(実際のFirefoxブックマーク)
 * ========================================================== */
let liveTopNodes = []; // ルート直下(メニューバー/ツールバー等)を除いたトップレベル配列
const treeEl = document.getElementById("tree");
const searchEl = document.getElementById("search");

async function loadLiveBookmarks() {
  try {
    const rootNodes = await browser.bookmarks.getTree();
    liveTopNodes = [];
    for (const node of rootNodes) {
      if (node.children) liveTopNodes.push(...node.children);
    }
    renderTree(treeEl, liveTopNodes, "", "ブックマークが見つかりません。");
  } catch (err) {
    treeEl.innerHTML = `<div id="empty">ブックマークの取得に失敗しました。</div>`;
    console.error(err);
  }
}

searchEl.addEventListener("input", () => {
  const keyword = searchEl.value.trim().toLowerCase();
  renderTree(treeEl, liveTopNodes, keyword, "ブックマークが見つかりません。");
});

/* ============================================================
 * 暗号化ユーティリティ (Web Crypto API: PBKDF2 + AES-GCM)
 * ========================================================== */
const APP_TAG = "himitsu-no-bookmark";
const PBKDF2_ITER = 100000;

function ab2b64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function b642ab(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(passphrase, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ブラウザのブックマークノードを、必要最小限のプレーンオブジェクトに変換
function nodeToPlain(node) {
  if (Array.isArray(node.children)) {
    return {
      title: node.title || "",
      children: node.children.map(nodeToPlain).filter(Boolean)
    };
  }
  if (node.url) {
    return { title: node.title || node.url, url: node.url };
  }
  return null;
}

// ドラッグ&ドロップ管理用に付与した _id を取り除き、
// 暗号化・保存対象を最小限のデータだけにする。
function stripInternalIds(nodesArray) {
  return nodesArray.map((node) => {
    if (Array.isArray(node.children)) {
      return { title: node.title || "", children: stripInternalIds(node.children) };
    }
    return { title: node.title || node.url, url: node.url };
  });
}

async function encryptBookmarks(passphrase, plainArray) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITER);
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(plainArray));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return {
    app: APP_TAG,
    version: 1,
    kdf: "PBKDF2-SHA256",
    iterations: PBKDF2_ITER,
    salt: ab2b64(salt),
    iv: ab2b64(iv),
    ciphertext: ab2b64(cipherBuf)
  };
}

async function decryptBookmarks(passphrase, fileObj) {
  if (!fileObj || fileObj.app !== APP_TAG) {
    throw new Error("対応していないファイル形式です。");
  }
  const salt = new Uint8Array(b642ab(fileObj.salt));
  const iv = new Uint8Array(b642ab(fileObj.iv));
  const iterations = fileObj.iterations || PBKDF2_ITER;
  const key = await deriveKey(passphrase, salt, iterations);
  const cipherBuf = b642ab(fileObj.ciphertext);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBuf);
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(plainBuf));
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function timestampForFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function showStatus(el, message, ok) {
  el.textContent = message;
  el.className = "status show " + (ok ? "ok" : "err");
}

/* ============================================================
 * 機能2: 暗号化タブ
 * ========================================================== */
const encPassEl = document.getElementById("enc-pass");
const encPass2El = document.getElementById("enc-pass2");
const encBtn = document.getElementById("enc-btn");
const encStatusEl = document.getElementById("enc-status");

encBtn.addEventListener("click", async () => {
  const pass = encPassEl.value;
  const pass2 = encPass2El.value;

  if (!pass) {
    showStatus(encStatusEl, "パスフレーズを入力してください。", false);
    return;
  }
  if (pass.length < 4) {
    showStatus(encStatusEl, "パスフレーズは4文字以上を推奨します。", false);
    return;
  }
  if (pass !== pass2) {
    showStatus(encStatusEl, "パスフレーズ(確認)が一致しません。", false);
    return;
  }

  encBtn.disabled = true;
  showStatus(encStatusEl, "暗号化しています…", true);

  try {
    const rootNodes = await browser.bookmarks.getTree();
    const plainArray = [];
    for (const node of rootNodes) {
      if (node.children) {
        for (const child of node.children) {
          const plain = nodeToPlain(child);
          if (plain) plainArray.push(plain);
        }
      }
    }

    const encrypted = await encryptBookmarks(pass, plainArray);
    downloadJson(encrypted, `himitsu-bookmark_${timestampForFilename()}.json`);
    showStatus(encStatusEl, "暗号化してダウンロードしました。", true);
  } catch (err) {
    console.error(err);
    showStatus(encStatusEl, "暗号化に失敗しました。もう一度お試しください。", false);
  } finally {
    encBtn.disabled = false;
  }
});

/* ============================================================
 * 機能3: インポートタブ
 * ========================================================== */
const importFileEl = document.getElementById("import-file");
const importPassEl = document.getElementById("import-pass");
const importBtn = document.getElementById("import-btn");
const importStatusEl = document.getElementById("import-status");
const importTreeEl = document.getElementById("import-tree");

const addBookmarkTextareaEl = document.getElementById("add-bookmark-textarea");
const addBookmarkBtn = document.getElementById("add-bookmark-btn");
const addBookmarkStatusEl = document.getElementById("add-bookmark-status");

const redownloadBtn = document.getElementById("redownload-btn");
const redownloadStatusEl = document.getElementById("redownload-status");

// 復元(復号)したブックマークの状態。トップレベルの配列を保持し、
// 追加操作や再描画のたびにこの配列を更新する。
let importedTopNodes = [];

function renderImportTree() {
  assignNodeIds(importedTopNodes);
  renderTree(
    importTreeEl,
    importedTopNodes,
    "",
    "ブックマークがありません。ファイルをインポートするか、下のフォームから追加してください。",
    { dnd: true, deletable: true }
  );
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

importBtn.addEventListener("click", async () => {
  const file = importFileEl.files && importFileEl.files[0];
  const pass = importPassEl.value;

  if (!file) {
    showStatus(importStatusEl, "ファイルを選択してください。", false);
    return;
  }
  if (!pass) {
    showStatus(importStatusEl, "パスフレーズを入力してください。", false);
    return;
  }

  importBtn.disabled = true;
  showStatus(importStatusEl, "復号しています…", true);

  try {
    const text = await readFileAsText(file);
    let fileObj;
    try {
      fileObj = JSON.parse(text);
    } catch {
      throw new Error("ファイルの形式が正しくありません。");
    }

    const plainArray = await decryptBookmarks(pass, fileObj);
    importedTopNodes = plainArray;
    renderImportTree();
    showStatus(importStatusEl, "復号に成功しました。", true);
  } catch (err) {
    console.error(err);
    showStatus(importStatusEl, "復号に失敗しました。パスフレーズまたはファイルを確認してください。", false);
  } finally {
    importBtn.disabled = false;
  }
});

/**
 * テキストエリアの入力を解析し、{title, url} の配列を返す。
 * 1行1件。「タイトル, URL」または「タイトル | URL」形式、
 * もしくはURLのみの行にも対応する。
 */
function parseBookmarkLines(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const results = [];
  const errors = [];

  for (const line of lines) {
    let title = "";
    let url = "";

    const sepMatch = line.includes("|") ? "|" : (line.includes(",") ? "," : null);

    if (sepMatch) {
      const idx = line.indexOf(sepMatch);
      title = line.slice(0, idx).trim();
      url = line.slice(idx + 1).trim();
    } else {
      url = line;
    }

    if (!url) {
      errors.push(line);
      continue;
    }

    // http(s):// が無い場合は補完を試みる
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    try {
      const parsed = new URL(url);
      if (!title) title = parsed.hostname;
      results.push({ title, url: parsed.href });
    } catch {
      errors.push(line);
    }
  }

  return { results, errors };
}

addBookmarkBtn.addEventListener("click", () => {
  const text = addBookmarkTextareaEl.value;

  if (!text.trim()) {
    showStatus(addBookmarkStatusEl, "追加するブックマークを入力してください。", false);
    return;
  }

  const { results, errors } = parseBookmarkLines(text);

  if (results.length === 0) {
    showStatus(addBookmarkStatusEl, "有効なURLが見つかりませんでした。入力内容を確認してください。", false);
    return;
  }

  importedTopNodes = importedTopNodes.concat(results);
  renderImportTree();
  addBookmarkTextareaEl.value = "";

  if (errors.length > 0) {
    showStatus(
      addBookmarkStatusEl,
      `${results.length}件を追加しました(${errors.length}件は形式が不正のためスキップしました)。`,
      true
    );
  } else {
    showStatus(addBookmarkStatusEl, `${results.length}件を追加しました。`, true);
  }
});

redownloadBtn.addEventListener("click", async () => {
  const pass = importPassEl.value;

  if (importedTopNodes.length === 0) {
    showStatus(redownloadStatusEl, "保存するブックマークがありません。", false);
    return;
  }
  if (!pass) {
    showStatus(redownloadStatusEl, "上の「パスフレーズ」欄に、暗号化に使うパスフレーズを入力してください。", false);
    return;
  }

  redownloadBtn.disabled = true;
  showStatus(redownloadStatusEl, "暗号化しています…", true);

  try {
    const cleanArray = stripInternalIds(importedTopNodes);
    const encrypted = await encryptBookmarks(pass, cleanArray);
    downloadJson(encrypted, `himitsu-bookmark_${timestampForFilename()}.json`);
    showStatus(redownloadStatusEl, "更新版を暗号化してダウンロードしました。", true);
  } catch (err) {
    console.error(err);
    showStatus(redownloadStatusEl, "ダウンロードに失敗しました。もう一度お試しください。", false);
  } finally {
    redownloadBtn.disabled = false;
  }
});

// 初期表示(未インポート状態でも「追加」フォームを使えるようにする)
renderImportTree();

/* ============================================================
 * 初期化
 * ========================================================== */
loadLiveBookmarks();
