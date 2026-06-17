const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Import existing VPN module from parent project
let vpn;
try {
  vpn = require("../../electron/vpn/index.cjs");
  console.log("[RO^JO] VPN module loaded successfully");
} catch (e) {
  console.warn("[RO^JO] VPN module not available:", e.message);
  vpn = null;
}

// ---------- Config ----------
const DEFAULT_DOWNLOAD_DIR = path.join(os.homedir(), "Downloads", "RO^JO");
if (!fs.existsSync(DEFAULT_DOWNLOAD_DIR)) {
  fs.mkdirSync(DEFAULT_DOWNLOAD_DIR, { recursive: true });
}

// Pre-configured optimal settings
const ROJO_CONFIG = {
  dht: true,
  tracker: true,
  webSeeds: true,
  maxConns: 1000,
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
let isMinimized = false;

// Store last used download path
let lastDownloadPath = DEFAULT_DOWNLOAD_DIR;

function formatSpeedBadge(bps) {
  if (!bps || bps === 0) return "";
  const k = 1024;
  if (bps < k) return Math.round(bps) + "B";
  if (bps < k * k) return (bps / k).toFixed(1).replace(/\.0$/, "") + "K";
  if (bps < k * k * k) return (bps / (k * k)).toFixed(1).replace(/\.0$/, "") + "M";
  return (bps / (k * k * k)).toFixed(1).replace(/\.0$/, "") + "G";
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

  // Compute best progress and total speed
  let totalSpeed = 0;
  let bestProgress = 0;
  for (const t of client.torrents) {
    totalSpeed += t.downloadSpeed;
    if (t.progress > bestProgress) bestProgress = t.progress;
  }

  // Badge shows download speed (macOS only)
  if (process.platform === "darwin" && app.dock) {
    const badge = formatSpeedBadge(totalSpeed);
    app.dock.setBadge(badge);
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
    width: 980,
    height: 680,
    minWidth: 700,
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

  // Periodically broadcast stats to renderer
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const list = [];
    for (const t of client.torrents) {
      const entry = activeTorrents.get(t.infoHash);
      if (!entry) continue;
      entry.progress = t.progress;
      entry.speed = t.downloadSpeed;
      entry.uploadSpeed = t.uploadSpeed;
      entry.peers = t.numPeers;
      entry.downloaded = t.downloaded;
      entry.uploaded = t.uploaded || 0;
      entry.length = t.length;
      entry.timeRemaining = t.timeRemaining || 0;
      entry.ratio = t.downloaded > 0 ? (t.uploaded || 0) / t.downloaded : 0;
      entry.status = t.done ? "completed" : t.paused ? "paused" : "downloading";
      list.push({ ...entry });
    }
    broadcast("torrents-updated", {
      torrents: list,
      downloadSpeed: client.downloadSpeed,
      uploadSpeed: client.uploadSpeed,
    });

    // Update dock badge / taskbar progress when minimized
    updateDockBadge();
  }, 1000);
}

async function handleAddMagnet(magnetUri) {
  if (!client) return { ok: false, error: "Engine not ready" };

  try {
    const downloadPath = await selectDownloadPath();
    if (!downloadPath) return { ok: false, error: "Download path not selected" };

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        torrent = client.add(magnetUri, {
          path: downloadPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          activeTorrents.set(t.infoHash, {
            name: t.name,
            infoHash: t.infoHash,
            progress: 0,
            speed: 0,
            peers: 0,
            status: "downloading",
            path: path.join(downloadPath, t.name),
            addedAt: Date.now(),
            downloaded: 0,
            length: t.length || 0,
          });
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name }); }
        });
      } catch (err) {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
      });

      torrent.on("done", () => {
        broadcast("torrent-completed", { infoHash: torrent.infoHash, name: torrent.name });
      });

      setTimeout(() => {
        if (!responded) {
          responded = true;
          resolve({ ok: false, error: "Timed out waiting for torrent metadata. Your ISP may block DHT/trackers." });
        }
      }, 25000);
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleAddTorrentFile(buffer) {
  if (!client) return { ok: false, error: "Engine not ready" };

  try {
    const downloadPath = await selectDownloadPath();
    if (!downloadPath) return { ok: false, error: "Download path not selected" };

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        torrent = client.add(buffer, {
          path: downloadPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          activeTorrents.set(t.infoHash, {
            name: t.name,
            infoHash: t.infoHash,
            progress: 0,
            speed: 0,
            peers: 0,
            status: "downloading",
            path: path.join(downloadPath, t.name),
            addedAt: Date.now(),
            downloaded: 0,
            length: t.length || 0,
          });
          if (!responded) { responded = true; resolve({ ok: true, infoHash: t.infoHash, name: t.name }); }
        });
      } catch (err) {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
        return;
      }

      torrent.on("error", (err) => {
        if (!responded) { responded = true; resolve({ ok: false, error: err.message }); }
      });

      torrent.on("done", () => {
        broadcast("torrent-completed", { infoHash: torrent.infoHash, name: torrent.name });
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

function removeTorrent(infoHash, deleteFiles = false) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };

  return new Promise((resolve) => {
    client.remove(torrent, { destroyStore: deleteFiles }, (err) => {
      if (err) return resolve({ ok: false, error: err.message });
      activeTorrents.delete(infoHash);
      resolve({ ok: true });
    });
  });
}

function pauseTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  torrent.pause();
  const entry = activeTorrents.get(infoHash);
  if (entry) entry.status = "paused";
  return { ok: true };
}

function resumeTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  torrent.resume();
  const entry = activeTorrents.get(infoHash);
  if (entry) entry.status = "downloading";
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
  return pauseTorrent(infoHash);
});

ipcMain.handle("resume-torrent", async (_event, infoHash) => {
  return resumeTorrent(infoHash);
});

ipcMain.handle("open-folder", async () => {
  shell.openPath(lastDownloadPath);
  return null;
});

ipcMain.handle("open-torrent-folder", async (_event, folderPath) => {
  shell.openPath(folderPath);
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

// Handle magnet: protocol on macOS
app.on("open-url", (_event, url) => {
  if (url.startsWith("magnet:")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    handleAddMagnet(url);
  }
});

// Handle files dropped on dock on macOS
app.on("open-file", (_event, filePath) => {
  if (filePath.endsWith(".torrent")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    const buf = fs.readFileSync(filePath);
    handleAddTorrentFile(buf);
  }
});

// ---------- App Lifecycle ----------

app.whenReady().then(async () => {
  if (process.platform === "darwin") {
    app.setAsDefaultProtocolClient("magnet");
  }

  await initWebTorrent();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (client) {
    client.destroy(() => {
      console.log("[RO^JO] WebTorrent destroyed");
    });
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Handle magnet links or .torrent files passed as args
    for (const arg of argv) {
      if (arg.startsWith("magnet:")) handleAddMagnet(arg);
      if (arg.endsWith(".torrent") && fs.existsSync(arg)) {
        handleAddTorrentFile(fs.readFileSync(arg));
      }
    }
  });
}
