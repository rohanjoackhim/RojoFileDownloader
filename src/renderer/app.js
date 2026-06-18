/* global rojoAPI */

let torrents = [];
let selectedHash = null;
let contextHash = null;
let torrentOrder = []; // array of infoHashes in display order
const torrentLogs = new Map(); // infoHash -> array of log lines
const torrentElements = new Map(); // infoHash -> { el, refs }

// SVG icon for torrent items (reused)
const TORRENT_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

// ---------- UI Helpers ----------

function $(id) { return document.getElementById(id); }

function formatBytes(b) {
  if (b === 0 || b == null) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function formatSpeed(bps) {
  if (!bps || bps === 0) return "0 B/s";
  return formatBytes(bps) + "/s";
}

function formatEta(ms) {
  if (!ms || ms === Infinity || ms < 0) return "--";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return min + "m " + rem + "s";
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return hr + "h " + remMin + "m";
}

function showToast(msg, type = "success") {
  const toast = $("toast");
  toast.textContent = msg;
  toast.className = "toast " + type;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 3000);
}

function updateStatus(text) {
  $("statusText").textContent = text;
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Detail Panel ----------

// Cache last detail values to avoid redundant DOM updates
let lastDetailHash = null;
let lastDetail = {};

function updateDetailPanel(t) {
  if (!t) {
    $("detailPanel").style.display = "none";
    lastDetailHash = null;
    return;
  }
  $("detailPanel").style.display = "block";

  const hash = t.infoHash;
  const pct = Math.round((t.progress || 0) * 100);
  const sizeText = `${formatBytes(t.downloaded || 0)} of ${formatBytes(t.length || 0)} (${(t.progress || 0).toFixed(2)}%)`;
  const fillClass = "battery-fill" + (t.status === "completed" ? " completed" : t.status === "paused" ? " paused" : "");
  const statusText = t.status === "completed" ? "Download complete" :
                     t.status === "paused" ? "Paused" :
                     t.speed > 0 ? `Downloading ${formatSpeed(t.speed)}` : "Connecting to peers…";
  const peersText = (t.peers || 0) + " peers";
  const downText = "\u2193 " + formatSpeed(t.speed || 0);
  const upText = "\u2191 " + formatSpeed(t.uploadSpeed || 0);
  const etaText = "ETA: " + formatEta(t.timeRemaining);
  const ratioText = "Ratio: " + (t.ratio || 0).toFixed(2);

  const changed = (k, v) => lastDetailHash !== hash || lastDetail[k] !== v;

  if (changed("name", t.name)) $("detailName").textContent = t.name || "--";
  if (changed("size", sizeText)) $("detailSize").textContent = sizeText;
  if (changed("pct", pct)) $("detailPct").textContent = pct + "%";
  if (changed("fillClass", fillClass)) {
    const fill = $("batteryFill");
    fill.style.width = pct + "%";
    fill.className = fillClass;
  }
  if (changed("status", statusText)) $("detailStatus").textContent = statusText;
  if (changed("peers", peersText)) $("detailPeers").textContent = peersText;
  if (changed("down", downText)) $("detailDown").textContent = downText;
  if (changed("up", upText)) $("detailUp").textContent = upText;
  if (changed("eta", etaText)) $("detailEta").textContent = etaText;
  if (changed("ratio", ratioText)) $("detailRatio").textContent = ratioText;
  if (changed("path", t.path)) $("detailPath").textContent = t.path || "--";

  lastDetailHash = hash;
  lastDetail = { name: t.name, size: sizeText, pct, fillClass, status: statusText, peers: peersText, down: downText, up: upText, eta: etaText, ratio: ratioText, path: t.path };
}

// ---------- Torrent List Rendering ----------

function createTorrentElement(t) {
  const el = document.createElement("div");
  el.className = "torrent-item";
  el.dataset.hash = t.infoHash;
  el.addEventListener("click", () => selectTorrent(t.infoHash));
  el.addEventListener("contextmenu", (e) => showContextMenu(e, t.infoHash));

  const icon = document.createElement("div");
  icon.className = "torrent-icon";
  icon.innerHTML = TORRENT_SVG;
  const iconText = document.createElement("span");
  iconText.className = "torrent-icon-text";
  icon.appendChild(iconText);
  el.appendChild(icon);

  const info = document.createElement("div");
  info.className = "torrent-info";

  const nameEl = document.createElement("div");
  nameEl.className = "torrent-name";
  info.appendChild(nameEl);

  const meta = document.createElement("div");
  meta.className = "torrent-meta";

  const badge = document.createElement("span");
  badge.className = "status-badge";
  meta.appendChild(badge);

  const pctEl = document.createElement("span");
  meta.appendChild(pctEl);

  const sizeEl = document.createElement("span");
  meta.appendChild(sizeEl);

  const peersEl = document.createElement("span");
  meta.appendChild(peersEl);

  const speedEl = document.createElement("span");
  meta.appendChild(speedEl);

  const etaEl = document.createElement("span");
  meta.appendChild(etaEl);

  info.appendChild(meta);

  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  bar.appendChild(fill);
  info.appendChild(bar);

  el.appendChild(info);

  const actions = document.createElement("div");
  actions.className = "torrent-actions";
  el.appendChild(actions);

  return {
    el,
    refs: { nameEl, badge, pctEl, sizeEl, peersEl, speedEl, etaEl, fill, actions, iconText },
  };
}

function updateTorrentElement(refs, t) {
  const pct = Math.round((t.progress || 0) * 100);
  const statusClass = t.status === "completed" ? "status-completed" :
                      t.status === "paused" ? "status-paused" : "status-downloading";
  const fillClass = t.status === "completed" ? "completed" : "";

  const sizeText = `${formatBytes(t.downloaded || 0)} / ${formatBytes(t.length || 0)}`;
  const peersText = (t.peers || 0) + " peers";
  const speedText = formatSpeed(t.speed || 0);
  const etaText = formatEta(t.timeRemaining);

  // Only update DOM when values changed (avoid reflow thrashing)
  const last = refs._last || {};
  if (last.name !== t.name) refs.nameEl.textContent = t.name || "--";
  if (last.status !== t.status) {
    refs.badge.className = "status-badge " + statusClass;
    refs.badge.textContent = t.status;
  }
  if (last.pct !== pct) refs.pctEl.textContent = pct + "%";
  if (last.size !== sizeText) refs.sizeEl.textContent = sizeText;
  if (last.peers !== peersText) refs.peersEl.textContent = peersText;
  if (last.speed !== speedText) refs.speedEl.textContent = speedText;
  if (last.eta !== etaText) refs.etaEl.textContent = etaText;
  if (last.fillClass !== fillClass || last.pct !== pct) {
    refs.fill.className = "progress-fill " + fillClass;
    refs.fill.style.width = pct + "%";
  }
  // Rebuild action buttons only when status changes
  const isActive = t.status === "downloading" || t.status === "paused";
  const isPaused = t.status === "paused";
  const isDone = t.status === "completed";
  const hash = t.infoHash;

  // Update icon text with percentage or "Done"
  const iconText = isDone ? "Done" : pct + "%";
  if (last.iconText !== iconText) refs.iconText.textContent = iconText;
  refs._last = { name: t.name, status: t.status, pct, size: sizeText, peers: peersText, speed: speedText, eta: etaText, fillClass, iconText };

  const existingStatus = refs.actions.dataset.status;
  const newStatus = t.status;
  if (existingStatus !== newStatus) {
    refs.actions.dataset.status = newStatus;
    refs.actions.innerHTML = "";
    if (isActive && !isDone) {
      const btn = document.createElement("button");
      btn.className = "btn-small " + (isPaused ? "btn-resume" : "btn-pause");
      btn.textContent = isPaused ? "Resume" : "Pause";
      btn.addEventListener("click", (e) => { e.stopPropagation(); isPaused ? resumeTorrent(hash) : pauseTorrent(hash); });
      refs.actions.appendChild(btn);
    }
    const folderBtn = document.createElement("button");
    folderBtn.className = "btn-small btn-folder";
    folderBtn.title = "Open folder";
    folderBtn.textContent = "\u{1F4C1}";
    folderBtn.addEventListener("click", (e) => { e.stopPropagation(); openTorrentFolder(hash); });
    refs.actions.appendChild(folderBtn);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-small btn-remove";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeTorrent(hash); });
    refs.actions.appendChild(removeBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-small btn-delete-files";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteWithFiles(hash); });
    refs.actions.appendChild(deleteBtn);
  }
}

function renderTorrents() {
  const listEl = $("torrentList");
  const emptyEl = $("emptyState");
  const dropEl = $("dropZone");

  if (!torrents.length) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    dropEl.style.display = "block";
    $("detailPanel").style.display = "none";
    // Clean up cached elements
    for (const [hash, { el }] of torrentElements) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    torrentElements.clear();
    return;
  }

  listEl.style.display = "flex";
  emptyEl.style.display = "none";
  dropEl.style.display = "none";

  // Apply custom order
  let displayTorrents = torrents;
  if (torrentOrder.length > 0) {
    const orderMap = new Map(torrentOrder.map((h, i) => [h, i]));
    displayTorrents = [...torrents].sort((a, b) => {
      const oa = orderMap.get(a.infoHash) ?? 9999;
      const ob = orderMap.get(b.infoHash) ?? 9999;
      return oa - ob;
    });
  }

  const currentHashes = new Set(displayTorrents.map(t => t.infoHash));
  const domHashes = new Set(torrentElements.keys());

  // Remove elements for torrents no longer in list
  for (const hash of domHashes) {
    if (!currentHashes.has(hash)) {
      const { el } = torrentElements.get(hash);
      if (el.parentNode) el.parentNode.removeChild(el);
      torrentElements.delete(hash);
    }
  }

  // Add/update elements
  for (const t of displayTorrents) {
    let item = torrentElements.get(t.infoHash);
    if (!item) {
      item = createTorrentElement(t);
      torrentElements.set(t.infoHash, item);
    }
    updateTorrentElement(item.refs, t);
    item.el.classList.toggle("selected", t.infoHash === selectedHash);
  }

  // Re-order DOM to match display order (only when order changed)
  for (const t of displayTorrents) {
    const item = torrentElements.get(t.infoHash);
    if (item.el.parentNode !== listEl || item.el.nextSibling !== (displayTorrents[displayTorrents.indexOf(t) + 1] ? torrentElements.get(displayTorrents[displayTorrents.indexOf(t) + 1].infoHash)?.el : null)) {
      listEl.appendChild(item.el);
    }
  }

  // Update detail panel for selected torrent
  if (selectedHash) {
    const t = torrents.find((x) => x.infoHash === selectedHash);
    if (t) updateDetailPanel(t);
    else { selectedHash = null; $("detailPanel").style.display = "none"; }
  }
}

// Fast incremental update: only update changed properties, never rebuild DOM
function updateTorrentElements() {
  console.log(`[Renderer] updateTorrentElements: torrents.length=${torrents.length}, torrentElements.size=${torrentElements.size}`);
  const listEl = $("torrentList");
  const emptyEl = $("emptyState");
  const dropEl = $("dropZone");

  if (!torrents.length) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    dropEl.style.display = "block";
    $("detailPanel").style.display = "none";
    for (const [hash, { el }] of torrentElements) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    torrentElements.clear();
    return;
  }

  listEl.style.display = "flex";
  emptyEl.style.display = "none";
  dropEl.style.display = "none";

  // Build display order (skip heavy sort if no custom order)
  const displayTorrents = torrentOrder.length > 0
    ? [...torrents].sort((a, b) => {
        const oa = torrentOrder.indexOf(a.infoHash);
        const ob = torrentOrder.indexOf(b.infoHash);
        return (oa === -1 ? 9999 : oa) - (ob === -1 ? 9999 : ob);
      })
    : torrents;

  const currentHashes = new Set(displayTorrents.map(t => t.infoHash));

  // Remove dead elements (only check every ~5 seconds to avoid thrashing)
  const now = Date.now();
  if (now - lastDeadCheck > 5000) {
    lastDeadCheck = now;
    for (const [hash, { el }] of [...torrentElements]) {
      if (!currentHashes.has(hash) && el.parentNode) {
        el.parentNode.removeChild(el);
        torrentElements.delete(hash);
      }
    }
  }

  // Check if any new elements need creation (triggers full rebuild)
  let needsAppend = false;
  for (const t of displayTorrents) {
    if (!torrentElements.has(t.infoHash)) {
      needsAppend = true;
      break;
    }
  }

  console.log(`[Renderer] needsAppend=${needsAppend}, displayTorrents.length=${displayTorrents.length}`);

  if (needsAppend) {
    // Full rebuild: collect all elements into fragment and replace list contents
    const fragment = document.createDocumentFragment();
    for (const t of displayTorrents) {
      let item = torrentElements.get(t.infoHash);
      if (!item) {
        console.log(`[Renderer] Creating new element for torrent: ${t.name}`);
        item = createTorrentElement(t);
        torrentElements.set(t.infoHash, item);
      }
      updateTorrentElement(item.refs, t);
      item.el.classList.toggle("selected", t.infoHash === selectedHash);
      fragment.appendChild(item.el);
    }
    listEl.innerHTML = "";
    listEl.appendChild(fragment);
    console.log(`[Renderer] Full rebuild complete, listEl.children.length=${listEl.children.length}`);
  } else {
    // Fast path: only update text/property changes, zero DOM structure changes
    for (const t of displayTorrents) {
      const item = torrentElements.get(t.infoHash);
      updateTorrentElement(item.refs, t);
      // Selection is handled by selectTorrent() to avoid O(n) classList toggles every frame
    }
  }

}

