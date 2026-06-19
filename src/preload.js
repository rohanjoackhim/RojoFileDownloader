const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rojoAPI", {
  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  minimizeToTray: () => ipcRenderer.invoke("minimize-to-tray"),

  // Assets
  getAssetPath: (name) => ipcRenderer.invoke("get-asset-path", name),

  // Torrent actions
  addMagnet: (magnet) => ipcRenderer.invoke("add-magnet", magnet),
  addFile: (arrayBuffer) => ipcRenderer.invoke("add-file", arrayBuffer),
  removeTorrent: (infoHash, deleteFiles) => ipcRenderer.invoke("remove-torrent", infoHash, deleteFiles),
  secureDeleteTorrent: (infoHash) => ipcRenderer.invoke("secure-delete-torrent", infoHash),
  getTorrentHistory: () => ipcRenderer.invoke("get-torrent-history"),
  clearTorrentHistory: () => ipcRenderer.invoke("clear-torrent-history"),
  pauseTorrent: (infoHash) => ipcRenderer.invoke("pause-torrent", infoHash),
  resumeTorrent: (infoHash) => ipcRenderer.invoke("resume-torrent", infoHash),

  // File/folder
  openFolder: () => ipcRenderer.invoke("open-folder"),
  openTorrentFolder: (path) => ipcRenderer.invoke("open-torrent-folder", path),
  selectFile: () => ipcRenderer.invoke("select-file"),
  selectConfFile: () => ipcRenderer.invoke("select-conf-file"),
  getDownloadPath: () => ipcRenderer.invoke("get-download-path"),
  setAsDefault: () => ipcRenderer.invoke("set-as-default"),
  checkIsDefault: () => ipcRenderer.invoke("check-is-default"),

  // Context menu actions
  getMagnetUri: (infoHash) => ipcRenderer.invoke("get-magnet-uri", infoHash),
  limitSpeed: (infoHash, dlBytes, ulBytes) => ipcRenderer.invoke("limit-speed", infoHash, dlBytes, ulBytes),
  recheckTorrent: (infoHash) => ipcRenderer.invoke("recheck-torrent", infoHash),
  updateTracker: (infoHash) => ipcRenderer.invoke("update-tracker", infoHash),
  fetchCoverArt: (torrentName) => ipcRenderer.invoke("fetch-cover-art", torrentName),
  setStopRatio: (infoHash, ratio) => ipcRenderer.invoke("set-stop-ratio", infoHash, ratio),
  scanDownloadedFile: (filePath) => ipcRenderer.invoke("scan-downloaded-file", filePath),

  // VPN
  vpnStatus: () => ipcRenderer.invoke("vpn-status"),
  vpnConnect: (configText, splitTunnelHosts) => ipcRenderer.invoke("vpn-connect", configText, splitTunnelHosts),
  vpnDisconnect: () => ipcRenderer.invoke("vpn-disconnect"),
  vpnTest: (url) => ipcRenderer.invoke("vpn-test", url),
  vpnSaveConfig: (configText) => ipcRenderer.invoke("vpn-save-config", configText),
  vpnLoadConfig: () => ipcRenderer.invoke("vpn-load-config"),

  // Speed test
  speedTest: () => ipcRenderer.invoke("speed-test"),

  // Internet connectivity
  checkInternet: () => ipcRenderer.invoke("check-internet"),

  // HTTP downloads
  startHttpDownload: (url, targetPath) => ipcRenderer.invoke("start-http-download", url, targetPath),
  pauseHttpDownload: (id) => ipcRenderer.invoke("pause-http-download", id),
  resumeHttpDownload: (id) => ipcRenderer.invoke("resume-http-download", id),
  removeHttpDownload: (id, deleteFiles) => ipcRenderer.invoke("remove-http-download", id, deleteFiles),
  getHttpDownloads: () => ipcRenderer.invoke("get-http-downloads"),

  // Scheduling
  scheduleDownload: (url, targetPath, scheduledTime) => ipcRenderer.invoke("schedule-download", url, targetPath, scheduledTime),
  cancelScheduledDownload: (id) => ipcRenderer.invoke("cancel-scheduled-download", id),
  getScheduledDownloads: () => ipcRenderer.invoke("get-scheduled-downloads"),

  // File selection
  confirmFileSelection: (infoHash, selectedIndices) => ipcRenderer.invoke("confirm-file-selection", infoHash, selectedIndices),
  cancelFileSelection: (infoHash) => ipcRenderer.invoke("cancel-file-selection", infoHash),

  // Event listeners
  onTorrentsUpdated: (callback) => {
    ipcRenderer.on("torrents-updated", (_event, data) => callback(data));
  },
  onTorrentCompleted: (callback) => {
    ipcRenderer.on("torrent-completed", (_event, data) => callback(data));
  },
  onTorrentError: (callback) => {
    ipcRenderer.on("torrent-error", (_event, msg) => callback(msg));
  },
  onTorrentAutoPaused: (callback) => {
    ipcRenderer.on("torrent-auto-paused", (_event, data) => callback(data));
  },
  onTorrentRemoved: (callback) => {
    ipcRenderer.on("torrent-removed", (_event, data) => callback(data));
  },
  onShowFilePicker: (callback) => {
    ipcRenderer.on("show-file-picker", (_event, data) => callback(data));
  },
  onShowToast: (callback) => {
    ipcRenderer.on("show-toast", (_event, data) => callback(data));
  },
  onHttpDownloadsUpdated: (callback) => {
    ipcRenderer.on("http-downloads-updated", (_event, data) => callback(data));
  },
  onHttpDownloadRemoved: (callback) => {
    ipcRenderer.on("http-download-removed", (_event, data) => callback(data));
  },
  onScheduledDownloadsUpdated: (callback) => {
    ipcRenderer.on("scheduled-downloads-updated", (_event, data) => callback(data));
  },
});
