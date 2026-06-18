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
let isMinimized = false;
let restartStatsLoop = null; // called when window is recreated after being closed

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
    while (client) {
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
        if (t.done) entry.status = "completed";
        list.push({ ...entry });
      }
      // Only broadcast if window exists and isn't destroyed
      if (win && !win.isDestroyed()) {
        broadcast("torrents-updated", {
          torrents: list,
          downloadSpeed: client.downloadSpeed,
          uploadSpeed: client.uploadSpeed,
        });
        updateDockBadge();
      }
      checkStopRatios();

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

    return new Promise((resolve) => {
      let responded = false;
      let torrent;
      try {
        torrent = client.add(magnetUri, {
          path: downloadPath,
          announce: ROJO_CONFIG.announce,
        }, (t) => {
          const actualPath = path.join(downloadPath, t.name);
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
        const entry = activeTorrents.get(torrent.infoHash);
        if (entry) entry.status = "completed";
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
          console.log(`[RO^JO] Torrent ready: name="${t.name}", infoHash=${t.infoHash}, path=${actualPath}`);
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
        const entry = activeTorrents.get(torrent.infoHash);
        if (entry) entry.status = "completed";
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
  // WebTorrent pause doesn't always fully stop connections,
  // so we also set maxConns to 0 to force zero new piece requests.
  torrent.pause();
  torrent.maxConns = 0;
  const entry = activeTorrents.get(infoHash);
  if (entry) entry.status = "paused";
  return { ok: true };
}

function resumeTorrent(infoHash) {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  torrent.resume();
  torrent.maxConns = 100; // restore per-torrent connections
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
  const magnetOk = app.setAsDefaultProtocolClient("magnet");
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
      const appPath = process.platform === "darwin" ? process.execPath.replace(/\/Contents\/MacOS\/.*$/, "") : process.execPath;

      // Register app with Launch Services
      try {
        execSync(`/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "${appPath}"`, { stdio: "ignore" });
      } catch (e) { /* ignore */ }

      // Use Python to modify LaunchServices plist (built-in on all Macs)
      const pythonScript = `
import plistlib, os, subprocess

# Register the app
app_path = "${appPath}"
if os.path.exists(app_path):
    subprocess.run([
        "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister",
        "-f", app_path
    ], check=False, capture_output=True)

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
        print(f"plist error: {e}")

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

  return results;
});

// ---------- Context Menu IPC ----------

ipcMain.handle("get-magnet-uri", async (_evt, infoHash) => {
  if (!client) return null;
  const torrent = client.get(infoHash);
  return torrent ? torrent.magnetURI : null;
});

// Per-torrent speed throttling (basic: pause/resume interval)
const speedThrottles = new Map(); // infoHash -> { interval, dlLimit, ulLimit }

function clearThrottle(infoHash) {
  const t = speedThrottles.get(infoHash);
  if (t) { clearInterval(t.interval); speedThrottles.delete(infoHash); }
}

function setTorrentThrottle(infoHash, dlLimit, ulLimit) {
  clearThrottle(infoHash);
  if (!client) return;
  const torrent = client.get(infoHash);
  if (!torrent) return;
  if ((!dlLimit || dlLimit <= 0) && (!ulLimit || ulLimit <= 0)) return;

  let lastDownloaded = torrent.downloaded;
  let lastUploaded = torrent.uploaded || 0;
  let paused = false;

  const interval = setInterval(() => {
    const t = client.get(infoHash);
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
  const torrent = client.get(infoHash);
  if (!torrent) return { ok: false, error: "Torrent not found" };
  setTorrentThrottle(infoHash, dlBytes || 0, ulBytes || 0);
  return { ok: true };
});

ipcMain.handle("recheck-torrent", async (_evt, infoHash) => {
  if (!client) return { ok: false, error: "Engine not ready" };
  const torrent = client.get(infoHash);
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
function checkStopRatios() {
  for (const [infoHash, target] of stopRatios) {
    const entry = activeTorrents.get(infoHash);
    if (entry && entry.ratio >= target && entry.status !== "paused") {
      pauseTorrent(infoHash);
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

// Handle magnet: protocol on macOS
app.on("open-url", (_event, url) => {
  console.log(`[RO^JO] open-url: ${url.substring(0, 80)}...`);
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
  console.log(`[RO^JO] open-file: ${filePath}`);
  if (filePath.endsWith(".torrent")) {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    try {
      const buf = fs.readFileSync(filePath);
      console.log(`[RO^JO] Read .torrent file: ${buf.length} bytes`);
      handleAddTorrentFile(buf);
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
