const { app, BrowserWindow, ipcMain, dialog, shell, Tray, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");
const { spawn } = require("child_process");
const crypto = require("crypto");

// Prevent WebRTC/RTCDataChannel crashes from killing the app
process.on("uncaughtException", (err) => {
  const msg = err && err.message ? err.message : "";
  if (msg.includes("RTCDataChannel") || msg.includes("User-Initiated Abort") || msg.includes("Close called")) {
    console.error("[RO^JO] Swallowed WebRTC error:", msg);
    return;
  }
  console.error("[RO^JO] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  const msg = reason && typeof reason === "object" && "message" in reason ? String(reason.message) : "";
  if (msg.includes("RTCDataChannel") || msg.includes("User-Initiated Abort") || msg.includes("Close called")) {
    console.error("[RO^JO] Swallowed WebRTC rejection:", msg);
    return;
  }
  console.error("[RO^JO] Unhandled rejection:", reason);
});

// Import VPN module from local copy
let vpn;
try {
  const vpnPath = path.join(__dirname, "../vpn/index.cjs");
  console.log("[RO^JO] Attempting to load VPN module from:", vpnPath);
  console.log("[RO^JO] VPN file exists:", fs.existsSync(vpnPath));
  vpn = require(vpnPath);
  console.log("[RO^JO] VPN module loaded successfully");
} catch (e) {
  console.error("[RO^JO] VPN module not available:", e.message);
  console.error("[RO^JO] Full error:", e);
  vpn = null;
}

// ---------- Config ----------
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), "Downloads", "Rojo");
if (!fs.existsSync(DEFAULT_DOWNLOAD_DIR)) {
  fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });
}

// Fetch .torrent file from public caches using info hash (fallback when peers are dead)
function fetchTorrentFromCache(infoHash) {
  return new Promise((resolve, reject) => {
    const hash = infoHash.toLowerCase().replace(/^urn:btih:/, "");
    const url = `https://itorrents.org/torrent/${hash}.torrent`;
    const httpModule = url.startsWith("https:") ? require("https") : require("http");
    const req = httpModule.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) {
          const redirModule = loc.startsWith("https:") ? require("https") : require("http");
          const redir = redirModule.get(loc, { timeout: 15000 }, (r2) => {
            const chunks = [];
            r2.on("data", c => chunks.push(c));
            r2.on("end", () => resolve(Buffer.concat(chunks)));
          }).on("error", reject);
          redir.on("timeout", () => { redir.destroy(); reject(new Error("Redirect timeout")); });
          return;
        }
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

// Build a clean file list from WebTorrent file objects, with retry if not yet populated
function buildFileList(t, displayName) {
  const rawFiles = t.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    console.warn(`[RO^JO] ${displayName || t.name}: t.files is empty on metadata, retrying in 100ms`);
    return null;
  }
  const list = rawFiles.map((f, i) => {
    let name = f.name;
    // Coerce Buffer/object to string
    if (name != null && typeof name !== "string") {
      try { name = name.toString(); } catch (e) { name = ""; }
    }
    let filePath = f.path;
    if (filePath != null && typeof filePath !== "string") {
      try { filePath = filePath.toString(); } catch (e) { filePath = ""; }
    }
    if (!name && filePath) {
      try { name = path.basename(filePath); } catch (e) {}
    }
    if (!name) name = `File ${i + 1}`;
    return {
      index: i,
      name: String(name),
      path: String(filePath || ""),
      length: Number(f.length || 0),
    };
  });
  console.log(`[RO^JO] Built fileList for ${displayName || t.name}: ${list.length} files`);
  return list;
}

// ---------- Malware Scanner (pre-download heuristics + post-download ClamAV) ----------
const SUSPICIOUS_EXTS = [".exe", ".msi", ".bat", ".cmd", ".vbs", ".js", ".scr", ".pif", ".com", ".jar", ".ps1", ".reg", ".docm", ".xlsm", ".pptm", ".dll", ".sys", ".inf"];
const DOUBLE_EXT_RE = /\.[a-z0-9]{2,6}\.(exe|msi|bat|cmd|vbs|js|scr|pif|com|jar|ps1|reg|docm|xlsm|pptm)$/i;
const SUSPICIOUS_NAME_RE = /\b(crack|keygen|patch|serial|activator|hack|cheat|trojan|virus|malware|backdoor|rootkit|worm|spyware)\b/i;

function scanFileListForMalware(fileList, torrentName) {
  const warnings = [];
  const riskyFiles = [];
  let hasExe = false;
  let mediaCount = 0;

  for (const f of fileList) {
    const lowerName = f.name.toLowerCase();
    const ext = path.extname(lowerName);
    const base = path.basename(lowerName, ext);

    // Double extension trick (e.g. movie.mp4.exe)
    if (DOUBLE_EXT_RE.test(lowerName)) {
      warnings.push(`"${f.name}" has a double extension — possible executable disguised as media`);
      riskyFiles.push(f.name);
      continue;
    }

    // Suspicious extensions
    if (SUSPICIOUS_EXTS.includes(ext)) {
      warnings.push(`"${f.name}" is an executable/script file (${ext})`);
      riskyFiles.push(f.name);
      if ([".exe", ".msi", ".dmg", ".pkg", ".app"].includes(ext)) hasExe = true;
      continue;
    }

    // Suspicious names
    if (SUSPICIOUS_NAME_RE.test(lowerName)) {
      warnings.push(`"${f.name}" contains suspicious keywords`);
      riskyFiles.push(f.name);
      continue;
    }

    // Count media files to flag executables inside media torrents
    if ([".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".epub", ".pdf", ".zip", ".rar", ".7z"].includes(ext)) {
      mediaCount++;
    }
  }

  // If torrent looks like media but contains executables
  if (hasExe && mediaCount > 0) {
    warnings.unshift("This torrent contains executables alongside media files — strongly suspicious");
  }

  return {
    safe: warnings.length === 0,
    warnings,
    riskyFiles,
  };
}

function doShowFilePicker(t, fileList, displayName, downloadPath, magnetUri, torrentFilePath = null) {
  const scanResults = scanFileListForMalware(fileList, displayName || t.name);
  pendingFileSelection.set(t.infoHash, {
    torrent: t,
    displayName: displayName || t.name,
    downloadPath,
    magnetUri,
    torrentFilePath,
    fileList,
    scanResults,
  });
  console.log(`[RO^JO] Broadcasting file picker for ${displayName || t.name} with ${fileList.length} files`);
  broadcast("show-file-picker", {
    infoHash: t.infoHash,
    name: displayName || t.name,
    fileList,
    scanResults,
  });
}

// ---------- HTTP Download Manager ----------
const HTTP_DOWNLOADS_STATE_PATH = path.join(app.getPath("userData"), "rojo-http-downloads.json");
const SCHEDULED_DOWNLOADS_PATH = path.join(app.getPath("userData"), "rojo-scheduled.json");

const httpDownloads = new Map(); // id -> download state
let httpDownloadIdCounter = 1;

function loadHttpDownloadsState() {
  try {
    if (fs.existsSync(HTTP_DOWNLOADS_STATE_PATH)) {
      const data = JSON.parse(fs.readFileSync(HTTP_DOWNLOADS_STATE_PATH, "utf8"));
      for (const d of data) {
        if (d.status === "downloading") d.status = "paused"; // resume manually
        httpDownloads.set(d.id, d);
      }
      httpDownloadIdCounter = data.length ? Math.max(...data.map(d => d.id)) + 1 : 1;
      console.log(`[RO^JO] Loaded ${data.length} HTTP downloads from state`);
    }
  } catch (e) {
    console.error("[RO^JO] Failed to load HTTP downloads state:", e.message);
  }
}

function saveHttpDownloadsState() {
  try {
    const list = Array.from(httpDownloads.values());
    fs.writeFileSync(HTTP_DOWNLOADS_STATE_PATH, JSON.stringify(list), "utf8");
  } catch (e) {
    console.error("[RO^JO] Failed to save HTTP downloads state:", e.message);
  }
}

function broadcastHttpDownloads() {
  const list = Array.from(httpDownloads.values()).map(d => ({
    id: d.id,
    name: d.name,
    url: d.url,
    status: d.status,
    progress: d.total > 0 ? (d.downloaded / d.total) : 0,
    speed: d.speed || 0,
    peers: 0,
    downloaded: d.downloaded || 0,
    length: d.total || 0,
    path: d.filePath,
    addedAt: d.addedAt,
    type: "http",
    fileList: d.filePath ? [{ index: 0, name: d.name, path: d.filePath, length: d.total || 0 }] : null,
  }));
  broadcast("http-downloads-updated", list);
}

function startHttpDownload(url, targetPath, scheduled = false, existingId = null) {
  return new Promise((resolve) => {
    const id = existingId || httpDownloadIdCounter++;
    const fileName = path.basename(new URL(url).pathname) || `download-${id}`;
    const filePath = path.join(targetPath || DEFAULT_DOWNLOAD_DIR, fileName);
    const partPath = filePath + ".part";

    let download = httpDownloads.get(id);
    if (!download) {
      download = {
        id,
        url,
        filePath,
        partPath,
        name: fileName,
        status: "downloading",
        downloaded: 0,
        total: 0,
        speed: 0,
        addedAt: Date.now(),
        _req: null,
        _lastChunkTime: Date.now(),
        _chunks: [],
      };
      httpDownloads.set(id, download);
    } else {
      // Reuse existing entry but reset status
      download.status = "downloading";
      download.error = null;
      download.speed = 0;
    }

    // Check for existing partial file
    let startByte = 0;
    try {
      if (fs.existsSync(partPath)) {
        const stats = fs.statSync(partPath);
        startByte = stats.size;
        download.downloaded = startByte;
      }
    } catch (e) {}

    const parsedUrl = new URL(url);
    const httpModule = parsedUrl.protocol === "https:" ? require("https") : require("http");
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: {
        "Range": `bytes=${startByte}-`,
        "User-Agent": "Rojo/1.0",
      },
      timeout: 30000,
    };

    const req = httpModule.request(options, (res) => {
      download._req = req;

      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) {
          httpDownloads.delete(id);
          return resolve(startHttpDownload(loc, targetPath, scheduled));
        }
      }

      if (res.statusCode !== 200 && res.statusCode !== 206) {
        download.status = "error";
        download.error = `HTTP ${res.statusCode}`;
        saveHttpDownloadsState();
        broadcastHttpDownloads();
        return resolve({ ok: false, id, error: `HTTP ${res.statusCode}` });
      }

      // Parse total size from Content-Length or Content-Range
      const contentLength = res.headers["content-length"];
      const contentRange = res.headers["content-range"];
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)/);
        if (match) download.total = parseInt(match[1], 10);
      } else if (contentLength) {
        const len = parseInt(contentLength, 10);
        download.total = startByte + len;
      }

      const outStream = fs.createWriteStream(partPath, { flags: startByte > 0 ? "a" : "w" });
      let lastReport = Date.now();
      let lastDownloaded = startByte;

      res.on("data", (chunk) => {
        if (download.status !== "downloading") {
          req.destroy();
          return;
        }
        outStream.write(chunk);
        download.downloaded += chunk.length;
        download._lastChunkTime = Date.now();

        const now = Date.now();
        if (now - lastReport >= 1000) {
          const elapsed = (now - lastReport) / 1000;
          download.speed = Math.max(0, Math.round((download.downloaded - lastDownloaded) / elapsed));
          lastDownloaded = download.downloaded;
          lastReport = now;
          broadcastHttpDownloads();
        }
      });

      res.on("end", () => {
        outStream.end();
        if (download.status === "downloading") {
          download.status = "completed";
          download.speed = 0;
          download.progress = 1;
          // Rename .part to final name
          try {
            fs.renameSync(partPath, filePath);
          } catch (e) {
            console.error(`[RO^JO] Failed to rename part file: ${e.message}`);
          }
          console.log(`[RO^JO] HTTP download completed: ${fileName}`);
        }
        saveHttpDownloadsState();
        broadcastHttpDownloads();
        resolve({ ok: true, id, filePath });
      });

      res.on("error", (err) => {
        outStream.end();
        download.status = "error";
        download.error = err.message;
        saveHttpDownloadsState();
        broadcastHttpDownloads();
        resolve({ ok: false, id, error: err.message });
      });
    });

    req.on("error", (err) => {
      download.status = "error";
      download.error = err.message;
      saveHttpDownloadsState();
      broadcastHttpDownloads();
      resolve({ ok: false, id, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      download.status = "error";
      download.error = "Request timeout";
      saveHttpDownloadsState();
      broadcastHttpDownloads();
      resolve({ ok: false, id, error: "Request timeout" });
    });

    req.end();
    saveHttpDownloadsState();
    broadcastHttpDownloads();
    if (!scheduled) {
      resolve({ ok: true, id });
    }
  });
}