function selectTorrent(infoHash) {
  // Remove selected class from previous selection
  if (selectedHash) {
    const prev = torrentElements.get(selectedHash);
    if (prev) prev.el.classList.remove("selected");
  }
  selectedHash = infoHash;
  // Add selected class to new selection
  const curr = torrentElements.get(infoHash);
  if (curr) curr.el.classList.add("selected");
  // Detail panel removed from click — too much space. Use context menu > Show Torrent Info instead.
}

// ---------- Actions ----------

async function addMagnet() {
  const input = $("magnetInput");
  const magnet = input.value.trim();
  if (!magnet) return;

  $("btnConfirmMagnet").disabled = true;
  $("magnetError").textContent = "";
  updateStatus("Choose download folder…");

  try {
    const result = await rojoAPI.addMagnet(magnet);
    if (result.ok) {
      showToast(`Added: ${result.name}`);
      closeModal();
      input.value = "";
    } else {
      $("magnetError").textContent = result.error || "Failed to add torrent";
    }
  } catch (e) {
    $("magnetError").textContent = e.message || "Failed to add torrent";
  } finally {
    $("btnConfirmMagnet").disabled = false;
    updateStatus("Ready");
  }
}

async function pauseTorrent(infoHash) {
  try {
    const res = await rojoAPI.pauseTorrent(infoHash);
    if (res.ok) showToast("Paused");
  } catch (e) {
    showToast("Pause failed", "error");
  }
}

