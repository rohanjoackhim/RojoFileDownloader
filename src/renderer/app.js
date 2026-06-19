/* global rojoAPI */

let torrents = [];
let selectedHash = null;
let contextHash = null;
let torrentOrder = []; // array of infoHashes in display order
const torrentLogs = new Map(); // infoHash -> array of log lines
const torrentElements = new Map(); // infoHash -> { el, refs }

// Cached status for visibility-aware rendering
let lastStatusLabel = "Ready";
let lastStatusDown = "0 B/s";
let lastStatusUp = "0 B/s";

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

// Set app logo from correct asset path (avoids asar .. path issues)
(async function loadLogo() {
  try {
    const logoPath = await rojoAPI.getAssetPath("icon.png");
    if (logoPath) $("appLogo").src = logoPath;
  } catch (e) {
    console.error("[RO^JO] Failed to load logo:", e);
  }
})();

// ---------- Detail Panel ----------

// Cache last detail values to avoid redundant DOM updates
let lastDetailHash = null;
let lastDetail = {};
let lastCoverName = null;
const rendererCoverCache = new Map(); // torrentName -> imageUrl

const rendererImdbCache = new Map();

function showImdbBadge(imdb) {
  const badge = $("detailImdb");
  const ratingEl = $("detailImdbRating");
  if (!imdb || !imdb.rating) {
    badge.style.display = "none";
    badge.href = "#";
    return;
  }
  ratingEl.textContent = imdb.rating;
  badge.href = `https://www.imdb.com/title/${imdb.id}/`;
  badge.style.display = "inline-flex";
}

async function fetchAndShowCover(torrentName) {
  if (!torrentName || lastCoverName === torrentName) return;
  lastCoverName = torrentName;
  const coverEl = $("detailCover");

  // Check cache
  if (rendererCoverCache.has(torrentName)) {
    const url = rendererCoverCache.get(torrentName);
    if (url) { coverEl.src = url; coverEl.style.display = "block"; }
    else { coverEl.style.display = "none"; }
    const imdb = rendererImdbCache.get(torrentName);
    showImdbBadge(imdb || null);
    return;
  }

  // Hide while loading
  coverEl.style.display = "none";
  coverEl.src = "";
  $("detailImdb").style.display = "none";

  try {
    const result = await rojoAPI.fetchCoverArt(torrentName);
    rendererCoverCache.set(torrentName, result.ok && result.url ? result.url : null);
    rendererImdbCache.set(torrentName, result.ok && result.imdb ? result.imdb : null);
    if (lastCoverName === torrentName) {
      if (result.url) {
        coverEl.src = result.url;
        coverEl.style.display = "block";
      }
      showImdbBadge(result.imdb || null);
    }
  } catch (e) {
    rendererCoverCache.set(torrentName, null);
    rendererImdbCache.set(torrentName, null);
  }
}

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

  // Fetch cover art when torrent changes
  if (lastDetailHash !== hash && t.name) {
    fetchAndShowCover(t.name);
  }

  // Render file list
  const fileList = t.fileList;
  const filesEl = $("detailFiles");
  const filesListEl = $("detailFilesList");
  if (fileList && fileList.length > 0) {
    filesEl.style.display = "block";
    // Only rebuild if file list changed
    const fileListKey = fileList.map(f => f.name + f.length).join("|");
    if (changed("fileListKey", fileListKey)) {
      filesListEl.innerHTML = "";
      const isCompleted = t.status === "completed";
      fileList.forEach((f) => {
        const item = document.createElement("div");
        item.className = "detail-file-item";
        const check = isCompleted
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5"><circle cx="12" cy="12" r="10"/></svg>';
        item.innerHTML = `${check}<span class="detail-file-name" title="${f.name}">${f.name}</span><span class="detail-file-size">${formatBytes(f.length || 0)}</span>`;
        filesListEl.appendChild(item);
      });
    }
  } else {
    filesEl.style.display = "none";
  }

  lastDetailHash = hash;
  lastDetail = { name: t.name, size: sizeText, pct, fillClass, status: statusText, peers: peersText, down: downText, up: upText, eta: etaText, ratio: ratioText, path: t.path, fileListKey: fileList ? fileList.map(f => f.name + f.length).join("|") : "" };
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
    refs: { nameEl, badge, sizeEl, peersEl, speedEl, etaEl, fill, actions, iconText },
  };
}