function pauseHttpDownload(id) {
  const d = httpDownloads.get(id);
  if (!d) return { ok: false, error: "Download not found" };
  if (d.status !== "downloading") return { ok: false, error: "Not downloading" };
  d.status = "paused";
  d.speed = 0;
  if (d._req) {
    try { d._req.destroy(); } catch (e) {}
    d._req = null;
  }
  saveHttpDownloadsState();
  broadcastHttpDownloads();
  return { ok: true };
}

function resumeHttpDownload(id) {
  const d = httpDownloads.get(id);
  if (!d) return { ok: false, error: "Download not found" };
  if (d.status !== "paused" && d.status !== "error") return { ok: false, error: "Cannot resume" };
  d.status = "downloading";
  d.error = null;
  saveHttpDownloadsState();
  broadcastHttpDownloads();
  startHttpDownload(d.url, path.dirname(d.filePath), false, id);
  return { ok: true };
}

function removeHttpDownload(id, deleteFiles = false) {
  const d = httpDownloads.get(id);
  if (!d) return { ok: false, error: "Download not found" };
  if (d._req) {
    try { d._req.destroy(); } catch (e) {}
  }
  if (deleteFiles) {
    try { if (fs.existsSync(d.partPath)) fs.unlinkSync(d.partPath); } catch (e) {}
    try { if (fs.existsSync(d.filePath)) fs.unlinkSync(d.filePath); } catch (e) {}
  }
  httpDownloads.delete(id);
  saveHttpDownloadsState();
  broadcastHttpDownloads();
  broadcast("http-download-removed", { id });
  return { ok: true };
}

// ---------- Schedule Manager ----------
let scheduledDownloads = [];
let scheduleCheckInterval = null;

function loadScheduledDownloads() {
  try {
    if (fs.existsSync(SCHEDULED_DOWNLOADS_PATH)) {
      scheduledDownloads = JSON.parse(fs.readFileSync(SCHEDULED_DOWNLOADS_PATH, "utf8"));
      // Remove past scheduled items
      const now = Date.now();
      scheduledDownloads = scheduledDownloads.filter(s => s.scheduledTime > now);
      console.log(`[RO^JO] Loaded ${scheduledDownloads.length} scheduled downloads`);
    }
  } catch (e) {
    console.error("[RO^JO] Failed to load scheduled downloads:", e.message);
  }
}

function saveScheduledDownloads() {
  try {
    fs.writeFileSync(SCHEDULED_DOWNLOADS_PATH, JSON.stringify(scheduledDownloads), "utf8");
  } catch (e) {
    console.error("[RO^JO] Failed to save scheduled downloads:", e.message);
  }
}

function scheduleDownload(url, targetPath, scheduledTime) {
  const id = Date.now() + Math.random().toString(36).slice(2);
  const item = { id, url, targetPath: targetPath || DEFAULT_DOWNLOAD_DIR, scheduledTime, createdAt: Date.now() };
  scheduledDownloads.push(item);
  saveScheduledDownloads();
  broadcastScheduledDownloads();
  return { ok: true, id };
}

function cancelScheduledDownload(id) {
  scheduledDownloads = scheduledDownloads.filter(s => s.id !== id);
  saveScheduledDownloads();
  broadcastScheduledDownloads();
  return { ok: true };
}

function broadcastScheduledDownloads() {
  broadcast("scheduled-downloads-updated", scheduledDownloads);
}

function startScheduleChecker() {
  if (scheduleCheckInterval) clearInterval(scheduleCheckInterval);
  scheduleCheckInterval = setInterval(() => {
    const now = Date.now();
    const due = scheduledDownloads.filter(s => s.scheduledTime <= now);
    for (const item of due) {
      console.log(`[RO^JO] Starting scheduled download: ${item.url}`);
      startHttpDownload(item.url, item.targetPath, true);
    }
    if (due.length > 0) {
      scheduledDownloads = scheduledDownloads.filter(s => s.scheduledTime > now);
      saveScheduledDownloads();
      broadcastScheduledDownloads();
    }
  }, 30000); // check every 30 seconds
}

// Pre-configured optimal settings (DHT/uTP disabled to avoid native crashes)
const ROJO_CONFIG = {
  dht: false,
  tracker: true,
  webSeeds: false,
  maxConns: 30,
  utp: false,
  defaultDownloadPath: DEFAULT_DOWNLOAD_DIR,
  // Comprehensive tracker list for best peer discovery
  announce: [
    // UDP trackers (fastest)
    "udp://tracker.opentrackr.org:1337",
    "udp://tracker.openbittorrent.com:80",
    "udp://opentracker.i2p.rocks:6969",
    "udp://tracker.torrent.eu.org:451",
    "udp://open.stealth.si:80",
    "udp://tracker.tiny-vps.com:6969",
    "udp://tracker.moeking.me:6969",
    "udp://tracker-udp.gbitt.info:80",
    "udp://tracker.0x.tf:1337",
    "udp://p4p.arenabg.com:1337",
    "udp://exodus.desync.com:6969",
    "udp://9.rarbg.com:2810",
    "udp://opentor.net:6969",
    // HTTP trackers
    "http://tracker.opentrackr.org:1337/announce",
    "http://tracker.openbittorrent.com:80/announce",
    "http://tracker.gbitt.info:80/announce",
    "http://bt.okmp.org:2710/announce",
    // WebTorrent / WSS trackers
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.files.fm:7073",
  ],
};

// USB/external drive throttle: 1.5 MB/s download limit to prevent I/O freeze
const EXTERNAL_DRIVE_DL_LIMIT = 1.5 * 1024 * 1024; // bytes/sec

let win;
let tray;
let client;
const activeTorrents = new Map();
const pendingFileSelection = new Map(); // infoHash -> { torrent, displayName, downloadPath, magnetUri?, torrentFilePath? }
let isMinimized = false;
let isQuitting = false;
let restartStatsLoop = null; // called when window is recreated after being closed

// Store last used download path
let lastDownloadPath = DEFAULT_DOWNLOAD_DIR;

// Torrent state persistence
const TORRENTS_STATE_PATH = path.join(app.getPath("userData"), "rojo-torrents.json");
const TORRENTS_FILES_DIR = path.join(app.getPath("userData"), "torrents");
if (!fs.existsSync(TORRENTS_FILES_DIR)) fs.mkdirSync(TORRENTS_FILES_DIR, { recursive: true });

// Torrent history log (like browser history — for re-adding)
const TORRENTS_HISTORY_PATH = path.join(app.getPath("userData"), "rojo-history.json");
const MAX_HISTORY_ENTRIES = 200;

function loadTorrentHistory() {
  try {
    if (fs.existsSync(TORRENTS_HISTORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(TORRENTS_HISTORY_PATH, "utf8"));
      if (Array.isArray(data)) return data;
    }
  } catch (e) {
    console.error("[RO^JO] Failed to load torrent history:", e.message);
  }
  return [];
}

