/* global rojoAPI */

let torrents = [];
let selectedHash = null;

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

function updateDetailPanel(t) {
  if (!t) {
    $("detailPanel").style.display = "none";
    return;
  }
  $("detailPanel").style.display = "block";
  $("detailName").textContent = t.name || "--";

  const pct = Math.round((t.progress || 0) * 100);
  $("detailSize").textContent = `${formatBytes(t.downloaded || 0)} of ${formatBytes(t.length || 0)} (${(t.progress || 0).toFixed(2)}%)`;
  $("detailPct").textContent = pct + "%";

  const fill = $("batteryFill");
  fill.style.width = pct + "%";
  fill.className = "battery-fill" + (t.status === "completed" ? " completed" : t.status === "paused" ? " paused" : "");

  let statusText = t.status === "completed" ? "Download complete" :
                   t.status === "paused" ? "Paused" :
                   t.speed > 0 ? `Downloading ${formatSpeed(t.speed)}` : "Connecting to peers…";
  $("detailStatus").textContent = statusText;

  $("detailPeers").textContent = (t.peers || 0) + " peers";
  $("detailDown").textContent = "\u2193 " + formatSpeed(t.speed || 0);
  $("detailUp").textContent = "\u2191 " + formatSpeed(t.uploadSpeed || 0);
  $("detailEta").textContent = "ETA: " + formatEta(t.timeRemaining);
  $("detailRatio").textContent = "Ratio: " + (t.ratio || 0).toFixed(2);
}

// ---------- Torrent List Rendering ----------

function renderTorrents() {
  const listEl = $("torrentList");
  const emptyEl = $("emptyState");
  const dropEl = $("dropZone");

  if (!torrents.length) {
    listEl.style.display = "none";
    emptyEl.style.display = "block";
    dropEl.style.display = "block";
    $("detailPanel").style.display = "none";
    return;
  }

  listEl.style.display = "flex";
  emptyEl.style.display = "none";
  dropEl.style.display = "none";

  listEl.innerHTML = torrents.map((t) => {
    const pct = Math.round((t.progress || 0) * 100);
    const statusClass = t.status === "completed" ? "status-completed" :
                        t.status === "paused" ? "status-paused" : "status-downloading";
    const fillClass = t.status === "completed" ? "completed" : "";
    const isSelected = t.infoHash === selectedHash;

    const isActive = t.status === "downloading" || t.status === "paused";
    const isPaused = t.status === "paused";
    const isDone = t.status === "completed";

    let actionButtons = "";
    if (isActive && !isDone) {
      if (isPaused) {
        actionButtons += `<button class="btn-small btn-resume" onclick="event.stopPropagation(); resumeTorrent('${t.infoHash}')">Resume</button>`;
      } else {
        actionButtons += `<button class="btn-small btn-pause" onclick="event.stopPropagation(); pauseTorrent('${t.infoHash}')">Pause</button>`;
      }
    }
    actionButtons += `<button class="btn-small btn-remove" onclick="event.stopPropagation(); removeTorrent('${t.infoHash}')">Remove</button>`;
    actionButtons += `<button class="btn-small btn-delete-files" onclick="event.stopPropagation(); deleteWithFiles('${t.infoHash}')">Delete</button>`;

    return `
      <div class="torrent-item ${isSelected ? "selected" : ""}" data-hash="${t.infoHash}" onclick="selectTorrent('${t.infoHash}')">
        <div class="torrent-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        </div>
        <div class="torrent-info">
          <div class="torrent-name">${escapeHtml(t.name)}</div>
          <div class="torrent-meta">
            <span class="status-badge ${statusClass}">${t.status}</span>
            <span>${pct}%</span>
            <span>${formatBytes(t.downloaded || 0)} / ${formatBytes(t.length || 0)}</span>
            <span>${t.peers || 0} peers</span>
            <span>${formatSpeed(t.speed || 0)}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${fillClass}" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="torrent-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }).join("");

  // Update detail panel for selected torrent
  if (selectedHash) {
    const t = torrents.find((x) => x.infoHash === selectedHash);
    if (t) updateDetailPanel(t);
    else { selectedHash = null; $("detailPanel").style.display = "none"; }
  }
}

function selectTorrent(infoHash) {
  selectedHash = infoHash;
  const t = torrents.find((x) => x.infoHash === infoHash);
  renderTorrents();
  updateDetailPanel(t);
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

async function removeTorrent(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t) return;
  if (!confirm(`Remove "${t.name}" from the list?\n\nDownloaded files will remain on disk.`)) return;

  try {
    await rojoAPI.removeTorrent(infoHash, false);
    showToast("Removed from list");
  } catch (e) {
    showToast("Remove failed", "error");
  }
}

async function deleteWithFiles(infoHash) {
  const t = torrents.find((x) => x.infoHash === infoHash);
  if (!t) return;
  if (!confirm(`Delete "${t.name}" and all downloaded files?\n\nThis cannot be undone.`)) return;

  try {
    await rojoAPI.removeTorrent(infoHash, true);
    showToast("Deleted with files");
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

// Close modal on backdrop click
$("magnetModal").querySelector(".modal-backdrop").addEventListener("click", closeModal);

// ---------- IPC Listeners ----------

rojoAPI.onTorrentsUpdated((data) => {
  torrents = data.torrents || [];
  const count = torrents.length;
  const label = count === 1 ? "1 transfer" : count + " transfers";
  $("statusText").textContent = label;
  $("downSpeed").textContent = formatSpeed(data.downloadSpeed);
  $("upSpeed").textContent = formatSpeed(data.uploadSpeed);
  renderTorrents();
});

rojoAPI.onTorrentCompleted((data) => {
  showToast(`Completed: ${data.name}`);
});

rojoAPI.onTorrentError((msg) => {
  showToast(msg, "error");
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
  renderTorrents();
  refreshVpnStatus();
})();