async function resumeTorrent(infoHash) {
  try {
    const res = await rojoAPI.resumeTorrent(infoHash);
    if (res.ok) showToast("Resumed");
  } catch (e) {
    showToast("Resume failed", "error");
  }
}

function removeTorrentFromUI(infoHash) {
  const item = torrentElements.get(infoHash);
  if (item && item.el.parentNode) {
    item.el.parentNode.removeChild(item.el);
  }
  torrentElements.delete(infoHash);
  torrents = torrents.filter((t) => t.infoHash !== infoHash);
  if (selectedHash === infoHash) {
    selectedHash = null;
    $("detailPanel").style.display = "none";
  }
}

async function removeTorrent(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t) return;
  if (!confirm(`Remove "${t.name}" from the list?\n\nDownloaded files will remain on disk.`)) return;

  // Immediately vanish from UI so it feels instant
  removeTorrentFromUI(infoHash);

  try {
    await rojoAPI.removeTorrent(infoHash, false);
  } catch (e) {
    showToast("Remove failed", "error");
  }
}

async function deleteWithFiles(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t) return;
  if (!confirm(`Delete "${t.name}" and all downloaded files?\n\nThis cannot be undone.`)) return;

  // Immediately vanish from UI so it feels instant
  removeTorrentFromUI(infoHash);

  try {
    await rojoAPI.removeTorrent(infoHash, true);
  } catch (e) {
    showToast("Delete failed", "error");
  }
}

