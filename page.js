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
 * ========================================================== */
function renderTree(container, nodesArray, keyword, emptyMessage) {
  container.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "root";

  let hasAny = false;
  for (const node of nodesArray) {
    const el = buildNode(node, keyword);
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
}

function buildNode(node, keyword) {
  const isFolder = Array.isArray(node.children);

  if (isFolder) {
    const childEls = [];
    for (const child of node.children) {
      const el = buildNode(child, keyword);
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
  importTreeEl.innerHTML = "";

  try {
    const text = await readFileAsText(file);
    let fileObj;
    try {
      fileObj = JSON.parse(text);
    } catch {
      throw new Error("ファイルの形式が正しくありません。");
    }

    const plainArray = await decryptBookmarks(pass, fileObj);
    renderTree(importTreeEl, plainArray, "", "ブックマークが見つかりません。");
    showStatus(importStatusEl, "復号に成功しました。", true);
  } catch (err) {
    console.error(err);
    showStatus(importStatusEl, "復号に失敗しました。パスフレーズまたはファイルを確認してください。", false);
  } finally {
    importBtn.disabled = false;
  }
});

/* ============================================================
 * 初期化
 * ========================================================== */
loadLiveBookmarks();