function updateTorrentElement(refs, t) {
  const isHttp = t.type === "http";
  const pct = Math.round((t.progress || 0) * 100);
  const statusClass = t.status === "completed" ? "status-completed" :
                      t.status === "paused" ? "status-paused" : "status-downloading";
  const fillClass = t.status === "completed" ? "completed" : "";

  const sizeText = `${formatBytes(t.downloaded || 0)} / ${formatBytes(t.length || 0)}`;
  const peersText = isHttp ? "HTTP" : ((t.peers || 0) + " peers");
  const speedText = formatSpeed(t.speed || 0);
  const etaText = formatEta(t.timeRemaining);

  // Only update DOM when values changed (avoid reflow thrashing)
  const last = refs._last || {};
  if (last.name !== t.name) refs.nameEl.textContent = t.name || "--";
  if (last.status !== t.status) {
    refs.badge.className = "status-badge " + statusClass;
    refs.badge.textContent = t.status === "completed" ? "100%" : t.status;
  }
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

  // Update icon text with percentage or "Done" when complete
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
      if (isHttp) {
        const httpId = parseInt(hash.replace("http-", ""), 10);
        btn.addEventListener("click", (e) => { e.stopPropagation(); isPaused ? resumeHttpDownload(httpId) : pauseHttpDownload(httpId); });
      } else {
        btn.addEventListener("click", (e) => { e.stopPropagation(); isPaused ? resumeTorrent(hash) : pauseTorrent(hash); });
      }
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
    if (isHttp) {
      const httpId = parseInt(hash.replace("http-", ""), 10);
      removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeHttpDownload(httpId); });
    } else {
      removeBtn.addEventListener("click", (e) => { e.stopPropagation(); removeTorrent(hash); });
    }
    refs.actions.appendChild(removeBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-small btn-delete-files";
    deleteBtn.textContent = "Delete";
    if (isHttp) {
      const httpId = parseInt(hash.replace("http-", ""), 10);
      deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteHttpDownload(httpId); });
    } else {
      deleteBtn.addEventListener("click", (e) => { e.stopPropagation(); deleteWithFiles(hash); });
    }
    refs.actions.appendChild(deleteBtn);
  }
}

function renderTorrents() {
  const listEl = $("torrentList");
  const emptyEl = $("emptyState");
  const dropEl = $("dropZone");

  const allItems = [...torrents, ...httpDownloadsList];

  if (!allItems.length) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    dropEl.style.display = "block";
    $("detailPanel").style.display = "none";
    $("rightPanelEmpty").style.display = "flex";
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

  // Apply custom order (torrents only; HTTP downloads append at end)
  let displayTorrents = allItems;
  if (torrentOrder.length > 0) {
    const orderMap = new Map(torrentOrder.map((h, i) => [h, i]));
    displayTorrents = [...allItems].sort((a, b) => {
      const oa = orderMap.get(a.infoHash) ?? 9999;
      const ob = orderMap.get(b.infoHash) ?? 9999;
      return oa - ob;
    });
  }

  const currentHashes = new Set(displayTorrents.map(t => t.infoHash));
  const domHashes = new Set(torrentElements.keys());

  // Remove elements for items no longer in list
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

  // Re-order DOM to match display order (only when order changed) — O(n)
  let prevEl = null;
  for (let i = 0; i < displayTorrents.length; i++) {
    const item = torrentElements.get(displayTorrents[i].infoHash);
    const expectedNext = prevEl ? prevEl.nextSibling : listEl.firstChild;
    if (item.el !== expectedNext) {
      listEl.insertBefore(item.el, expectedNext);
    }
    prevEl = item.el;
  }

  // Update detail panel for selected torrent
  if (selectedHash) {
    const t = allItems.find((x) => x.infoHash === selectedHash);
    if (t) {
      $("detailPanel").style.display = "block";
      $("rightPanelEmpty").style.display = "none";
      updateDetailPanel(t);
    } else {
      selectedHash = null;
      $("detailPanel").style.display = "none";
      $("rightPanelEmpty").style.display = "flex";
    }
  }
}