function saveTorrentHistory(history) {
  try {
    fs.writeFileSync(TORRENTS_HISTORY_PATH, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error("[RO^JO] Failed to save torrent history:", e.message);
  }
}

function addTorrentToHistory(entry) {
  if (!entry || !entry.magnetUri) return;
  const history = loadTorrentHistory();
  // Remove duplicate by magnet URI (keep newest)
  const filtered = history.filter((h) => h.magnetUri !== entry.magnetUri);
  filtered.unshift({
    name: entry.name || "Unknown",
    magnetUri: entry.magnetUri,
    infoHash: entry.infoHash || "",
    addedAt: entry.addedAt || Date.now(),
  });
  // Trim to max
  if (filtered.length > MAX_HISTORY_ENTRIES) filtered.length = MAX_HISTORY_ENTRIES;
  saveTorrentHistory(filtered);
}

function getTorrentHistory() {
  return loadTorrentHistory();
}

function clearTorrentHistory() {
  try {
    if (fs.existsSync(TORRENTS_HISTORY_PATH)) fs.unlinkSync(TORRENTS_HISTORY_PATH);
  } catch (e) {
    console.error("[RO^JO] Failed to clear torrent history:", e.message);
  }
  return { ok: true };
}

function formatSpeedBadge(bps) {
  if (!bps || bps === 0) return "";
  const k = 1024;
  if (bps < k) return Math.round(bps) + "B";
  if (bps < k * k) return Math.round(bps / k) + "K";
  if (bps < k * k * k) return Math.round(bps / (k * k)) + "M";
  return Math.round(bps / (k * k * k)) + "G";
}

function formatSpeed(bps) {
  if (!bps || bps === 0) return "0 B/s";
  const k = 1024;
  if (bps < k) return Math.round(bps) + " B/s";
  if (bps < k * k) return (bps / k).toFixed(1).replace(/\.0$/, "") + " KB/s";
  if (bps < k * k * k) return (bps / (k * k)).toFixed(1).replace(/\.0$/, "") + " MB/s";
  return (bps / (k * k * k)).toFixed(1).replace(/\.0$/, "") + " GB/s";
}

function saveTorrentsState() {
  try {
    const list = Array.from(activeTorrents.values());
    fs.writeFileSync(TORRENTS_STATE_PATH, JSON.stringify(list, null, 2), "utf8");
    console.log(`[RO^JO] Saved ${list.length} torrents to state file`);
  } catch (e) {
    console.error("[RO^JO] Failed to save torrents state:", e.message);
  }
}

async function restoreTorrents() {
  try {
    if (!fs.existsSync(TORRENTS_STATE_PATH)) return;
    const text = fs.readFileSync(TORRENTS_STATE_PATH, "utf8");
    if (!text.trim()) return;
    const list = JSON.parse(text);
    if (!Array.isArray(list) || list.length === 0) return;
    console.log(`[RO^JO] Restoring ${list.length} torrents from state file`);

    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry.infoHash) continue;

      // Skip if already in client (duplicate protection)
      if (client.torrents.some(t => t.infoHash === entry.infoHash)) {
        console.log(`[RO^JO] Skipping duplicate restore: ${entry.name}`);
        activeTorrents.set(entry.infoHash, entry);
        continue;
      }

      // Try to re-add to WebTorrent client; only add to activeTorrents on success
      if (entry.magnetUri) {
        try {
          client.add(entry.magnetUri, {
            path: entry.path ? path.dirname(entry.path) : DEFAULT_DOWNLOAD_DIR,
            announce: ROJO_CONFIG.announce,
          });
          activeTorrents.set(entry.infoHash, entry);
          console.log(`[RO^JO] Re-added magnet torrent: ${entry.name}`);
        } catch (e) {
          console.error(`[RO^JO] Failed to re-add magnet torrent ${entry.name}:`, e.message);
        }
      } else if (entry.torrentFilePath && fs.existsSync(entry.torrentFilePath)) {
        try {
          const buf = fs.readFileSync(entry.torrentFilePath);
          client.add(buf, {
            path: entry.path ? path.dirname(entry.path) : DEFAULT_DOWNLOAD_DIR,
            announce: ROJO_CONFIG.announce,
          });
          activeTorrents.set(entry.infoHash, entry);
          console.log(`[RO^JO] Re-added .torrent file: ${entry.name}`);
        } catch (e) {
          console.error(`[RO^JO] Failed to re-add .torrent ${entry.name}:`, e.message);
        }
      }

      // Stagger restores to avoid overwhelming the client (500ms between each)
      if (i < list.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (e) {
    console.error("[RO^JO] Failed to restore torrents:", e.message);
  }
}

function updateDockBadge(bestProgress = 0, totalDl = 0, totalUl = 0) {
  if (!win || win.isDestroyed()) return;
  if (!isMinimized) {
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge("");
    }
    win.setProgressBar(-1);
    return;
  }

  // Badge shows down/up speeds (macOS dock badge is very small — keep it compact)
  if (process.platform === "darwin" && app.dock) {
    const dl = formatSpeedBadge(totalDl);
    const ul = formatSpeedBadge(totalUl);
    let badge = "";
    if (dl) badge += dl;
    if (ul) badge += (badge ? "/" : "") + ul;
    app.dock.setBadge(badge || "");
  }

  // Progress bar under dock/taskbar icon
  if (client && client.torrents.length > 0) {
    win.setProgressBar(bestProgress, { mode: bestProgress >= 1 ? "normal" : "normal" });
  } else {
    win.setProgressBar(-1);
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1138,
    height: 625,
    minWidth: 850,
    minHeight: 600,
    frame: false,
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
    backgroundColor: "#0f1115",
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.once("ready-to-show", () => {
    win.show();
    // If window was recreated after being closed, restart stats broadcast immediately
    if (restartStatsLoop) restartStatsLoop();
  });

  win.on("minimize", () => {
    isMinimized = true;
    updateDockBadge();
  });

  win.on("restore", () => {
    isMinimized = false;
    updateDockBadge();
  });

  win.on("closed", () => {
    win = null;
    app.quit();
  });

  // Handle dropped files
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("magnet:")) {
      e.preventDefault();
      handleAddMagnet(url);
    }
  });
}

