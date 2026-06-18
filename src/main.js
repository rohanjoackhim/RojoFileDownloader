const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

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

// Pre-configured optimal settings
const ROJO_CONFIG = {
  dht: true,
  tracker: true,
  webSeeds: true,
  maxConns: 200,
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

let win;
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

    for (const entry of list) {
      if (!entry.infoHash) continue;
      // Re-add to activeTorrents map
      activeTorrents.set(entry.infoHash, entry);
      // Try to re-add to WebTorrent client
      if (entry.magnetUri) {
        try {
          client.add(entry.magnetUri, {
            path: entry.path ? path.dirname(entry.path) : DEFAULT_DOWNLOAD_DIR,
            announce: ROJO_CONFIG.announce,
          });
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
          console.log(`[RO^JO] Re-added .torrent file: ${entry.name}`);
        } catch (e) {
          console.error(`[RO^JO] Failed to re-add .torrent ${entry.name}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error("[RO^JO] Failed to restore torrents:", e.message);
  }
}

function updateDockBadge() {
  if (!win || win.isDestroyed()) return;
  if (!isMinimized) {
    if (process.platform === "darwin" && app.dock) {
      app.dock.setBadge("");
    }
    win.setProgressBar(-1);
    return;
  }

  // Compute best progress and total speeds
  let totalDl = 0;
  let totalUl = 0;
  let bestProgress = 0;
  for (const t of client.torrents) {
    totalDl += t.downloadSpeed;
    totalUl += t.uploadSpeed;
    if (t.progress > bestProgress) bestProgress = t.progress;
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
  if (client.torrents.length > 0) {
    win.setProgressBar(bestProgress, { mode: bestProgress >= 1 ? "normal" : "normal" });
  } else {
    win.setProgressBar(-1);
  }
}

async function createWindow() {
  win = new BrowserWindow({
    width: 910,
    height: 500,
    minWidth: 680,
    minHeight: 480,
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

  // Handle dropped files
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("magnet:")) {
      e.preventDefault();
      handleAddMagnet(url);
    }
  });
}

// ---------- Download Path Selection ----------

async function selectDownloadPath(defaultPath) {
  const result = await dialog.showOpenDialog(win, {
    defaultPath: defaultPath || lastDownloadPath,
    properties: ["openDirectory", "createDirectory"],
    message: "Select download folder for this torrent",
  });
  if (result.canceled || !result.filePaths.length) return null;
  lastDownloadPath = result.filePaths[0];
  return result.filePaths[0];
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
  });

  client.on("error", (err) => {
    console.error("[WebTorrent] client error:", err.message);
    broadcast("torrent-error", err.message);
  });

  // Periodically broadcast stats to renderer (non-blocking loop)
  // Loop always runs even when window is closed — broadcasts resume when window reopens
  let statsRunning = false;
  async function statsLoop() {
    if (statsRunning) return;
    statsRunning = true;
    while (client && !isQuitting) {
      const list = [];
      for (const t of client.torrents) {
        let entry = activeTorrents.get(t.infoHash);
        // Fallback: if torrent is in client but not in activeTorrents, create entry on the fly
        if (!entry) {
          console.log(`[RO^JO] Stats loop: torrent ${t.infoHash} not in activeTorrents, creating entry`);
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
          };
          activeTorrents.set(t.infoHash, entry);
        }
        const isPaused = entry.status === "paused";
        if (isPaused && entry._frozenDownloaded !== undefined) {
          // Use frozen values so in-flight pieces don't inflate the UI
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
        // Avoid spread to reduce GC pressure: push known fields explicitly
        list.push({
          name: entry.name,
          infoHash: entry.infoHash,
          progress: entry.progress,
          speed: entry.speed,
          uploadSpeed: entry.uploadSpeed,
          peers: entry.peers,
          status: entry.status,
          path: entry.path,
          addedAt: entry.addedAt,
          downloaded: entry.downloaded,
          uploaded: entry.uploaded,
          length: entry.length,
          timeRemaining: entry.timeRemaining,
          ratio: entry.ratio,
        });
      }
      console.log(`[RO^JO] Stats loop: broadcasting ${list.length} torrents to renderer`);
      // Only broadcast if window exists and isn't destroyed
      if (win && !win.isDestroyed()) {
        broadcast("torrents-updated", {
          torrents: list,
          downloadSpeed: client.downloadSpeed,
          uploadSpeed: client.uploadSpeed,
        });
        updateDockBadge();
      }
      await checkStopRatios();

      // Log memory usage every ~10 seconds (when loop counter hits 10)
      statsLoop.counter = (statsLoop.counter || 0) + 1;
      if (statsLoop.counter % 10 === 0) {
        const mem = process.memoryUsage();
        console.log(`[RO^JO] Memory: rss=${(mem.rss/1048576).toFixed(1)}MB heap=${(mem.heapUsed/1048576).toFixed(1)}MB torrents=${client.torrents.length} conns=${client.maxConns}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }
    statsRunning = false;
  }
  statsLoop();
  restartStatsLoop = statsLoop;
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

    console.log(`[RO^JO] handleAddMagnet: path=${downloadPath}, displayName=${displayName || "N/A"}`);

    // Check if torrent already exists in activeTorrents (duplicate check)
    for (const [infoHash, entry] of activeTorrents) {
      if (magnetUri.includes(infoHash)) {
        console.log(`[RO^JO] Duplicate torrent found in activeTorrents: ${infoHash}`);
        return {
          ok: false,
          duplicate: true,
          infoHash: infoHash,
          name: entry.name,
          error: "This torrent is already in your download list"
        };
      }
    }

    // Check if torrent already exists in client (from previous failed add)
    const existingTorrent = client.torrents.find(t => magnetUri.includes(t.infoHash));
    if (existingTorrent) {
      console.log(`[RO^JO] Torrent already exists in client: ${existingTorrent.infoHash}`);
      // If it's in client but not in activeTorrents, re-add it to the map
      if (!activeTorrents.has(existingTorrent.infoHash)) {
        console.log(`[RO^JO] Re-adding existing torrent to activeTorrents`);
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
        return { ok: true, infoHash: existingTorrent.infoHash, name: displayName || existingTorrent.name };
      } else {
        console.log(`[RO^JO] Torrent already in activeTorrents, asking user to replace`);
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

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        torrent = client.add(magnetUri, {
          path: downloadPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          console.log(`[RO^JO] Metadata received for torrent: ${t.name}, infoHash=${t.infoHash}, files=${t.files.length}`);
          // Deselect all files initially, then show file picker
          t.files.forEach(f => f.deselect());

          // If single file, auto-select it and add immediately
          if (t.files.length <= 1) {
            if (t.files[0]) t.files[0].select();
            const actualPath = path.join(downloadPath, t.name);
            activeTorrents.set(t.infoHash, {
              name: displayName || t.name,
              infoHash: t.infoHash,
              progress: 0,
              speed: 0,
              peers: 0,
              status: "downloading",
              path: actualPath,
              addedAt: Date.now(),
              downloaded: 0,
              length: t.length || 0,
              magnetUri: magnetUri,
            });
            console.log(`[RO^JO] Added single-file torrent to activeTorrents: ${t.infoHash}`);
            if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: displayName || t.name }); }
            return;
          }

          // Multiple files: store in pending and show file picker
          const fileList = t.files.map((f, i) => ({
            index: i,
            name: f.name,
            path: f.path,
            length: f.length,
          }));
          pendingFileSelection.set(t.infoHash, {
            torrent: t,
            displayName: displayName || t.name,
            downloadPath,
            magnetUri,
            fileList,
          });
          console.log(`[RO^JO] Showing file picker for ${t.name} with ${fileList.length} files`);
          broadcast("show-file-picker", {
            infoHash: t.infoHash,
            name: displayName || t.name,
            fileList,
          });
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: displayName || t.name, filePicker: true }); }
        });
        console.log(`[RO^JO] Torrent added to client, waiting for metadata...`);
      } catch (err) {
        console.error(`[RO^JO] Error adding torrent to client:`, err);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        console.error(`[RO^JO] Torrent error:`, err);
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
      });

      torrent.on("done", () => {
        const entry = activeTorrents.get(torrent.infoHash);
        if (entry) entry.status = "completed";
        broadcast("torrent-completed", { infoHash: torrent.infoHash, name: entry ? entry.name : torrent.name });
      });

      setTimeout(() => {
        if (!responded) {
          console.error(`[RO^JO] Timeout waiting for metadata after 25s`);
          responded = true;
          resolve({ ok: false, error: "Timed out waiting for torrent metadata. Your ISP may block DHT/trackers." });
        }
      }, 25000);
    });
  } catch (err) {
    console.error(`[RO^JO] handleAddMagnet error:`, err);
    return { ok: false, error: err.message };
  }
}