async function openFile() {
  try {
    const result = await rojoAPI.selectFile();
    if (!result) return;

    updateStatus("Choose download folder…");
    const res = await rojoAPI.addFile(result.buffer);
    if (res.ok) {
      showToast(`Added: ${res.name}`);
    } else {
      showToast(res.error || "Failed to add", "error");
    }
  } catch (e) {
    showToast(e.message || "Failed to add", "error");
  } finally {
    updateStatus("Ready");
  }
}

async function openFolder() {
  await rojoAPI.openFolder();
}

async function openTorrentFolder(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t || !t.path) return;
  await rojoAPI.openTorrentFolder(t.path);
}

// ---------- Window Controls ----------

$("btnMinimize").addEventListener("click", () => {
  rojoAPI.windowMinimize();
});

$("btnClose").addEventListener("click", () => {
  rojoAPI.windowClose();
});

// ---------- Modal ----------

function openModal() {
  $("magnetModal").classList.add("show");
  $("magnetInput").focus();
  $("magnetError").textContent = "";
}

function closeModal() {
  $("magnetModal").classList.remove("show");
}

// ---------- Drag & Drop ----------

const dropZone = $("dropZone");

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
  });
});

dropZone.addEventListener("drop", async (e) => {
  e.preventDefault();
  const items = e.dataTransfer.items || e.dataTransfer.files;

  for (const item of items) {
    let entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    let file = item.getAsFile ? item.getAsFile() : item;

    if (!file && entry) {
      try {
        file = await new Promise((res, rej) => entry.file(res, rej));
      } catch {
        continue;
      }
    }

    if (!file) continue;

    if (file.name.endsWith(".torrent")) {
      const buffer = await file.arrayBuffer();
      updateStatus("Choose download folder…");
      const res = await rojoAPI.addFile(buffer);
      if (res.ok) showToast(`Added: ${res.name}`);
      else showToast(res.error || "Failed to add", "error");
      updateStatus("Ready");
    } else {
      const text = await file.text().catch(() => "");
      if (text.trim().startsWith("magnet:")) {
        const res = await rojoAPI.addMagnet(text.trim());
        if (res.ok) showToast(`Added: ${res.name}`);
        else showToast(res.error || "Failed to add", "error");
      }
    }
  }
});