function createTray() {
  if (tray) return;

  try {
    const pngPath = path.join(process.resourcesPath, "assets", "icon.png");
    const fallbackPath = path.join(__dirname, "..", "assets", "icon.png");
    let iconPath = fs.existsSync(pngPath) ? pngPath : (fs.existsSync(fallbackPath) ? fallbackPath : null);

    if (!iconPath) {
      console.error("[RO^JO] No icon found for tray");
      return;
    }

    const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.setToolTip("Rojo");
    console.log("[RO^JO] Tray created");

    const buildContextMenu = () => {
      const { Menu } = require("electron");
      return Menu.buildFromTemplate([
        { label: "Show Rojo", click: () => showFromTray() },
        { type: "separator" },
        { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
      ]);
    };
    tray.setContextMenu(buildContextMenu());

    tray.on("click", () => showFromTray());
  } catch (e) {
    console.error("[RO^JO] Tray creation failed:", e);
  }
}

function minimizeToTray() {
  if (win && !win.isDestroyed()) {
    win.hide();
  }
  // On macOS, switch to accessory mode (no dock icon, menu bar only)
  if (process.platform === "darwin" && app.setActivationPolicy) {
    app.setActivationPolicy("accessory");
  }
}

function showFromTray() {
  if (win) {
    if (win.isVisible() && !win.isMinimized()) {
      win.minimize();
    } else {
      win.show();
      win.restore();
      win.focus();
    }
  } else {
    createWindow();
  }
  // On macOS, switch back to regular mode (dock icon visible)
  if (process.platform === "darwin" && app.setActivationPolicy) {
    app.setActivationPolicy("regular");
  }
}

// ---------- Download Path Selection ----------

function isExternalDrive(downloadPath) {
  if (process.platform === "darwin") {
    return downloadPath.startsWith("/Volumes/");
  }
  if (process.platform === "win32") {
    const drive = downloadPath.split(":")[0].toUpperCase();
    return drive !== "C";
  }
  return false;
}

async function selectDownloadPath(defaultPath) {
  const result = await dialog.showOpenDialog(win, {
    defaultPath: defaultPath || lastDownloadPath,
    properties: ["openDirectory", "createDirectory"],
    message: "Select download folder for this torrent",
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = result.filePaths[0];
  if (isExternalDrive(selectedPath)) {
    broadcast("show-toast", { message: "External drive detected. Peer connections limited to prevent freezing.", type: "warning" });
    console.log(`[RO^JO] External drive selected: ${selectedPath}, will limit peers`);
  }
  lastDownloadPath = selectedPath;
  return selectedPath;
}

// ---------- WebTorrent ----------

async function initWebTorrent() {
  const wt = await import("webtorrent");
  const WebTorrent = wt.default || wt.WebTorrent || wt;

  client = new WebTorrent({
    dht: ROJO_CONFIG.dht,
    tracker: ROJO_CONFIG.tracker,
    webSeeds: ROJO_CONFIG.webSeeds,
    maxConns: ROJO_CONFIG.maxConns,
    utp: ROJO_CONFIG.utp,
  });

  client.on("error", (err) => {
    console.error("[WebTorrent] client error:", err.message);
    broadcast("torrent-error", err.message);
  });

  // Periodically broadcast stats to renderer (adaptive interval: 2-4s)
  let statsRunning = false;
  let lastHash = 0;
  async function statsLoop() {
    if (statsRunning) return;
    statsRunning = true;
    while (client && !isQuitting) {
      try {
        const list = [];
        let bestProgress = 0;
        let totalDl = 0;
        let totalUl = 0;
        for (const t of client.torrents) {
          let entry = activeTorrents.get(t.infoHash);
          if (!entry) {
            entry = {
              name: t.name,
              infoHash: t.infoHash,
              progress: t.progress || 0,
              speed: t.downloadSpeed || 0,
              uploadSpeed: t.uploadSpeed || 0,
              peers: t.numPeers || 0,
              status: t.done ? "completed" : "downloading",
              path: t.path || "",
              addedAt: Date.now(),
              downloaded: t.downloaded || 0,
              uploaded: t.uploaded || 0,
              length: t.length || 0,
              timeRemaining: t.timeRemaining || 0,
              ratio: t.downloaded > 0 ? (t.uploaded || 0) / t.downloaded : 0,
              fileList: null,
            };
            activeTorrents.set(t.infoHash, entry);
          }
          if (!entry.fileList && t.files && t.files.length > 0) {
            entry.fileList = buildFileList(t, entry.name);
          }
          const isPaused = entry.status === "paused";
          if (isPaused && entry._frozenDownloaded !== undefined) {
            entry.progress = entry._frozenProgress;
            entry.speed = 0;
            entry.uploadSpeed = 0;
            entry.downloaded = entry._frozenDownloaded;
            entry.uploaded = entry._frozenUploaded;
            entry.ratio = entry._frozenDownloaded > 0 ? entry._frozenUploaded / entry._frozenDownloaded : 0;
          } else {
            entry.progress = t.progress;
            entry.speed = t.downloadSpeed;
            entry.uploadSpeed = t.uploadSpeed;
            entry.downloaded = t.downloaded;
            entry.uploaded = t.uploaded || 0;
            entry.ratio = t.downloaded > 0 ? (t.uploaded || 0) / t.downloaded : 0;
          }
          entry.peers = t.numPeers;
          entry.length = t.length;
          entry.timeRemaining = t.timeRemaining || 0;
          if (t.done) entry.status = "completed";

          // Round values to reduce jitter-induced re-renders
          const speed = Math.round((entry.speed || 0) / 1024) * 1024;
          const uploadSpeed = Math.round((entry.uploadSpeed || 0) / 1024) * 1024;
          const progress = Math.round((entry.progress || 0) * 1000) / 1000;

          list.push({
            name: entry.name,
            infoHash: entry.infoHash,
            progress,
            speed,
            uploadSpeed,
            peers: entry.peers,
            status: entry.status,
            path: entry.path,
            addedAt: entry.addedAt,
            downloaded: entry.downloaded,
            uploaded: entry.uploaded,
            length: entry.length,
            timeRemaining: entry.timeRemaining,
            ratio: entry.ratio,
            fileList: entry.fileList,
          });

          totalDl += entry.speed;
          totalUl += entry.uploadSpeed;
          if (entry.progress > bestProgress) bestProgress = entry.progress;
        }

        const dlSpeed = Math.round((client.downloadSpeed || 0) / 1024) * 1024;
        const ulSpeed = Math.round((client.uploadSpeed || 0) / 1024) * 1024;

        // Lightweight hash dedup (cheaper than JSON.stringify)
        let hash = 0;
        for (const t of list) {
          hash = ((hash << 5) - hash + t.infoHash.charCodeAt(0)) | 0;
          hash = ((hash << 5) - hash + (t.progress * 1000) | 0) | 0;
          hash = ((hash << 5) - hash + (t.speed / 1024) | 0) | 0;
          hash = ((hash << 5) - hash + t.peers) | 0;
        }
        hash = ((hash << 5) - hash + (dlSpeed / 1024) | 0) | 0;
        hash = ((hash << 5) - hash + (ulSpeed / 1024) | 0) | 0;

        // VPN state for diagnostics
        const vpnState = vpn ? vpn.getTunnelState() : { active: false };

        if (hash !== lastHash) {
          lastHash = hash;
          if (win && !win.isDestroyed()) {
            broadcast("torrents-updated", { torrents: list, downloadSpeed: dlSpeed, uploadSpeed: ulSpeed, vpnActive: vpnState.active });
            // Only update dock badge when window is minimized to save CPU
            if (isMinimized) {
              updateDockBadge(bestProgress, totalDl, totalUl);
            }
          }
        }
        await checkStopRatios();

        // Tracker diagnostics: log when torrents have 0 peers for extended time, auto-reannounce at 30s
        for (const t of client.torrents) {
          if (t.numPeers === 0 && !t.done) {
            const trackerErrors = t._trackerErrors || 0;
            t._trackerErrors = trackerErrors + 1;
            if (t._trackerErrors === 5) {
              const trackerCount = t._trackers ? Object.keys(t._trackers).length : 0;
              console.warn(`[RO^JO] ${t.name}: stuck at 0 peers for ~10s. VPN=${vpnState.active ? 'on' : 'off'} trackers=${trackerCount}`);
            }
            if (t._trackerErrors === 15 && t.discover) {
              console.warn(`[RO^JO] ${t.name}: auto-reannouncing to trackers after 30s with 0 peers`);
              try { t.discover(); } catch (e) {}
            }
          } else {
            t._trackerErrors = 0;
          }
        }

        // Log memory every 30 iterations
        statsLoop.counter = (statsLoop.counter || 0) + 1;
        if (statsLoop.counter % 30 === 0) {
          const mem = process.memoryUsage();
          console.log(`[RO^JO] mem rss=${(mem.rss/1048576).toFixed(1)}MB heap=${(mem.heapUsed/1048576).toFixed(1)}MB torrents=${client.torrents.length} vpn=${vpnState.active ? 'on' : 'off'}`);
        }
      } catch (err) {
        console.error("[RO^JO] statsLoop error:", err.message);
      }
      // Adaptive interval: slower when idle (4s), faster when active (1-2s)
      const anyActivity = client.downloadSpeed > 0 || client.uploadSpeed > 0;
      const interval = anyActivity ? 2000 : 4000;
      await new Promise(r => setTimeout(r, interval));
    }
    statsRunning = false;
  }
  statsLoop();
  restartStatsLoop = statsLoop;
}

function extractInfoHashFromMagnet(magnetUri) {
  try {
    const match = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
    if (match) return match[1].toLowerCase();
  } catch (e) {}
  return null;
}

async function handleAddMagnet(magnetUri) {
  if (!client) return { ok: false, error: "Engine not ready" };

  try {
    const downloadPath = await selectDownloadPath();
    if (!downloadPath) return { ok: false, error: "Download path not selected" };

    // Extract display name from magnet URI so we can show the human-readable name
    let displayName;
    try {
      const url = new URL(magnetUri);
      displayName = url.searchParams.get("dn");
      if (displayName) displayName = decodeURIComponent(displayName).replace(/\+/g, " ");
    } catch (e) { /* ignore malformed URIs */ }

    const newInfoHash = extractInfoHashFromMagnet(magnetUri);

    // debug: console.log(`[RO^JO] handleAddMagnet: path=${downloadPath}, displayName=${displayName || "N/A"}`);

    // Check if torrent already exists in activeTorrents (duplicate check)
    if (newInfoHash) {
      for (const [infoHash, entry] of activeTorrents) {
        if (infoHash.toLowerCase() === newInfoHash) {
          return {
            ok: false,
            duplicate: true,
            infoHash: infoHash,
            name: entry.name,
            error: "This torrent is already in your download list"
          };
        }
      }
    }

    // Check if torrent already exists in client (from previous failed add)
    const existingTorrent = newInfoHash ? client.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === newInfoHash) : null;
    if (existingTorrent) {
      // debug: already in client
      // If it's in client but not in activeTorrents, re-add it to the map
      if (!activeTorrents.has(existingTorrent.infoHash)) {
        // debug: re-adding to activeTorrents
        const actualPath = path.join(downloadPath, existingTorrent.name);
        activeTorrents.set(existingTorrent.infoHash, {
          name: displayName || existingTorrent.name,
          infoHash: existingTorrent.infoHash,
          progress: existingTorrent.progress || 0,
          speed: existingTorrent.downloadSpeed || 0,
          peers: existingTorrent.numPeers || 0,
          status: existingTorrent.done ? "completed" : "downloading",
          path: actualPath,
          addedAt: Date.now(),
          downloaded: existingTorrent.downloaded || 0,
          length: existingTorrent.length || 0,
        });
        addTorrentToHistory({
          name: displayName || existingTorrent.name,
          magnetUri: magnetUri,
          infoHash: existingTorrent.infoHash,
          addedAt: Date.now(),
        });
        return { ok: true, infoHash: existingTorrent.infoHash, name: displayName || existingTorrent.name };
      } else {
        // debug: already in activeTorrents
        const entry = activeTorrents.get(existingTorrent.infoHash);
        return {
          ok: false,
          duplicate: true,
          infoHash: existingTorrent.infoHash,
          name: entry ? entry.name : existingTorrent.name,
          error: "This torrent is already in your download list"
        };
      }
    }

    const TEMP_PENDING_DIR = path.join(os.tmpdir(), "rojo-pending");
    fs.mkdirSync(TEMP_PENDING_DIR, { recursive: true });

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        // Multi-file torrents: add to temp path first to avoid USB freeze during file picker
        const isMultiFile = true; // We don't know yet; use temp for all and check in callback
        const addPath = isMultiFile ? TEMP_PENDING_DIR : downloadPath;
        torrent = client.add(magnetUri, {
          path: addPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          // debug: metadata received
          // Deselect all files initially, then show file picker
          t.files.forEach(f => f.deselect());

          // If single file, move to real path and add immediately
          if (t.files.length <= 1) {
            if (t.files[0]) t.files[0].select();
            const realName = t.name || displayName || "Unknown";
            const realInfoHash = t.infoHash;
            const realLength = t.length || 0;
            const actualPath = path.join(downloadPath, realName);
            // For single file we used temp path; remove and re-add with real path
            client.remove(t, {}, () => {
              const actualTorrent = client.add(magnetUri, {
                path: downloadPath,
                announce: ROJO_CONFIG.announce,
              }, (realT) => {
                if (realT.files[0]) realT.files[0].select();
              });

              // Wire listeners to the REAL torrent, not the destroyed temp one
              actualTorrent.on("error", (err) => {
                console.error(`[RO^JO] Torrent error:`, err.message);
                if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
              });
              actualTorrent.on("warning", (err) => {
                console.warn(`[RO^JO] ${actualTorrent.name || "torrent"} tracker warning:`, err.message);
              });
              actualTorrent.on("wire", (wire) => {
                console.log(`[RO^JO] ${actualTorrent.name}: peer connected (${wire.peerId || "unknown"})`);
                if (isExternalDrive(downloadPath) && actualTorrent.wires.length > 5) {
                  console.log(`[RO^JO] ${actualTorrent.name}: disconnecting excess peer (external drive limit)`);
                  wire.destroy();
                }
              });
              actualTorrent.on("noPeers", () => {
                console.warn(`[RO^JO] ${actualTorrent.name}: no peers found`);
              });
              actualTorrent.on("done", () => {
                const entry = activeTorrents.get(actualTorrent.infoHash);
                if (entry) entry.status = "completed";
                broadcast("torrent-completed", { infoHash: actualTorrent.infoHash, name: entry ? entry.name : actualTorrent.name });
              });

              activeTorrents.set(realInfoHash, {
                name: displayName || realName,
                infoHash: realInfoHash,
                progress: 0,
                speed: 0,
                peers: 0,
                status: "downloading",
                path: actualPath,
                addedAt: Date.now(),
                downloaded: 0,
                length: realLength,
                magnetUri: magnetUri,
              });
              addTorrentToHistory({
                name: displayName || realName,
                magnetUri: magnetUri,
                infoHash: realInfoHash,
                addedAt: Date.now(),
              });
              if (isExternalDrive(downloadPath)) {
                setTorrentThrottle(realInfoHash, EXTERNAL_DRIVE_DL_LIMIT, 0);
                broadcast("show-toast", { message: `External drive throttled to ${(EXTERNAL_DRIVE_DL_LIMIT / 1024 / 1024).toFixed(1)} MB/s to prevent freezing`, type: "warning" });
              }
              if (!responded) { responded = true; resolve({ ok: true, infoHash: realInfoHash, name: displayName || realName }); }
            });
            return;
          }

          // Multiple files: store in pending (still on temp path) and show file picker
          let fileList = buildFileList(t, displayName);
          if (!fileList) {
            setTimeout(() => {
              if (responded) return;
              fileList = buildFileList(t, displayName);
              if (!fileList) {
                console.error(`[RO^JO] ${displayName || t.name}: t.files still empty after retry, skipping file picker`);
                try { client.remove(t); } catch (e) {}
                if (!responded) { responded = true; resolve({ ok: false, error: "Failed to read torrent file list" }); }
                return;
              }
              doShowFilePicker(t, fileList, displayName, downloadPath, magnetUri);
              if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: displayName || t.name, filePicker: true }); }
            }, 100);
            return;
          }
          doShowFilePicker(t, fileList, displayName, downloadPath, magnetUri);
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: displayName || t.name, filePicker: true }); }
        });
        // debug: waiting for metadata
      } catch (err) {
        console.error(`[RO^JO] Error adding torrent to client:`, err.message);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        console.error(`[RO^JO] Torrent error:`, err.message);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
      });

      torrent.on("warning", (err) => {
        console.warn(`[RO^JO] ${torrent.name || "torrent"} tracker warning:`, err.message);
      });

      torrent.on("wire", (wire) => {
        console.log(`[RO^JO] ${torrent.name}: peer connected (${wire.peerId || "unknown"})`);
        // Limit peers for slow external drives to prevent I/O freeze
        if (isExternalDrive(torrent.path) && torrent.wires.length > 5) {
          console.log(`[RO^JO] ${torrent.name}: disconnecting excess peer (external drive limit)`);
          wire.destroy();
        }
      });

      torrent.on("noPeers", () => {
        console.warn(`[RO^JO] ${torrent.name}: no peers found`);
      });

      torrent.on("done", () => {
        const entry = activeTorrents.get(torrent.infoHash);
        if (entry) entry.status = "completed";
        broadcast("torrent-completed", { infoHash: torrent.infoHash, name: entry ? entry.name : torrent.name });
      });

      // Fallback: if no metadata after 25s, try fetching .torrent from web cache
      setTimeout(async () => {
        if (responded) return;
        console.warn(`[RO^JO] Metadata timeout approaching for ${displayName || "torrent"}. Trying web cache fallback...`);
        try {
          // Extract info hash from magnet URI
          const match = magnetUri.match(/btih:([a-fA-F0-9]{40})/i);
          if (match) {
            const infoHash = match[1];
            const buf = await fetchTorrentFromCache(infoHash);
            console.log(`[RO^JO] Fetched .torrent from cache for ${infoHash}, size=${buf.length}`);
            // Remove the magnet torrent and add the .torrent file instead
            try { client.remove(torrent); } catch (e) {}
            await handleAddTorrentFile(buf, downloadPath);
            responded = true;
            resolve({ ok: true, infoHash, name: displayName || "torrent", fromCache: true });
          }
        } catch (cacheErr) {
          console.warn(`[RO^JO] Web cache fallback failed:`, cacheErr.message);
        }
      }, 25000);

      // Hard timeout at 60s
      setTimeout(() => {
        if (!responded) {
          responded = true;
          resolve({ ok: false, error: "Timed out waiting for torrent metadata. No peers available and web cache failed. Your ISP may block BitTorrent traffic." });
        }
      }, 60000);
    });
  } catch (err) {
    console.error(`[RO^JO] handleAddMagnet error:`, err.message);
    return { ok: false, error: err.message };
  }
}