// Fast incremental update: only update changed properties, never rebuild DOM
function updateTorrentElements() {
  renderTorrents();
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
  // Show detail panel in left sidebar
  const allItems = [...torrents, ...httpDownloadsList];
  const t = allItems.find((x) => x.infoHash === infoHash);
  if (t) {
    $("detailPanel").style.display = "block";
    $("rightPanelEmpty").style.display = "none";
    updateDetailPanel(t);
  }
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
    } else if (result.duplicate) {
      // Show confirmation dialog to replace existing torrent
      if (confirm(`"${result.name}" is already in your download list.\n\nDo you want to remove the old one and add it again?`)) {
        // Remove the existing torrent
        await rojoAPI.removeTorrent(result.infoHash, true);
        // Add the new one
        const retryResult = await rojoAPI.addMagnet(magnet);
        if (retryResult.ok) {
          showToast(`Replaced: ${retryResult.name}`);
          closeModal();
          input.value = "";
        } else {
          $("magnetError").textContent = retryResult.error || "Failed to add torrent";
        }
      }
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
  httpDownloadsList = httpDownloadsList.filter((t) => t.infoHash !== infoHash);
  if (selectedHash === infoHash) {
    selectedHash = null;
    $("detailPanel").style.display = "none";
    $("rightPanelEmpty").style.display = "flex";
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

async function secureDelete(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t) return;
  if (!confirm(`SECURE DELETE "${t.name}"?\n\nAll downloaded files will be overwritten with random data before deletion. This makes recovery extremely difficult.\n\nThis cannot be undone.`)) return;

  showToast(`Securely deleting "${t.name}"...`, "warning");
  removeTorrentFromUI(infoHash);

  try {
    const result = await rojoAPI.secureDeleteTorrent(infoHash);
    if (result.ok) {
      showToast(result.message, "success");
    } else {
      showToast(result.error || "Secure delete failed", "error");
    }
  } catch (e) {
    showToast("Secure delete failed", "error");
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

// ---------- HTTP Downloads ----------
let httpDownloadsList = [];

function openUrlModal() {
  $("urlModal").classList.add("show");
  $("urlInput").value = "";
  $("urlError").textContent = "";
  $("urlInput").focus();
}

function closeUrlModal() {
  $("urlModal").classList.remove("show");
  $("urlError").textContent = "";
}

async function addUrlDownload() {
  const url = $("urlInput").value.trim();
  if (!url) { $("urlError").textContent = "Please enter a URL"; return; }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    $("urlError").textContent = "URL must start with http:// or https://";
    return;
  }
  $("urlError").textContent = "";
  closeUrlModal();
  try {
    const res = await rojoAPI.startHttpDownload(url);
    if (res.ok) {
      showToast("Download started");
    } else {
      showToast(res.error || "Failed to start download", "error");
    }
  } catch (e) {
    showToast(e.message || "Failed to start download", "error");
  }
}

async function pauseHttpDownload(id) {
  try {
    await rojoAPI.pauseHttpDownload(id);
  } catch (e) {}
}

async function resumeHttpDownload(id) {
  try {
    await rojoAPI.resumeHttpDownload(id);
  } catch (e) {}
}

async function removeHttpDownload(id) {
  if (!confirm("Remove this download?\n\nDownloaded files will remain on disk.")) return;
  try {
    await rojoAPI.removeHttpDownload(id, false);
  } catch (e) {}
}

async function deleteHttpDownload(id) {
  if (!confirm("Delete this download and all files?\n\nThis cannot be undone.")) return;
  try {
    await rojoAPI.removeHttpDownload(id, true);
  } catch (e) {}
}

// ---------- Schedule ----------
function openScheduleModal() {
  $("scheduleModal").classList.add("show");
  $("scheduleUrlInput").value = "";
  $("scheduleError").textContent = "";
  // Set default time to now + 1 hour
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  $("scheduleTime").value = d.toISOString().slice(0, 16);
  renderScheduleList();
}

function closeScheduleModal() {
  $("scheduleModal").classList.remove("show");
  $("scheduleError").textContent = "";
}

async function confirmSchedule() {
  const url = $("scheduleUrlInput").value.trim();
  const timeStr = $("scheduleTime").value;
  if (!url) { $("scheduleError").textContent = "Please enter a URL"; return; }
  if (!timeStr) { $("scheduleError").textContent = "Please select a time"; return; }
  const scheduledTime = new Date(timeStr).getTime();
  if (isNaN(scheduledTime) || scheduledTime <= Date.now()) {
    $("scheduleError").textContent = "Please select a future time";
    return;
  }
  $("scheduleError").textContent = "";
  try {
    await rojoAPI.scheduleDownload(url, null, scheduledTime);
    showToast("Download scheduled");
    $("scheduleUrlInput").value = "";
    renderScheduleList();
  } catch (e) {
    $("scheduleError").textContent = e.message || "Failed to schedule";
  }
}

async function cancelScheduled(id) {
  try {
    await rojoAPI.cancelScheduledDownload(id);
    renderScheduleList();
  } catch (e) {}
}

function renderScheduleList() {
  rojoAPI.getScheduledDownloads().then(items => {
    const el = $("scheduleList");
    el.innerHTML = "";
    if (!items || !items.length) {
      el.innerHTML = "<p style=\"font-size:0.75rem;color:var(--text-muted);\">No scheduled downloads</p>";
      return;
    }
    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "schedule-item";
      const date = new Date(item.scheduledTime);
      const timeStr = date.toLocaleString();
      const name = item.url.split("/").pop() || "Download";
      row.innerHTML = `<span class="schedule-name" title="${escapeHtml(item.url)}">${escapeHtml(name)}</span><span class="schedule-time">${timeStr}</span><button class="btn-small btn-remove" data-id="${item.id}">Cancel</button>`;
      row.querySelector("button").addEventListener("click", () => cancelScheduled(item.id));
      el.appendChild(row);
    });
  });
}