// Also handle drops on the whole window for when torrent list is visible
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  if (e.target.closest(".torrent-item")) return;
  e.preventDefault();
});

// ---------- Event Wiring ----------

$("btnAddMagnet").addEventListener("click", openModal);
$("btnConfirmMagnet").addEventListener("click", addMagnet);
$("btnCancelMagnet").addEventListener("click", closeModal);
$("magnetInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addMagnet();
});
$("btnOpenFile").addEventListener("click", openFile);
$("btnOpenFolder").addEventListener("click", openFolder);

function updateDefaultStar(isDefault) {
  $("btnSetDefault").classList.toggle("is-default", isDefault);
}

$("btnSetDefault").addEventListener("click", async () => {
  try {
    await rojoAPI.setAsDefault();
    const check = await rojoAPI.checkIsDefault();
    updateDefaultStar(check.isDefault);
    // Only show feedback when something actually failed
    if (!check.isDefault) {
      showToast("Could not set as default. macOS may require the app to be in /Applications.", "error");
    }
  } catch (e) {
    showToast(e.message, "error");
  }
});

// Close modal on backdrop click
$("magnetModal").querySelector(".modal-backdrop").addEventListener("click", closeModal);

// ---------- Context Menu ----------

function showContextMenu(e, infoHash) {
  e.preventDefault();
  contextHash = infoHash;
  contextMenuOpen = true;
  const menu = $("contextMenu");
  hideSubmenus();

  // Position menu near cursor, keep inside viewport
  const x = Math.min(e.clientX, window.innerWidth - 240);
  const y = Math.min(e.clientY, window.innerHeight - 420);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.add("show");
}