async function handleAddTorrentFile(buffer, downloadPath) {
  if (!client) return { ok: false, error: "Engine not ready" };
  // debug: handleAddTorrentFile

  try {
    if (!downloadPath) {
      downloadPath = await selectDownloadPath();
      if (!downloadPath) return { ok: false, error: "Download path not selected" };
    }
    // debug: downloadPath selected

    const TEMP_PENDING_DIR2 = path.join(os.tmpdir(), "rojo-pending");
    fs.mkdirSync(TEMP_PENDING_DIR2, { recursive: true });

    return new Promise((resolve) => {
      let responded = false;
      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          resolve({ ok: false, error: "Timed out waiting for torrent to be ready. The .torrent file may be corrupted." });
        }
      }, 30000);
      let torrent;
      try {
        torrent = client.add(buffer, {
          path: TEMP_PENDING_DIR2,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          // debug: torrent ready
          // Deselect all files initially
          t.files.forEach(f => f.deselect());

          // Save .torrent file buffer for persistence
          const torrentFilePath = path.join(TORRENTS_FILES_DIR, `${t.infoHash}.torrent`);
          try {
            fs.writeFileSync(torrentFilePath, Buffer.from(buffer));
          } catch (e) {
            console.error("[RO^JO] Failed to save .torrent file:", e.message);
          }

          // If single file, move to real path and add immediately
          if (t.files.length <= 1) {
            if (t.files[0]) t.files[0].select();
            const realName = t.name || "Unknown";
            const realInfoHash = t.infoHash;
            const realLength = t.length || 0;
            const actualPath = path.join(downloadPath, realName);
            client.remove(t, {}, () => {
              const actualTorrent = client.add(buffer, {
                path: downloadPath,
                announce: ROJO_CONFIG.announce,
              }, (realT) => {
                if (realT.files[0]) realT.files[0].select();
              });

              // Wire listeners to the REAL torrent
              actualTorrent.on("error", (err) => {
                if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
              });
              actualTorrent.on("warning", (err) => {
                console.warn(`[RO^JO] ${actualTorrent.name || "torrent"} tracker warning:`, err.message);
              });
              actualTorrent.on("wire", (wire) => {
                console.log(`[RO^JO] ${actualTorrent.name}: peer connected (${wire.peerId || "unknown"})`);
                if (isExternalDrive(downloadPath) && actualTorrent.wires.length > 5) {
                  console.log(`[RO^JO] ${actualTorrent.name}: disconnecting excess peer (external drive limit)`);
                  wire.destroy();
                }
              });
              actualTorrent.on("noPeers", () => {
                console.warn(`[RO^JO] ${actualTorrent.name}: no peers found`);
              });
              actualTorrent.on("done", () => {
                const entry = activeTorrents.get(actualTorrent.infoHash);
                if (entry) entry.status = "completed";
                broadcast("torrent-completed", { infoHash: actualTorrent.infoHash, name: entry ? entry.name : actualTorrent.name });
              });

              activeTorrents.set(realInfoHash, {
                name: realName,
                infoHash: realInfoHash,
                progress: 0,
                speed: 0,
                peers: 0,
                status: "downloading",
                path: actualPath,
                addedAt: Date.now(),
                downloaded: 0,
                length: realLength,
                torrentFilePath: torrentFilePath,
              });
              addTorrentToHistory({
                name: realName,
                magnetUri: `magnet:?xt=urn:btih:${realInfoHash}`,
                infoHash: realInfoHash,
                addedAt: Date.now(),
              });
              if (isExternalDrive(downloadPath)) {
                setTorrentThrottle(realInfoHash, EXTERNAL_DRIVE_DL_LIMIT, 0);
                broadcast("show-toast", { message: `External drive throttled to ${(EXTERNAL_DRIVE_DL_LIMIT / 1024 / 1024).toFixed(1)} MB/s to prevent freezing`, type: "warning" });
              }
              clearTimeout(timeout);
              if (!responded) { responded = true; resolve({ ok: true, infoHash: realInfoHash, name: realName }); }
            });
            return;
          }

          // Multiple files: store pending (still on temp path) and show file picker
          let fileList = buildFileList(t, t.name);
          if (!fileList) {
            setTimeout(() => {
              if (responded) return;
              fileList = buildFileList(t, t.name);
              if (!fileList) {
                console.error(`[RO^JO] ${t.name}: t.files still empty after retry in handleAddTorrentFile`);
                try { client.remove(t); } catch (e) {}
                if (!responded) { responded = true; resolve({ ok: false, error: "Failed to read torrent file list" }); }
                return;
              }
              doShowFilePicker(t, fileList, t.name, downloadPath, null, torrentFilePath);
              clearTimeout(timeout);
              if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name, filePicker: true }); }
            }, 100);
            return;
          }
          doShowFilePicker(t, fileList, t.name, downloadPath, null, torrentFilePath);
          clearTimeout(timeout);
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name, filePicker: true }); }
        });
      } catch (err) {
        clearTimeout(timeout);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        clearTimeout(timeout);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
      });

      torrent.on("warning", (err) => {
        console.warn(`[RO^JO] ${torrent.name || "torrent"} tracker warning:`, err.message);
      });

      torrent.on("wire", (wire) => {
        console.log(`[RO^JO] ${torrent.name}: peer connected (${wire.peerId || "unknown"})`);
        // Limit peers for slow external drives to prevent I/O freeze
        if (isExternalDrive(torrent.path) && torrent.wires.length > 5) {
          console.log(`[RO^JO] ${torrent.name}: disconnecting excess peer (external drive limit)`);
          wire.destroy();
        }
      });

      torrent.on("noPeers", () => {
        console.warn(`[RO^JO] ${torrent.name}: no peers found`);
      });

      torrent.on("done", () => {
        const entry = activeTorrents.get(torrent.infoHash);
        if (entry) entry.status = "completed";
        broadcast("torrent-completed", { infoHash: torrent.infoHash, name: entry ? entry.name : torrent.name });
      });

      setTimeout(() => {
        if (!responded) {
          responded = true;
          resolve({ ok: false, error: "Timed out waiting for torrent metadata" });
        }
      }, 25000);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function removeTorrent(infoHash, deleteFiles = false) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };

  return new Promise((resolve) => {
    client.remove(torrent, { destroyStore: deleteFiles }, (err) => {
      if (err) return resolve({ ok: false, error: err.message });
      activeTorrents.delete(infoHash);
      // Immediately tell the renderer so the item vanishes from the list
      if (win && !win.isDestroyed()) {
        broadcast("torrent-removed", { infoHash });
      }
      resolve({ ok: true });
    });
  });
}

function overwriteFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const size = stats.size;
    if (size === 0) return;
    const chunkSize = 64 * 1024;

    // DoD 5220.22-M 3-pass overwrite
    // Pass 1: Random data
    // Pass 2: Complement (bitwise NOT) of Pass 1
    // Pass 3: New random data
    const passes = [
      { type: "random" },
      { type: "complement" },
      { type: "random" },
    ];

    // Generate pass 1 random data in chunks to avoid memory bloat on large files
    const pass1Chunks = [];
    let offset = 0;
    while (offset < size) {
      const remaining = size - offset;
      const toWrite = Math.min(chunkSize, remaining);
      pass1Chunks.push(crypto.randomBytes(toWrite));
      offset += toWrite;
    }

    for (let p = 0; p < passes.length; p++) {
      const fd = fs.openSync(filePath, "r+");
      let written = 0;
      for (let i = 0; i < pass1Chunks.length; i++) {
        const chunk = pass1Chunks[i];
        let buffer;
        if (passes[p].type === "random" && p === 2) {
          // Pass 3: fresh random data
          buffer = crypto.randomBytes(chunk.length);
        } else if (passes[p].type === "complement") {
          // Pass 2: bitwise complement of pass 1
          buffer = Buffer.allocUnsafe(chunk.length);
          for (let j = 0; j < chunk.length; j++) {
            buffer[j] = chunk[j] ^ 0xFF;
          }
        } else {
          // Pass 1: random
          buffer = chunk;
        }
        fs.writeSync(fd, buffer, 0, buffer.length, written);
        written += buffer.length;
      }
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }

    // Verify pass 3: read back first and last chunk, ensure they don't match pass 1
    const verifyFd = fs.openSync(filePath, "r");
    const firstChunk = Buffer.allocUnsafe(pass1Chunks[0].length);
    fs.readSync(verifyFd, firstChunk, 0, firstChunk.length, 0);
    const lastOffset = size - pass1Chunks[pass1Chunks.length - 1].length;
    const lastChunk = Buffer.allocUnsafe(pass1Chunks[pass1Chunks.length - 1].length);
    fs.readSync(verifyFd, lastChunk, 0, lastChunk.length, lastOffset);
    fs.closeSync(verifyFd);

    // Simple verify: first chunk should not equal pass 1's first chunk
    let verified = true;
    for (let i = 0; i < Math.min(16, firstChunk.length); i++) {
      if (firstChunk[i] === pass1Chunks[0][i]) {
        verified = false;
        break;
      }
    }
    if (!verified) {
      console.warn(`[RO^JO] Verify warning for ${filePath}: data may not have been overwritten correctly.`);
    }
  } catch (e) {
    console.error(`[RO^JO] Overwrite failed for ${filePath}:`, e.message);
  }
}