// ---------- History ----------

async function openHistoryModal() {
  $("historyModal").classList.add("show");
  await renderHistoryList();
}

function closeHistoryModal() {
  $("historyModal").classList.remove("show");
}

async function renderHistoryList() {
  try {
    const result = await rojoAPI.getTorrentHistory();
    const history = result.ok && result.history ? result.history : [];
    const el = $("historyList");
    const emptyEl = $("historyEmpty");
    el.innerHTML = "";

    if (!history.length) {
      el.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }

    el.style.display = "block";
    emptyEl.style.display = "none";

    history.forEach((item) => {
      const row = document.createElement("div");
      row.className = "history-item";
      const date = item.addedAt ? new Date(item.addedAt).toLocaleDateString() : "Unknown";
      const name = escapeHtml(item.name || "Unknown");
      row.innerHTML = `
        <div class="history-info">
          <div class="history-name" title="${name}">${name}</div>
          <div class="history-date">${date}</div>
        </div>
        <div class="history-actions">
          <button class="btn-small btn-primary" data-magnet="${escapeHtml(item.magnetUri || "")}">Add</button>
        </div>
      `;
      const addBtn = row.querySelector("button");
      addBtn.addEventListener("click", () => {
        const magnet = addBtn.dataset.magnet;
        if (magnet && magnet.startsWith("magnet:")) {
          rojoAPI.addMagnet(magnet);
          showToast(`Re-adding "${item.name}"`);
          closeHistoryModal();
        } else {
          showToast("No magnet link available", "error");
        }
      });
      el.appendChild(row);
    });
  } catch (e) {
    $("historyList").innerHTML = "";
    $("historyList").style.display = "none";
    $("historyEmpty").style.display = "block";
    $("historyEmpty").innerHTML = "<p>Failed to load history</p>";
  }
}