function hideContextMenu() {
  $("contextMenu").classList.remove("show");
  hideSubmenus();
  contextHash = null;
  contextMenuOpen = false;
}

function hideSubmenus() {
  document.querySelectorAll(".ctx-submenu").forEach(s => s.classList.remove("show"));
}

function showSubmenu(subId, anchorEl) {
  hideSubmenus();
  const sub = $(subId);
  sub.classList.add("show");
  // Position submenu to the right of the anchor
  const rect = anchorEl.getBoundingClientRect();
  sub.style.left = rect.right + "px";
  sub.style.top = rect.top + "px";
}

// Hide context menu on any click outside
window.addEventListener("click", (e) => {
  if (!e.target.closest(".context-menu")) hideContextMenu();
});

// Copy Magnet URI
async function copyMagnetUri(infoHash) {
  try {
    const uri = await rojoAPI.getMagnetUri(infoHash);
    if (uri) {
      await navigator.clipboard.writeText(uri);
      showToast("Magnet URI copied to clipboard");
    } else {
      showToast("Magnet URI not available", "error");
    }
  } catch (e) {
    showToast(e.message, "error");
  }
}

// Move torrents
function moveTorrent(infoHash, direction) {
  const idx = torrentOrder.indexOf(infoHash);
  if (idx === -1) {
    // Build order from current torrents if not set
    torrentOrder = torrents.map(t => t.infoHash);
  }
  const currentIdx = torrentOrder.indexOf(infoHash);
  if (currentIdx === -1) return;

  let newIdx;
  if (direction === "top") newIdx = 0;
  else if (direction === "bottom") newIdx = torrentOrder.length - 1;
  else if (direction === "up") newIdx = Math.max(0, currentIdx - 1);
  else if (direction === "down") newIdx = Math.min(torrentOrder.length - 1, currentIdx + 1);
  else return;

  const [moved] = torrentOrder.splice(currentIdx, 1);
  torrentOrder.splice(newIdx, 0, moved);
  renderTorrents();
}

// Speed limits (basic IPC)
async function setDlLimit(infoHash, bytesPerSec) {
  try {
    await rojoAPI.limitSpeed(infoHash, bytesPerSec, null);
    showToast(bytesPerSec === 0 ? "Download unlimited" : `Download limited to ${formatSpeed(bytesPerSec)}`);
  } catch (e) {
    showToast(e.message, "error");
  }
}
async function setUlLimit(infoHash, bytesPerSec) {
  try {
    await rojoAPI.limitSpeed(infoHash, null, bytesPerSec);
    showToast(bytesPerSec === 0 ? "Upload unlimited" : `Upload limited to ${formatSpeed(bytesPerSec)}`);
  } catch (e) {
    showToast(e.message, "error");
  }
}

// Show torrent log
function showTorrentLog(infoHash) {
  const t = torrents.find(x => x.infoHash === infoHash);
  $("logTitle").textContent = t ? `Log: ${t.name}` : "Torrent Log";
  const lines = torrentLogs.get(infoHash) || [];
  $("logContent").textContent = lines.length ? lines.join("\n") : "No log entries yet.";
  $("logModal").classList.add("show");
}
function closeLogModal() {
  $("logModal").classList.remove("show");
}

// Quick Look
function quickLookTorrent(infoHash) {
  const t = torrents.find(x => x.infoHash === infoHash);
  if (t && t.path) {
    rojoAPI.openTorrentFolder(t.path);
  }
}

// Force Re-Check
async function recheckTorrent(infoHash) {
  try {
    await rojoAPI.recheckTorrent(infoHash);
    showToast("Re-checking torrent…");
  } catch (e) {
    showToast(e.message, "error");
  }
}