async function secureDeleteTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };

  // Collect file paths before removing from client
  const filePaths = [];
  const dirPaths = new Set();
  for (const file of torrent.files) {
    const fullPath = path.join(torrent.path, file.path);
    filePaths.push(fullPath);
    // Track parent directories for cleanup
    let dir = path.dirname(fullPath);
    while (dir && dir !== torrent.path && dir !== path.dirname(dir)) {
      dirPaths.add(dir);
      dir = path.dirname(dir);
    }
  }
  dirPaths.add(torrent.path);

  // Remove from client without touching files
  return new Promise((resolve) => {
    client.remove(torrent, { destroyStore: false }, (err) => {
      if (err) return resolve({ ok: false, error: err.message });
      activeTorrents.delete(infoHash);

      let wiped = 0;
      let failed = 0;

      // Overwrite and delete each file
      for (const fp of filePaths) {
        try {
          if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
            overwriteFile(fp);
            fs.unlinkSync(fp);
            wiped++;
          }
        } catch (e) {
          console.error(`[RO^JO] Secure delete failed for ${fp}:`, e.message);
          failed++;
        }
      }

      // Clean up empty directories bottom-up (deepest first)
      const sortedDirs = Array.from(dirPaths).sort((a, b) => b.length - a.length);
      for (const dir of sortedDirs) {
        try {
          if (fs.existsSync(dir)) {
            const items = fs.readdirSync(dir);
            if (items.length === 0) {
              fs.rmdirSync(dir);
            }
          }
        } catch (e) {
          console.error(`[RO^JO] Failed to remove dir ${dir}:`, e.message);
        }
      }

      if (win && !win.isDestroyed()) {
        broadcast("torrent-removed", { infoHash });
      }

      if (failed > 0) {
        resolve({ ok: true, message: `Securely wiped ${wiped} file(s). ${failed} file(s) could not be wiped.` });
      } else {
        resolve({ ok: true, message: `Securely wiped ${wiped} file(s). Data overwritten with random bytes.` });
      }
    });
  });
}

async function pauseTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  torrent.pause();
  const entry = activeTorrents.get(infoHash);
  if (entry) {
    entry.status = "paused";
    // Freeze stats so in-flight pieces don't show increasing size in UI
    entry._frozenDownloaded = torrent.downloaded;
    entry._frozenUploaded = torrent.uploaded || 0;
    entry._frozenProgress = torrent.progress;
  }
  return { ok: true };
}

async function resumeTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  torrent.resume();
  const entry = activeTorrents.get(infoHash);
  if (entry) {
    entry.status = "downloading";
    // Clear frozen stats so live values resume
    delete entry._frozenDownloaded;
    delete entry._frozenUploaded;
    delete entry._frozenProgress;
  }
  return { ok: true };
}

function broadcast(channel, data) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// ---------- IPC ----------

ipcMain.handle("window-minimize", () => {
  if (win) win.minimize();
  return null;
});

ipcMain.handle("window-close", () => {
  if (win) win.close();
  return null;
});

ipcMain.handle("minimize-to-tray", () => {
  minimizeToTray();
  return null;
});

ipcMain.handle("get-asset-path", (_event, name) => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets", name);
  }
  return path.join(__dirname, "..", "..", "assets", name);
});

ipcMain.handle("add-magnet", async (_event, magnet) => {
  return handleAddMagnet(magnet);
});

ipcMain.handle("add-file", async (_event, arrayBuffer) => {
  const buffer = Buffer.from(arrayBuffer);
  return handleAddTorrentFile(buffer);
});

ipcMain.handle("remove-torrent", async (_event, infoHash, deleteFiles) => {
  return removeTorrent(infoHash, deleteFiles);
});

ipcMain.handle("secure-delete-torrent", async (_event, infoHash) => {
  return secureDeleteTorrent(infoHash);
});

ipcMain.handle("get-torrent-history", () => {
  return { ok: true, history: getTorrentHistory() };
});

ipcMain.handle("clear-torrent-history", () => {
  return clearTorrentHistory();
});

ipcMain.handle("pause-torrent", async (_event, infoHash) => {
  return await pauseTorrent(infoHash);
});

ipcMain.handle("resume-torrent", async (_event, infoHash) => {
  return await resumeTorrent(infoHash);
});

ipcMain.handle("open-folder", async () => {
  shell.openPath(lastDownloadPath);
  return null;
});

ipcMain.handle("open-torrent-folder", async (_event, folderPath) => {
  shell.showItemInFolder(folderPath);
  return null;
});

ipcMain.handle("select-file", async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "Torrent files", extensions: ["torrent"] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  return { name: path.basename(filePath), buffer: buffer.buffer };
});

ipcMain.handle("select-conf-file", async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    filters: [{ name: "WireGuard Config", extensions: ["conf"] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf8");
  return { fileName: path.basename(filePath), content };
});

ipcMain.handle("get-download-path", () => {
  return lastDownloadPath;
});

ipcMain.handle("set-as-default", () => {
  let magnetOk = false;
  try {
    magnetOk = app.setAsDefaultProtocolClient("magnet");
  } catch (e) {
    console.warn("[RO^JO] setAsDefaultProtocolClient failed:", e.message);
  }
  const results = { magnet: magnetOk };

  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const appPath = process.execPath;
      execSync(`reg add "HKEY_CURRENT_USER\\Software\\Classes\\.torrent" /ve /d "RojoTorrent" /f`);
      execSync(`reg add "HKEY_CURRENT_USER\\Software\\Classes\\RojoTorrent\\shell\\open\\command" /ve /d "\\"${appPath}\\" "%1\\"" /f`);
      results.torrent = true;
    } catch (e) {
      console.warn("[RO^JO] Failed to register .torrent on Windows:", e.message);
      results.torrent = false;
      results.torrentError = e.message;
    }
  } else if (process.platform === "darwin") {
    // Register ROJO as default app for .torrent files on macOS
    try {
      const { execSync } = require("child_process");
      const appPath = process.execPath.replace(/\/Contents\/MacOS\/.*$/, "");

      // Register app with Launch Services
      try {
        execSync(`/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "${appPath}"`, { stdio: "ignore" });
      } catch (e) { /* ignore */ }

      // Use Python to modify LaunchServices plist (built-in on all Macs)
      // We build the script so app_path is safely inserted
      const appPathEscaped = appPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const pythonScript = `
import plistlib, os, subprocess, sys

app_path = "${appPathEscaped}"
errors = []

# Register the app with Launch Services
if os.path.exists(app_path):
    result = subprocess.run([
        "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
        "-f", app_path
    ], capture_output=True)
    if result.returncode != 0:
        errors.append("lsregister failed: " + result.stderr.decode("utf-8", "ignore")[:200])

# Build handler entry for .torrent extension
handler = {
    "LSHandlerContentTag": "torrent",
    "LSHandlerContentTagClass": "public.filename-extension",
    "LSHandlerRoleAll": "com.rojo.torrent"
}

plist_paths = [
    os.path.expanduser("~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist"),
    os.path.expanduser("~/Library/Preferences/com.apple.LaunchServices.plist")
]

for plist_path in plist_paths:
    try:
        os.makedirs(os.path.dirname(plist_path), exist_ok=True)
        if os.path.exists(plist_path):
            with open(plist_path, "rb") as f:
                plist = plistlib.load(f)
        else:
            plist = {"LSHandlers": []}

        # Remove existing .torrent handlers
        plist["LSHandlers"] = [
            h for h in plist.get("LSHandlers", [])
            if not (h.get("LSHandlerContentTag") == "torrent" and h.get("LSHandlerContentTagClass") == "public.filename-extension")
        ]
        plist["LSHandlers"].append(handler)

        with open(plist_path, "wb") as f:
            plistlib.dump(plist, f)
    except Exception as e:
        errors.append(f"plist error: {e}")

if errors:
    for err in errors:
        print(err)
    sys.exit(1)
print("done")
`;
      execSync(`python3 -c '${pythonScript.replace(/'/g, "'\\''")}'`, { stdio: ["ignore", "pipe", "pipe"] });

      // Restart Finder so it picks up the change
      try { execSync("killall Finder", { stdio: "ignore" }); } catch (e) { /* ignore */ }

      results.torrent = true;
    } catch (e) {
      console.warn("[RO^JO] Failed to register .torrent on macOS:", e.message);
      results.torrent = false;
      results.torrentError = e.message;
    }
  } else {
    results.torrent = "manual";
  }

  // Verify magnet registration actually took effect
  results.magnet = app.isDefaultProtocolClient("magnet");
  return results;
});

ipcMain.handle("check-is-default", () => {
  const results = { magnet: app.isDefaultProtocolClient("magnet") };

  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const reg = execSync('reg query "HKEY_CURRENT_USER\\Software\\Classes\\.torrent" /ve', { encoding: "utf8" });
      results.torrent = reg.includes("RojoTorrent");
    } catch (e) {
      results.torrent = false;
    }
  } else if (process.platform === "darwin") {
    try {
      const { execSync } = require("child_process");
      const appPath = process.execPath.replace(/\/Contents\/MacOS\/.*$/, "");
      const checkScript = `
import os
plist_path = os.path.expanduser("~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")
found = False
if os.path.exists(plist_path):
    try:
        import plistlib
        with open(plist_path, "rb") as f:
            plist = plistlib.load(f)
        for h in plist.get("LSHandlers", []):
            if h.get("LSHandlerContentTag") == "torrent":
                role = h.get("LSHandlerRoleAll", "")
                found = "rojo" in role.lower() or "com.rojo" in role.lower()
                break
    except Exception:
        pass
print("true" if found else "false")
`;
      const out = execSync("python3 -c '" + checkScript.replace(/'/g, "'\\''") + "'", { encoding: "utf8" }).trim();
      results.torrent = out === "true";
    } catch (e) {
      results.torrent = false;
    }
  } else {
    results.torrent = results.magnet;
  }

  results.isDefault = results.magnet || results.torrent;
  return results;
});

// ---------- Context Menu IPC ----------

ipcMain.handle("get-magnet-uri", async (_evt, infoHash) => {
  if (!client) return null;
  const torrent = await client.get(infoHash);
  return torrent ? torrent.magnetURI : null;
});

// Per-torrent speed throttling (basic: pause/resume interval)
const speedThrottles = new Map(); // infoHash -> { interval, dlLimit, ulLimit }

function clearThrottle(infoHash) {
  const t = speedThrottles.get(infoHash);
  if (t) { clearInterval(t.interval); speedThrottles.delete(infoHash); }
}

async function setTorrentThrottle(infoHash, dlLimit, ulLimit) {
  clearThrottle(infoHash);
  if (!client) return;
  const torrent = await client.get(infoHash);
  if (!torrent) return;
  if ((!dlLimit || dlLimit <= 0) && (!ulLimit || ulLimit <= 0)) return;

  let lastDownloaded = torrent.downloaded;
  let lastUploaded = torrent.uploaded || 0;
  let paused = false;

  const interval = setInterval(async () => {
    const t = await client.get(infoHash);
    if (!t) { clearThrottle(infoHash); return; }

    const dlDelta = t.downloaded - lastDownloaded;
    const ulDelta = (t.uploaded || 0) - lastUploaded;
    lastDownloaded = t.downloaded;
    lastUploaded = t.uploaded || 0;

    const dlOver = dlLimit > 0 && dlDelta > dlLimit;
    const ulOver = ulLimit > 0 && ulDelta > ulLimit;

    if (dlOver || ulOver) {
      if (!paused) { t.pause(); paused = true; }
    } else {
      if (paused) { t.resume(); paused = false; }
    }
  }, 1000);

  speedThrottles.set(infoHash, { interval, dlLimit, ulLimit });
}