async function handleAddTorrentFile(buffer) {
  if (!client) return { ok: false, error: "Engine not ready" };
  console.log(`[RO^JO] handleAddTorrentFile: buffer=${buffer.byteLength} bytes`);

  try {
    const downloadPath = await selectDownloadPath();
    if (!downloadPath) return { ok: false, error: "Download path not selected" };
    console.log(`[RO^JO] handleAddTorrentFile: downloadPath=${downloadPath}`);

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        torrent = client.add(buffer, {
          path: downloadPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          const actualPath = path.join(downloadPath, t.name);
          console.log(`[RO^JO] Torrent ready: name="${t.name}", infoHash=${t.infoHash}, files=${t.files.length}`);
          // Deselect all files initially
          t.files.forEach(f => f.deselect());

          // Save .torrent file buffer for persistence
          const torrentFilePath = path.join(TORRENTS_FILES_DIR, `${t.infoHash}.torrent`);
          try {
            fs.writeFileSync(torrentFilePath, Buffer.from(buffer));
          } catch (e) {
            console.error("[RO^JO] Failed to save .torrent file:", e.message);
          }

          // If single file, auto-select and add immediately
          if (t.files.length <= 1) {
            if (t.files[0]) t.files[0].select();
            activeTorrents.set(t.infoHash, {
              name: t.name,
              infoHash: t.infoHash,
              progress: 0,
              speed: 0,
              peers: 0,
              status: "downloading",
              path: actualPath,
              addedAt: Date.now(),
              downloaded: 0,
              length: t.length || 0,
              torrentFilePath: torrentFilePath,
            });
            if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name }); }
            return;
          }

          // Multiple files: store pending and show file picker
          const fileList = t.files.map((f, i) => ({
            index: i,
            name: f.name,
            path: f.path,
            length: f.length,
          }));
          pendingFileSelection.set(t.infoHash, {
            torrent: t,
            displayName: t.name,
            downloadPath,
            torrentFilePath,
            fileList,
          });
          console.log(`[RO^JO] Showing file picker for ${t.name} with ${fileList.length} files`);
          broadcast("show-file-picker", {
            infoHash: t.infoHash,
            name: t.name,
            fileList,
          });
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name, filePicker: true }); }
        });
      } catch (err) {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
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

const stopRatios = new Map(); // infoHash -> target ratio

ipcMain.handle("set-stop-ratio", async (_evt, infoHash, ratio) => {
  if (ratio <= 0) stopRatios.delete(infoHash);
  else stopRatios.set(infoHash, ratio);
  return { ok: true };
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

// Internet speed test using speedtest-net for accurate download and upload measurement
ipcMain.handle("speed-test", async () => {
  try {
    const { default: speedTest } = await import("speedtest-net");
    const result = await speedTest({ acceptLicense: true, acceptGdpr: true });
    
    const downloadMbps = (result.download.bandwidth * 8) / 1000000;
    const uploadMbps = (result.upload.bandwidth * 8) / 1000000;
    
    return {
      ok: true,
      downloadSpeed: downloadMbps.toFixed(2),
      uploadSpeed: uploadMbps.toFixed(2),
      downloadSpeedFormatted: downloadMbps.toFixed(2) + " Mbps",
      uploadSpeedFormatted: uploadMbps.toFixed(2) + " Mbps",
      ping: result.ping.latency + " ms",
      jitter: result.ping.jitter + " ms",
      server: result.server.name + " (" + result.server.location + ")",
      duration: result.result.duration ? (result.result.duration / 1000).toFixed(2) : "N/A"
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

  try {
    const t = pending.torrent;
    // Select only the checked files
    selectedIndices.forEach(idx => {
      if (t.files[idx]) t.files[idx].select();
    });

    // Add to active torrents
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
    pendingFileSelection.delete(infoHash);
    console.log(`[RO^JO] File selection confirmed for ${infoHash}, selected ${selectedIndices.length} files`);
    return { ok: true, infoHash, name: pending.displayName || t.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// Cancel file selection and remove torrent
ipcMain.handle("cancel-file-selection", async (_evt, infoHash) => {
  const pending = pendingFileSelection.get(infoHash);
  if (!pending) return { ok: true };

  try {
    client.remove(pending.torrent);
    pendingFileSelection.delete(infoHash);
    console.log(`[RO^JO] File selection cancelled for ${infoHash}, torrent removed`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// Handle magnet: protocol on macOS
app.on("open-url", async (event, url) => {
  event.preventDefault();
  console.log(`[RO^JO] open-url: ${url.substring(0, 80)}...`);
  if (url.startsWith("magnet:")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const result = await handleAddMagnet(url);
    if (result.duplicate) {
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        buttons: ["Cancel", "Replace"],
        defaultId: 1,
        title: "Duplicate Torrent",
        message: `"${result.name}" is already in your download list.`,
        detail: "Do you want to remove the old one and add it again?",
      });
      if (response === 1) {
        // User clicked Replace
        await removeTorrent(result.infoHash, true);
        await handleAddMagnet(url);
      }
    }
  }
});

// Handle files dropped on dock on macOS
app.on("open-file", async (event, filePath) => {
  event.preventDefault();
  console.log(`[RO^JO] open-file: ${filePath}`);
  if (filePath.endsWith(".torrent")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    try {
      const buf = fs.readFileSync(filePath);
      console.log(`[RO^JO] Read .torrent file: ${buf.length} bytes`);
      await handleAddTorrentFile(buf);
    } catch (e) {
      console.error(`[RO^JO] Failed to read .torrent file: ${e.message}`);
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
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (e) => {
  isQuitting = true;
  // Stop stats loop immediately
  statsRunning = false;

  // Save torrent state before quit
  saveTorrentsState();

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
        handleAddMagnet(arg);
      }
      if (arg.endsWith(".torrent") && fs.existsSync(arg)) {
        console.log("[RO^JO] Handling .torrent from second-instance:", arg);
        try {
          handleAddTorrentFile(fs.readFileSync(arg));
        } catch (e) {
          console.error(`[RO^JO] Failed to read .torrent from second-instance: ${e.message}`);
        }
      }
    }
  });
}