// Context menu item clicks
$("contextMenu").addEventListener("click", (e) => {
  const item = e.target.closest(".ctx-item");
  if (!item || !contextHash) return;

  const action = item.dataset.action;
  const hash = contextHash;

  if (action === "copy-magnet") copyMagnetUri(hash);
  else if (action === "limit-dl") showSubmenu("subDlSpeed", item);
  else if (action === "limit-ul") showSubmenu("subUlSpeed", item);
  else if (action === "move-top") moveTorrent(hash, "top");
  else if (action === "move-up") moveTorrent(hash, "up");
  else if (action === "move-down") moveTorrent(hash, "down");
  else if (action === "move-bottom") moveTorrent(hash, "bottom");
  else if (action === "recheck") recheckTorrent(hash);
  else if (action === "update-tracker") showToast("Update tracker: not yet implemented", "error");
  else if (action === "relocate") showToast("Relocate: not yet implemented", "error");
  else if (action === "show-info") { selectTorrent(hash); }
  else if (action === "stop-ratio") showSubmenu("subRatio", item);
  else if (action === "show-log") showTorrentLog(hash);
  else if (action === "show-finder") openTorrentFolder(hash);
  else if (action === "quick-look") quickLookTorrent(hash);
  else if (action === "delete-task") removeTorrent(hash);
  else if (action === "delete-files") deleteWithFiles(hash);

  // Submenu selections
  if (item.dataset.dl !== undefined) setDlLimit(hash, parseInt(item.dataset.dl));
  if (item.dataset.ul !== undefined) setUlLimit(hash, parseInt(item.dataset.ul));
  if (item.dataset.ratio !== undefined) {
    rojoAPI.setStopRatio(hash, parseFloat(item.dataset.ratio));
    showToast(`Stop seeding at ratio ${item.dataset.ratio}`);
  }

  if (!action || !action.startsWith("limit") && action !== "stop-ratio") {
    hideContextMenu();
  }
});

$("btnCloseLog").addEventListener("click", closeLogModal);
$("logModal").querySelector(".modal-backdrop").addEventListener("click", closeLogModal);

// ---------- IPC Listeners ----------

let renderPending = false;
let lastLogTime = 0;
let contextMenuOpen = false;
let lastDeadCheck = 0;
rojoAPI.onTorrentsUpdated((data) => {
  console.log(`[Renderer] torrents-updated received: ${data.torrents?.length || 0} torrents`);
  torrents = data.torrents || [];
  const count = torrents.length;
  const label = count === 1 ? "1 transfer" : count + " transfers";
  const down = formatSpeed(data.downloadSpeed);
  const up = formatSpeed(data.uploadSpeed);

  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      // Skip all DOM updates while context menu is open to prevent freezing
      if (!contextMenuOpen) {
        $("statusText").textContent = label;
        $("downSpeed").textContent = down;
        $("upSpeed").textContent = up;
        console.log(`[Renderer] Calling updateTorrentElements with ${torrents.length} torrents`);
        updateTorrentElements();
      }
    });
  }
  // Log speed updates: at most once every 5 seconds, and only when activity changes
  const now = Date.now();
  if (now - lastLogTime > 5000) {
    lastLogTime = now;
    const timeStr = new Date(now).toLocaleTimeString();
    for (const t of torrents) {
      if (t.speed > 0 || t.uploadSpeed > 0) {
        if (!torrentLogs.has(t.infoHash)) torrentLogs.set(t.infoHash, []);
        const log = torrentLogs.get(t.infoHash);
        log.push(`[${timeStr}] ${t.status} | ${formatSpeed(t.speed)} down | ${formatSpeed(t.uploadSpeed)} up | ${Math.round(t.progress*100)}% | ${t.peers} peers`);
        if (log.length > 100) log.shift();
      }
    }
  }
});

rojoAPI.onTorrentCompleted((data) => {
  showToast(`Completed: ${data.name}`);
  if (!torrentLogs.has(data.infoHash)) torrentLogs.set(data.infoHash, []);
  torrentLogs.get(data.infoHash).push(`[${new Date().toLocaleTimeString()}] COMPLETED`);
});

rojoAPI.onTorrentError((msg) => {
  showToast(msg, "error");
});

rojoAPI.onTorrentAutoPaused((data) => {
  showToast(`Stopped seeding ${data.name} at ratio ${data.ratio.toFixed(2)}`);
});