ipcMain.handle("limit-speed", async (_evt, infoHash, dlBytes, ulBytes) => {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  await setTorrentThrottle(infoHash, dlBytes || 0, ulBytes || 0);
  return { ok: true };
});

ipcMain.handle("recheck-torrent", async (_evt, infoHash) => {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  // Re-check: destroy store and re-verify
  try {
    torrent.destroy();
    // Re-add with same path to force re-check
    const entry = activeTorrents.get(infoHash);
    if (entry && torrent.magnetURI) {
      client.add(torrent.magnetURI, { path: path.dirname(entry.path) });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("update-tracker", async (_evt, infoHash) => {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = await client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  try {
    // Reannounce to all trackers via discover()
    if (torrent.discover) {
      torrent.discover();
    }
    // Also trigger announce on all tracker clients if available
    if (torrent._trackers) {
      for (const tracker of Object.values(torrent._trackers)) {
        if (tracker && tracker.announce) {
          try { tracker.announce(); } catch (e) {}
        }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

const stopRatios = new Map(); // infoHash -> target ratio

ipcMain.handle("set-stop-ratio", async (_evt, infoHash, ratio) => {
  if (ratio <= 0) stopRatios.delete(infoHash);
  else stopRatios.set(infoHash, ratio);
  return { ok: true };
});

// ---------- Cover Art (iTunes + Wikipedia) ----------
const coverArtCache = new Map(); // cleanedName -> imageUrl
const imdbCache = new Map(); // cleanedName -> { rating, id, title, year }

function cleanTorrentName(name) {
  if (!name) return "";
  let cleaned = name
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(1080p|720p|480p|2160p|4K|2K)\b/gi, "")
    .replace(/\b(BluRay|BRRip|HDRip|WEB-?DL|WEBRip|DVDRip|BDRip|HDTV|PDTV|HDCAM|TS|TC|DVDSCR|CAM)\b/gi, "")
    .replace(/\b(x264|x265|HEVC|AVC|AAC|DTS|DD5\.1|AC3|MP3|FLAC|Subtitles)\b/gi, "")
    .replace(/\b(YIFY|RARBG|EZTV|SPARKS|GECKOS|KILLERS|ETRG|AMIABLE|ROVERS|DIMENSION|FLEET)\b/gi, "")
    .replace(/\b(torrent|magnet|download|pdf|epub|mobi|azw3)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject).on("timeout", () => reject(new Error("timeout")));
  });
}

async function searchItunes(query, media) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=${media}&entity=${media === "movie" ? "movie" : media === "tvShow" ? "tvSeason" : "album"}&limit=1`;
  const data = await httpsGetJson(url);
  if (data.resultCount > 0 && data.results[0].artworkUrl100) {
    return data.results[0].artworkUrl100.replace("100x100bb", "300x300bb");
  }
  return null;
}

async function searchImdb(query) {
  try {
    const firstLetter = query.charAt(0).toLowerCase();
    const url = `https://v2.sg.media-imdb.com/suggests/${firstLetter}/${encodeURIComponent(query)}.json`;
    const raw = await new Promise((resolve, reject) => {
      https.get(url, { timeout: 5000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }).on("error", reject);
    });
    // Strip JSONP wrapper: imdb$query([...]) -> [...]
    const match = raw.match(/^imdb\$[^(]+\((.*)\)$/);
    if (!match) return null;
    const parsed = JSON.parse(match[1]);
    if (!parsed.d || !parsed.d.length) return null;
    // Pick first movie result (qid "tt" means title)
    const result = parsed.d.find((item) => item.id && item.id.startsWith("tt")) || parsed.d[0];
    if (!result) return null;
    return {
      rating: result.vt || result.v || null,
      id: result.id || null,
      title: result.l || null,
      year: result.y || null,
    };
  } catch (e) {
    console.error("[RO^JO] IMDB search error:", e.message);
    return null;
  }
}

async function searchWikipediaImage(query) {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`;
  const searchData = await httpsGetJson(searchUrl);
  const results = searchData.query && searchData.query.search;
  if (!results || !results.length) return null;
  const pageId = results[0].pageid;
  const imageUrl = `https://en.wikipedia.org/w/api.php?action=query&pageids=${pageId}&prop=pageimages&format=json&pithumbsize=300&origin=*`;
  const imageData = await httpsGetJson(imageUrl);
  const pages = imageData.query && imageData.query.pages;
  if (!pages) return null;
  const page = pages[pageId];
  const thumb = page && page.thumbnail;
  return thumb && thumb.source ? thumb.source : null;
}

ipcMain.handle("fetch-cover-art", async (_evt, torrentName) => {
  const query = cleanTorrentName(torrentName);
  if (!query) return { ok: false };

  const cachedUrl = coverArtCache.get(query);
  const cachedImdb = imdbCache.get(query);
  if (cachedUrl !== undefined) {
    return { ok: true, url: cachedUrl || null, imdb: cachedImdb || null };
  }

  console.log(`[RO^JO] Fetching cover art + IMDB for "${query}" (original: "${torrentName}")`);

  try {
    // Fetch cover art and IMDB in parallel
    const [url, imdb] = await Promise.all([
      (async () => {
        let u = await searchItunes(query, "movie");
        if (!u) u = await searchItunes(query, "tvShow");
        if (!u) u = await searchItunes(query, "music");
        if (!u) u = await searchWikipediaImage(query);
        return u;
      })(),
      searchImdb(query),
    ]);

    coverArtCache.set(query, url || null);
    if (imdb) imdbCache.set(query, imdb);

    if (url) console.log(`[RO^JO] Cover art found: ${url}`);
    if (imdb) console.log(`[RO^JO] IMDB found: ${imdb.id} rating=${imdb.rating}`);
    if (!url) console.log(`[RO^JO] No cover art found for "${query}"`);

    return { ok: true, url: url || null, imdb: imdb || null };
  } catch (e) {
    console.error(`[RO^JO] Cover art/IMDB fetch error:`, e.message);
    coverArtCache.set(query, null);
    return { ok: false, error: e.message };
  }
});

// ---------- Post-Download Malware Scan (ClamAV) ----------
ipcMain.handle("scan-downloaded-file", async (_evt, filePath) => {
  if (!filePath || typeof filePath !== "string") return { ok: false, error: "Invalid path" };
  if (!fs.existsSync(filePath)) return { ok: false, error: "File not found" };

  // Check if clamscan is available
  const clamPaths = [
    "/opt/homebrew/bin/clamscan",
    "/usr/local/bin/clamscan",
    "/usr/bin/clamscan",
    "/bin/clamscan",
  ];
  let clamscanPath = null;
  for (const p of clamPaths) {
    if (fs.existsSync(p)) { clamscanPath = p; break; }
  }
  if (!clamscanPath) {
    return { ok: false, error: "ClamAV not installed. Install with: brew install clamav" };
  }

  return new Promise((resolve) => {
    const proc = spawn(clamscanPath, ["--no-summary", "--infected", filePath], { stdio: "pipe", timeout: 30000 });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      const output = (stdout + stderr).trim();
      if (code === 0) {
        resolve({ ok: true, clean: true, message: "No threats found" });
      } else if (code === 1) {
        resolve({ ok: true, clean: false, message: output || "Threat detected!" });
      } else {
        resolve({ ok: false, error: output || `clamscan exited ${code}` });
      }
    });
    proc.on("error", (err) => {
      resolve({ ok: false, error: `Failed to run clamscan: ${err.message}` });
    });
  });
});

// Check stop ratios in the stats loop
async function checkStopRatios() {
  for (const [infoHash, target] of stopRatios) {
    const entry = activeTorrents.get(infoHash);
    if (entry && entry.ratio >= target && entry.status !== "paused") {
      await pauseTorrent(infoHash);
      broadcast("torrent-auto-paused", { name: entry.name, ratio: target });
    }
  }
}

// ---------- VPN IPC ----------
const VPN_CONFIG_PATH_ROJO = () => path.join(app.getPath("userData"), "rojo-wireguard.conf");

ipcMain.handle("vpn-status", () => {
  return vpn ? vpn.getTunnelState() : { active: false, address: null, interfaceName: null };
});

ipcMain.handle("vpn-connect", async (_evt, configText, splitTunnelHosts) => {
  if (!vpn) return { ok: false, error: "VPN module not available" };
  try {
    const result = await vpn.startTunnel(configText, splitTunnelHosts);
    return result;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn-disconnect", async () => {
  if (!vpn) return { ok: false, error: "VPN module not available" };
  try {
    return await vpn.stopTunnel();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn-test", async (_evt, url) => {
  if (!vpn) return { ok: false, error: "VPN module not available" };
  try {
    const state = vpn.getTunnelState();
    if (!state.active) return { ok: false, error: "VPN is not active" };
    const res = await vpn.vpnFetch(url, { method: "HEAD", localAddress: state.address, timeoutMs: 15000 });
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn-save-config", async (_evt, configText) => {
  try {
    const p = VPN_CONFIG_PATH_ROJO();
    if (typeof configText === "string" && configText.trim()) {
      fs.writeFileSync(p, configText.trim(), "utf8");
      return { ok: true };
    }
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("vpn-load-config", async () => {
  try {
    const p = VPN_CONFIG_PATH_ROJO();
    if (fs.existsSync(p)) {
      const text = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (text) return { ok: true, config: text };
    }
    return { ok: true, config: "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), config: "" };
  }
});

// Internet speed test using pure Node.js HTTPS (works on all platforms including arm64)
function measurePing(hostname, path) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = require("https").request({ hostname, path, method: "HEAD", timeout: 5000 }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(Date.now() - start));
    });
    req.on("error", () => resolve(999));
    req.on("timeout", () => { req.destroy(); resolve(999); });
    req.end();
  });
}

function downloadSpeedTest(bytes) {
  return new Promise((resolve, reject) => {
    const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
    const start = Date.now();
    let received = 0;
    const req = require("https").get(url, { timeout: 30000 }, (res) => {
      res.on("data", (chunk) => { received += chunk.length; });
      res.on("end", () => {
        const elapsedSec = (Date.now() - start) / 1000;
        const bps = received * 8 / elapsedSec;
        resolve({ bps, received, elapsedSec });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Download timeout")); });
  });
}

function uploadSpeedTest(bytes) {
  return new Promise((resolve, reject) => {
    const data = Buffer.alloc(bytes, 0x00);
    const start = Date.now();
    const req = require("https").request({
      hostname: "speed.cloudflare.com",
      path: "/__up",
      method: "POST",
      headers: { "Content-Length": bytes, "Content-Type": "application/octet-stream" },
      timeout: 30000
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        const elapsedSec = (Date.now() - start) / 1000;
        const bps = bytes * 8 / elapsedSec;
        resolve({ bps, elapsedSec });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Upload timeout")); });
    req.write(data);
    req.end();
  });
}

ipcMain.handle("check-internet", async () => {
  try {
    const ping = await measurePing("1.1.1.1", "/");
    return { ok: ping < 999, ping };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("speed-test", async () => {
  try {
    // Measure ping (average of 3 requests to 1.1.1.1)
    const pings = await Promise.all([
      measurePing("1.1.1.1", "/"),
      measurePing("1.1.1.1", "/"),
      measurePing("1.1.1.1", "/")
    ]);
    const validPings = pings.filter(p => p < 999);
    const avgPing = validPings.length ? Math.round(validPings.reduce((a, b) => a + b, 0) / validPings.length) : 0;

    // Download test (~25MB)
    const dl = await downloadSpeedTest(25000000);
    const downloadMbps = dl.bps / 1000000;

    // Upload test (~5MB)
    let uploadMbps = 0;
    try {
      const ul = await uploadSpeedTest(5000000);
      uploadMbps = ul.bps / 1000000;
    } catch (ulErr) {
      console.warn("[RO^JO] Upload test failed:", ulErr.message);
    }

    return {
      ok: true,
      downloadSpeed: downloadMbps.toFixed(2),
      uploadSpeed: uploadMbps.toFixed(2),
      downloadSpeedFormatted: downloadMbps.toFixed(2) + " Mbps",
      uploadSpeedFormatted: uploadMbps.toFixed(2) + " Mbps",
      ping: avgPing + " ms",
      jitter: validPings.length > 1 ? Math.round(Math.max(...validPings) - Math.min(...validPings)) + " ms" : "N/A",
      server: "Cloudflare",
      duration: dl.elapsedSec.toFixed(2) + "s"
    };
  } catch (e) {
    console.error("[RO^JO] Speed test error:", e.message);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// Confirm file selection from torrent file picker
ipcMain.handle("confirm-file-selection", async (_evt, infoHash, selectedIndices) => {
  const pending = pendingFileSelection.get(infoHash);
  if (!pending) return { ok: false, error: "Torrent no longer pending" };

  return new Promise((resolve) => {
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: "Timed out waiting for torrent after file selection" });
      }
    }, 60000);

    try {
      // 1. Remove temp torrent (destroy store to clean up temp files)
      // 2. Re-add with the real download path
      const onReady = (t) => {
        if (resolved) return;
        clearTimeout(timeout);
        resolved = true;

        // Deselect all files first, then select only the chosen ones
        t.files.forEach(f => f.deselect());
        selectedIndices.forEach(idx => {
          if (t.files[idx]) t.files[idx].select();
        });

        const actualPath = path.join(pending.downloadPath, t.name);
        activeTorrents.set(infoHash, {
          name: pending.displayName || t.name,
          infoHash: infoHash,
          progress: 0,
          speed: 0,
          peers: 0,
          status: "downloading",
          path: actualPath,
          addedAt: Date.now(),
          downloaded: 0,
          length: t.length || 0,
          magnetUri: pending.magnetUri,
          torrentFilePath: pending.torrentFilePath,
        });
        addTorrentToHistory({
          name: pending.displayName || t.name,
          magnetUri: pending.magnetUri || `magnet:?xt=urn:btih:${infoHash}`,
          infoHash: infoHash,
          addedAt: Date.now(),
        });

        // Auto-throttle external drives to prevent USB freeze
        if (isExternalDrive(pending.downloadPath)) {
          setTorrentThrottle(infoHash, EXTERNAL_DRIVE_DL_LIMIT, 0);
          broadcast("show-toast", { message: `External drive throttled to ${(EXTERNAL_DRIVE_DL_LIMIT / 1024 / 1024).toFixed(1)} MB/s to prevent freezing`, type: "warning" });
        }

        pendingFileSelection.delete(infoHash);
        console.log(`[RO^JO] File selection confirmed for ${infoHash}, selected ${selectedIndices.length} files`);
        resolve({ ok: true, infoHash, name: pending.displayName || t.name });
      };

      client.remove(pending.torrent, { destroyStore: true }, () => {
        if (pending.magnetUri) {
          client.add(pending.magnetUri, {
            path: pending.downloadPath,
            announce: ROJO_CONFIG.announce,
          }, onReady);
        } else if (pending.torrentFilePath && fs.existsSync(pending.torrentFilePath)) {
          const buf = fs.readFileSync(pending.torrentFilePath);
          client.add(buf, {
            path: pending.downloadPath,
            announce: ROJO_CONFIG.announce,
          }, onReady);
        } else {
          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve({ ok: false, error: "Cannot re-add torrent: no magnet URI or .torrent file found" });
          }
        }
      });
    } catch (e) {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  });
});

// Cancel file selection and remove torrent
ipcMain.handle("cancel-file-selection", async (_evt, infoHash) => {
  const pending = pendingFileSelection.get(infoHash);
  if (!pending) return { ok: true };

  try {
    client.remove(pending.torrent, { destroyStore: true });
    pendingFileSelection.delete(infoHash);
    console.log(`[RO^JO] File selection cancelled for ${infoHash}, torrent removed`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ---------- HTTP Download IPC ----------
ipcMain.handle("start-http-download", async (_evt, url, targetPath) => {
  try {
    return await startHttpDownload(url, targetPath);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("pause-http-download", (_evt, id) => {
  return pauseHttpDownload(id);
});

ipcMain.handle("resume-http-download", (_evt, id) => {
  return resumeHttpDownload(id);
});

ipcMain.handle("remove-http-download", (_evt, id, deleteFiles) => {
  return removeHttpDownload(id, deleteFiles);
});

ipcMain.handle("get-http-downloads", () => {
  const list = Array.from(httpDownloads.values()).map(d => ({
    id: d.id,
    name: d.name,
    url: d.url,
    status: d.status,
    progress: d.total > 0 ? (d.downloaded / d.total) : 0,
    speed: d.speed || 0,
    peers: 0,
    downloaded: d.downloaded || 0,
    length: d.total || 0,
    path: d.filePath,
    addedAt: d.addedAt,
    type: "http",
  }));
  return list;
});

// ---------- Schedule IPC ----------
ipcMain.handle("schedule-download", (_evt, url, targetPath, scheduledTime) => {
  return scheduleDownload(url, targetPath, scheduledTime);
});

ipcMain.handle("cancel-scheduled-download", (_evt, id) => {
  return cancelScheduledDownload(id);
});

ipcMain.handle("get-scheduled-downloads", () => {
  return scheduledDownloads;
});

// Buffer for files/URLs that arrive before the app is fully ready
const pendingFiles = [];
const pendingUrls = [];

// Handle magnet: protocol on macOS
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url.startsWith("magnet:")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (client) {
      // Fire-and-forget: event handlers must not be async in Electron
      (async () => {
        try {
          const result = await handleAddMagnet(url);
          if (result.duplicate && win && !win.isDestroyed()) {
            const { response } = await dialog.showMessageBox(win, {
              type: "question",
              buttons: ["Cancel", "Replace"],
              defaultId: 1,
              title: "Duplicate Torrent",
              message: `"${result.name}" is already in your download list.`,
              detail: "Do you want to remove the old one and add it again?",
            });
            if (response === 1) {
              await removeTorrent(result.infoHash, true);
              await handleAddMagnet(url);
            }
          }
        } catch (e) {
          console.error("[RO^JO] Failed to handle magnet URL:", e.message);
        }
      })();
    } else {
      pendingUrls.push(url);
    }
  }
});

// Handle files dropped on dock / double-clicked on macOS
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (filePath.endsWith(".torrent")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (client) {
      try {
        handleAddTorrentFile(fs.readFileSync(filePath));
      } catch (e) {
        console.error(`[RO^JO] Failed to read .torrent file: ${e.message}`);
      }
    } else {
      pendingFiles.push(filePath);
    }
  }
});

// ---------- App Lifecycle ----------

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.setAsDefaultProtocolClient("magnet");
  }

  await initWebTorrent();
  await restoreTorrents();
  loadHttpDownloadsState();
  loadScheduledDownloads();
  startScheduleChecker();
  await createWindow();
  createTray();

  // Process any files/URLs that arrived before the app was ready
  for (const filePath of pendingFiles) {
    try {
      handleAddTorrentFile(fs.readFileSync(filePath));
    } catch (e) {
      console.error(`[RO^JO] Failed to process pending .torrent file: ${e.message}`);
    }
  }
  pendingFiles.length = 0;

  for (const url of pendingUrls) {
    try {
      const result = await handleAddMagnet(url);
      if (result.duplicate && win && !win.isDestroyed()) {
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Cancel", "Replace"],
          defaultId: 1,
          title: "Duplicate Torrent",
          message: `"${result.name}" is already in your download list.`,
          detail: "Do you want to remove the old one and add it again?",
        });
        if (response === 1) {
          await removeTorrent(result.infoHash, true);
          await handleAddMagnet(url);
        }
      }
    } catch (e) {
      console.error("[RO^JO] Failed to process pending magnet URL:", e.message);
    }
  }
  pendingUrls.length = 0;

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (e) => {
  isQuitting = true;
  // Stop stats loop immediately
  statsRunning = false;

  // Stop schedule checker
  if (scheduleCheckInterval) {
    clearInterval(scheduleCheckInterval);
    scheduleCheckInterval = null;
  }

  // Save states before quit
  saveTorrentsState();
  saveHttpDownloadsState();
  saveScheduledDownloads();

  // Pause all active HTTP downloads
  for (const d of httpDownloads.values()) {
    if (d.status === "downloading") {
      d.status = "paused";
      if (d._req) { try { d._req.destroy(); } catch (e) {} d._req = null; }
    }
  }

  // Destroy WebTorrent client synchronously before quit
  if (client) {
    try {
      client.destroy();
      console.log("[RO^JO] WebTorrent destroyed");
    } catch (err) {
      console.error("[RO^JO] Error destroying WebTorrent:", err);
    }
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    console.log("[RO^JO] second-instance argv:", argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Handle magnet links or .torrent files passed as args
    for (const arg of argv) {
      if (arg.startsWith("magnet:")) {
        console.log("[RO^JO] Handling magnet from second-instance");
        handleAddMagnet(arg).catch(e => console.error("[RO^JO] second-instance magnet error:", e.message));
      }
      if (arg.endsWith(".torrent") && fs.existsSync(arg)) {
        console.log("[RO^JO] Handling .torrent from second-instance:", arg);
        handleAddTorrentFile(fs.readFileSync(arg)).catch(e => console.error("[RO^JO] second-instance torrent error:", e.message));
      }
    }
  });
}