async function clearHistory() {
  if (!confirm("Clear all torrent history? This cannot be undone.")) return;
  try {
    await rojoAPI.clearTorrentHistory();
    renderHistoryList();
    showToast("History cleared");
  } catch (e) {
    showToast("Failed to clear history", "error");
  }
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
        else if (res.duplicate) {
          if (confirm(`"${res.name}" is already in your download list.\n\nDo you want to remove the old one and add it again?`)) {
            await rojoAPI.removeTorrent(res.infoHash, true);
            const retryResult = await rojoAPI.addMagnet(text.trim());
            if (retryResult.ok) showToast(`Replaced: ${retryResult.name}`);
            else showToast(retryResult.error || "Failed to add", "error");
          }
        } else {
          showToast(res.error || "Failed to add", "error");
        }
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

$("btnSpeedTest").addEventListener("click", async () => {
  const btn = $("btnSpeedTest");
  const originalText = btn.querySelector("span").textContent;
  btn.disabled = true;
  btn.querySelector("span").textContent = "Testing...";

  try {
    const result = await rojoAPI.speedTest();
    if (result.ok) {
      // Persist results in status bar
      $("speedTestResult").style.display = "flex";
      $("speedDownResult").textContent = "D: " + result.downloadSpeedFormatted;
      $("speedUpResult").textContent = "U: " + result.uploadSpeedFormatted;
      showToast(`Down: ${result.downloadSpeedFormatted} | Up: ${result.uploadSpeedFormatted} | Ping: ${result.ping}`);
    } else {
      showToast(`Speed test failed: ${result.error}`, "error");
    }
  } catch (e) {
    showToast(`Speed test error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.querySelector("span").textContent = originalText;
  }
});

$("btnAddUrl").addEventListener("click", openUrlModal);
$("btnConfirmUrl").addEventListener("click", addUrlDownload);
$("btnCancelUrl").addEventListener("click", closeUrlModal);
$("urlModal").querySelector(".modal-backdrop").addEventListener("click", closeUrlModal);
$("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addUrlDownload(); });

$("btnSchedule").addEventListener("click", openScheduleModal);
$("btnConfirmSchedule").addEventListener("click", confirmSchedule);
$("btnCancelSchedule").addEventListener("click", closeScheduleModal);
$("scheduleModal").querySelector(".modal-backdrop").addEventListener("click", closeScheduleModal);

$("btnHistory").addEventListener("click", openHistoryModal);
$("btnCloseHistory").addEventListener("click", closeHistoryModal);
$("btnClearHistory").addEventListener("click", clearHistory);
$("historyModal").querySelector(".modal-backdrop").addEventListener("click", closeHistoryModal);

// ---------- File Picker ----------

let pendingFilePickerInfoHash = null;
let pendingFilePickerAllSelected = true;

function showFilePickerModal(data) {
  pendingFilePickerInfoHash = data.infoHash;
  pendingFilePickerAllSelected = true;

  $("filePickerTitle").textContent = data.name || "Select Files";
  $("btnToggleAllFiles").textContent = "Deselect All";

  const totalBytes = data.fileList.reduce((sum, f) => sum + (f.length || 0), 0);
  $("filePickerHint").textContent = `${data.fileList.length} file${data.fileList.length !== 1 ? "s" : ""} · ${formatBytes(totalBytes)} total`;

  const listEl = $("filePickerList");
  listEl.innerHTML = "";

  data.fileList.forEach((file) => {
    const displayName = (file.name && String(file.name).trim()) || (file.path && String(file.path).trim()) || `File ${file.index + 1}`;
    const isRisky = data.scanResults && data.scanResults.riskyFiles && data.scanResults.riskyFiles.includes(file.name);

    const item = document.createElement("label");
    item.className = "file-picker-item" + (isRisky ? " file-picker-item--risky" : "");
    item.title = displayName + (isRisky ? " (FLAGGED: potential malware)" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !isRisky;
    checkbox.dataset.index = String(file.index);

    const row = document.createElement("div");
    row.className = "file-picker-row";

    const nameEl = document.createElement("span");
    nameEl.className = "fp-name";
    nameEl.textContent = displayName;

    const sizeEl = document.createElement("span");
    sizeEl.className = "fp-size";
    sizeEl.textContent = formatBytes(file.length || 0);

    row.appendChild(nameEl);
    row.appendChild(sizeEl);
    item.appendChild(checkbox);
    item.appendChild(row);
    listEl.appendChild(item);
  });

  // Show malware scan warning banner
  const warningEl = $("filePickerScanWarning");
  const warningListEl = $("filePickerScanList");
  if (data.scanResults && !data.scanResults.safe && data.scanResults.warnings.length > 0) {
    warningListEl.innerHTML = "";
    data.scanResults.warnings.forEach((w) => {
      const li = document.createElement("li");
      li.textContent = w;
      warningListEl.appendChild(li);
    });
    warningEl.style.display = "block";
  } else {
    warningEl.style.display = "none";
    warningListEl.innerHTML = "";
  }

  $("filePickerModal").classList.add("show");
}

// Select / Deselect All
$("btnToggleAllFiles").addEventListener("click", () => {
  pendingFilePickerAllSelected = !pendingFilePickerAllSelected;
  $("btnToggleAllFiles").textContent = pendingFilePickerAllSelected ? "Deselect All" : "Select All";
  const boxes = $("filePickerList").querySelectorAll('input[type="checkbox"]');
  boxes.forEach((cb) => { cb.checked = pendingFilePickerAllSelected; });
});

function hideFilePickerModal() {
  $("filePickerModal").classList.remove("show");
  pendingFilePickerInfoHash = null;
}

$("btnCancelFilePicker").addEventListener("click", async () => {
  if (pendingFilePickerInfoHash) {
    await rojoAPI.cancelFileSelection(pendingFilePickerInfoHash);
  }
  hideFilePickerModal();
});

$("btnConfirmFilePicker").addEventListener("click", async () => {
  if (!pendingFilePickerInfoHash) return;
  const checkboxes = $("filePickerList").querySelectorAll('input[type="checkbox"]');
  const selectedIndices = [];
  checkboxes.forEach((cb) => {
    if (cb.checked) selectedIndices.push(parseInt(cb.dataset.index));
  });
  if (selectedIndices.length === 0) {
    showToast("Please select at least one file", "error");
    return;
  }
  const result = await rojoAPI.confirmFileSelection(pendingFilePickerInfoHash, selectedIndices);
  if (result.ok) {
    showToast(`Added: ${result.name} (${selectedIndices.length} files)`);
  } else {
    showToast(`Error: ${result.error}`, "error");
  }
  hideFilePickerModal();
});

rojoAPI.onShowFilePicker((data) => {
  showFilePickerModal(data);
});

rojoAPI.onShowToast((data) => {
  showToast(data.message, data.type || "success");
});

function updateDefaultStar(isDefault) {
  $("btnSetDefault").classList.toggle("is-default", isDefault);
}

$("btnBackground").addEventListener("click", async () => {
  await rojoAPI.minimizeToTray();
});

$("btnSetDefault").addEventListener("click", async () => {
  try {
    await rojoAPI.setAsDefault();
    const check = await rojoAPI.checkIsDefault();
    // Check magnet specifically — on macOS this requires the app to be in /Applications
    const isMagnetDefault = check.magnet;
    updateDefaultStar(isMagnetDefault);
    if (!isMagnetDefault) {
      showToast("Set for .torrent files. For magnet links, move Rojo to /Applications.", "warning");
    }
  } catch (e) {
    showToast(e.message, "error");
  }
});

// Close modal on backdrop click
$("magnetModal").querySelector(".modal-backdrop").addEventListener("click", closeModal);

// Render cached state when window becomes visible
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && torrents.length) {
    $("statusText").textContent = lastStatusLabel;
    $("downSpeed").textContent = lastStatusDown;
    $("upSpeed").textContent = lastStatusUp;
    updateTorrentElements();
  }
});

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

// Update Tracker (reannounce)
async function updateTracker(infoHash) {
  try {
    const result = await rojoAPI.updateTracker(infoHash);
    if (result.ok) {
      showToast("Tracker updated — reannouncing…");
    } else {
      showToast(result.error || "Failed to update tracker", "error");
    }
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
  else if (action === "move-up") moveTorrent(hash, "up");
  else if (action === "move-down") moveTorrent(hash, "down");
  else if (action === "recheck") recheckTorrent(hash);
  else if (action === "update-tracker") updateTracker(hash);
  else if (action === "relocate") showToast("Relocate: not yet implemented", "error");
  else if (action === "stop-ratio") showSubmenu("subRatio", item);
  else if (action === "delete-task") removeTorrent(hash);
  else if (action === "delete-files") deleteWithFiles(hash);
  else if (action === "secure-delete") secureDelete(hash);

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
  torrents = data.torrents || [];
  const allItems = [...torrents, ...httpDownloadsList];
  const count = allItems.length;
  const label = count === 1 ? "1 transfer" : count + " transfers";
  const down = formatSpeed(data.downloadSpeed);
  const up = formatSpeed(data.uploadSpeed);

  // Cache latest values even if hidden — render on next visibility
  lastStatusLabel = label;
  lastStatusDown = down;
  lastStatusUp = up;

  if (!renderPending && document.visibilityState !== "hidden") {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!contextMenuOpen) {
        $("statusText").textContent = label;
        $("downSpeed").textContent = down;
        $("upSpeed").textContent = up;
        updateTorrentElements();
      }
    });
  }
});

rojoAPI.onHttpDownloadsUpdated((list) => {
  httpDownloadsList = list.map(d => ({ ...d, infoHash: `http-${d.id}`, type: "http" }));
  const allItems = [...torrents, ...httpDownloadsList];
  const count = allItems.length;
  const label = count === 1 ? "1 transfer" : count + " transfers";
  $("statusText").textContent = label;
  if (!renderPending && document.visibilityState !== "hidden") {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (!contextMenuOpen) updateTorrentElements();
    });
  }
});

rojoAPI.onHttpDownloadRemoved((data) => {
  removeTorrentFromUI(`http-${data.id}`);
});

rojoAPI.onScheduledDownloadsUpdated((list) => {
  // Refresh schedule list if modal is open
  if ($("scheduleModal").classList.contains("show")) {
    renderScheduleList();
  }
});

rojoAPI.onTorrentCompleted(async (data) => {
  showToast(`Completed: ${data.name}`);
  if (!torrentLogs.has(data.infoHash)) torrentLogs.set(data.infoHash, []);
  torrentLogs.get(data.infoHash).push(`[${new Date().toLocaleTimeString()}] COMPLETED`);

  // Post-download malware scan with ClamAV
  if (data.path) {
    try {
      const result = await rojoAPI.scanDownloadedFile(data.path);
      if (result.ok) {
        if (result.clean) {
          showToast(`Scan clean: ${data.name}`, "success");
        } else {
          showToast(`THREAT DETECTED in ${data.name}: ${result.message}`, "error");
        }
      } else {
        console.log(`[RO^JO] Scan skipped: ${result.error}`);
      }
    } catch (e) {
      console.error("[RO^JO] Post-download scan error:", e);
    }
  }
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

function updateInternetUI(isOnline) {
  const el = $("internetStatus");
  const dot = $("internetDot");
  const label = $("internetLabel");
  if (isOnline) {
    el.classList.add("online");
    label.textContent = "Online";
  } else {
    el.classList.remove("online");
    label.textContent = "Offline";
  }
}

async function checkInternet() {
  try {
    const result = await rojoAPI.checkInternet();
    updateInternetUI(result.ok);
  } catch (e) {
    updateInternetUI(false);
    console.warn("[Internet] check error:", e.message);
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

function isUserCanceledError(err) {
  if (!err) return false;
  const s = String(err).toLowerCase();
  return s.includes("user canceled") || s.includes("(-128)") || s.includes("user cancelled");
}

async function connectVpn() {
  const config = $("vpnConfigInput").value.trim();
  if (!config) {
    $("vpnError").textContent = "Paste your WireGuard config first.";
    return;
  }
  const splitTunnelRaw = $("vpnSplitTunnel").value.trim();
  const splitTunnelHosts = splitTunnelRaw
    ? splitTunnelRaw.split(",").map(s => s.trim()).filter(Boolean)
    : [];
  $("vpnError").textContent = "";
  $("vpnSuccess").textContent = "Connecting…";
  try {
    const res = await rojoAPI.vpnConnect(config, splitTunnelHosts);
    if (res.ok) {
      $("vpnSuccess").textContent = `Connected! Tunnel: ${res.address ?? "unknown"}`;
      await rojoAPI.vpnSaveConfig(config);
      updateVpnUI({ active: true, address: res.address });
    } else {
      $("vpnSuccess").textContent = "";
      const err = res.error || "Failed to connect.";
      // Don't show error if user canceled the elevation dialog
      if (isUserCanceledError(err)) {
        $("vpnError").textContent = "";
      } else {
        $("vpnError").textContent = err;
      }
    }
  } catch (e) {
    $("vpnSuccess").textContent = "";
    const err = e.message || String(e);
    if (isUserCanceledError(err)) {
      $("vpnError").textContent = "";
    } else {
      $("vpnError").textContent = err;
    }
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

// Check internet connectivity every 10 seconds
setInterval(checkInternet, 10000);

// ---------- Event Wiring ----------

$("btnVpnToggle").addEventListener("click", openVpnModal);
$("btnVpnClose").addEventListener("click", closeVpnModal);
$("btnVpnConnect").addEventListener("click", connectVpn);
$("btnVpnDisconnect").addEventListener("click", disconnectVpn);
$("btnVpnTest").addEventListener("click", testVpn);
$("vpnModal").querySelector(".modal-backdrop").addEventListener("click", closeVpnModal);

// Import .conf file
$("btnVpnImport").addEventListener("click", async () => {
  try {
    const result = await rojoAPI.selectConfFile();
    if (result && result.content) {
      $("vpnConfigInput").value = result.content;
      $("vpnError").textContent = "";
      $("vpnSuccess").textContent = "Config imported from " + (result.fileName || ".conf file");
    }
  } catch (e) {
    $("vpnError").textContent = e.message || "Failed to import file.";
  }
});

// ---------- Init ----------

(async function init() {
  const dlPath = await rojoAPI.getDownloadPath();
  console.log("[RO^JO] Download path:", dlPath);
  try {
    const def = await rojoAPI.checkIsDefault();
    updateDefaultStar(def.magnet);
  } catch (e) {
    console.warn("[RO^JO] checkIsDefault failed:", e);
  }
  updateTorrentElements();
  refreshVpnStatus();
  checkInternet();
})();