rojoAPI.onTorrentRemoved((data) => {
  removeTorrentFromUI(data.infoHash);
});

// ---------- VPN ----------

let vpnActive = false;

function updateVpnUI(status) {
  vpnActive = status.active;
  const vpnBtn = $("btnVpnToggle");
  const vpnStatus = $("vpnStatus");
  const vpnLabel = $("vpnLabel");

  if (status.active) {
    vpnBtn.classList.add("active");
    vpnStatus.style.display = "inline-flex";
    vpnLabel.textContent = status.address ? `VPN ${status.address}` : "VPN on";
  } else {
    vpnBtn.classList.remove("active");
    vpnStatus.style.display = "none";
  }
}

async function refreshVpnStatus() {
  try {
    const status = await rojoAPI.vpnStatus();
    updateVpnUI(status);
  } catch (e) {
    console.warn("[VPN] status error:", e.message);
  }
}

function openVpnModal() {
  $("vpnModal").classList.add("show");
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "";
  // Load saved config
  rojoAPI.vpnLoadConfig().then((res) => {
    if (res.ok && res.config) $("vpnConfigInput").value = res.config;
  }).catch(() => {});
}

function closeVpnModal() {
  $("vpnModal").classList.remove("show");
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "";
}

async function connectVpn() {
  const config = $("vpnConfigInput").value.trim();
  if (!config) {
    $("vpnError").textContent = "Paste your WireGuard config first.";
    return;
  }
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "Connecting…";
  try {
    const res = await rojoAPI.vpnConnect(config);
    if (res.ok) {
      $("vpnSuccess").textContent = `Connected! Tunnel: ${res.address ?? "unknown"}`;
      await rojoAPI.vpnSaveConfig(config);
      updateVpnUI({ active: true, address: res.address });
    } else {
      $("vpnSuccess").textContent = "";
      $("vpnError").textContent = res.error || "Failed to connect.";
    }
  } catch (e) {
    $("vpnSuccess").textContent = "";
    $("vpnError").textContent = e.message;
  }
}

async function disconnectVpn() {
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "Disconnecting…";
  try {
    const res = await rojoAPI.vpnDisconnect();
    if (res.ok) {
      $("vpnSuccess").textContent = "Disconnected.";
      updateVpnUI({ active: false, address: null });
    } else {
      $("vpnSuccess").textContent = "";
      $("vpnError").textContent = res.error || "Failed to disconnect.";
    }
  } catch (e) {
    $("vpnSuccess").textContent = "";
    $("vpnError").textContent = e.message;
  }
}

async function testVpn() {
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "Testing…";
  try {
    const res = await rojoAPI.vpnTest("https://1.1.1.1");
    if (res.ok) {
      $("vpnSuccess").textContent = `VPN test OK: ${res.status} ${res.statusText ?? ""}`;
    } else {
      $("vpnSuccess").textContent = "";
      $("vpnError").textContent = res.error || `Test failed: ${res.status}`;
    }
  } catch (e) {
    $("vpnSuccess").textContent = "";
    $("vpnError").textContent = e.message;
  }
}

// Poll VPN status every 5 seconds
setInterval(refreshVpnStatus, 5000);

// ---------- Event Wiring ----------

$("btnVpnToggle").addEventListener("click", openVpnModal);
$("btnVpnCancel").addEventListener("click", closeVpnModal);
$("btnVpnConnect").addEventListener("click", connectVpn);
$("btnVpnDisconnect").addEventListener("click", disconnectVpn);
$("btnVpnTest").addEventListener("click", testVpn);
$("vpnModal").querySelector(".modal-backdrop").addEventListener("click", closeVpnModal);

// ---------- Init ----------

(async function init() {
  const dlPath = await rojoAPI.getDownloadPath();
  console.log("[RO^JO] Download path:", dlPath);
  try {
    const def = await rojoAPI.checkIsDefault();
    updateDefaultStar(def.isDefault);
  } catch (e) {
    console.warn("[RO^JO] checkIsDefault failed:", e);
  }
  updateTorrentElements();
  refreshVpnStatus();
})();
