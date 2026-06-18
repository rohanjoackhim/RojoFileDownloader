const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rojoAPI", {
  // Window controls
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowClose: () => ipcRenderer.invoke("window-close"),

  // Torrent actions
  addMagnet: (magnet) => ipcRenderer.invoke("add-magnet", magnet),
  addFile: (arrayBuffer) => ipcRenderer.invoke("add-file", arrayBuffer),
  removeTorrent: (infoHash, deleteFiles) => ipcRenderer.invoke("remove-torrent", infoHash, deleteFiles),
  pauseTorrent: (infoHash) => ipcRenderer.invoke("pause-torrent", infoHash),
  resumeTorrent: (infoHash) => ipcRenderer.invoke("resume-torrent", infoHash),

  // File/folder
  openFolder: () => ipcRenderer.invoke("open-folder"),
  openTorrentFolder: (path) => ipcRenderer.invoke("open-torrent-folder", path),
  selectFile: () => ipcRenderer.invoke("select-file"),
  getDownloadPath: () => ipcRenderer.invoke("get-download-path"),
  setAsDefault: () => ipcRenderer.invoke("set-as-default"),
  checkIsDefault: () => ipcRenderer.invoke("check-is-default"),

  // Context menu actions
  getMagnetUri: (infoHash) => ipcRenderer.invoke("get-magnet-uri", infoHash),
  limitSpeed: (infoHash, dlBytes, ulBytes) => ipcRenderer.invoke("limit-speed", infoHash, dlBytes, ulBytes),
  recheckTorrent: (infoHash) => ipcRenderer.invoke("recheck-torrent", infoHash),
  setStopRatio: (infoHash, ratio) => ipcRenderer.invoke("set-stop-ratio", infoHash, ratio),

  // VPN
  vpnStatus: () => ipcRenderer.invoke("vpn-status"),
  vpnConnect: (configText, splitTunnelHosts) => ipcRenderer.invoke("vpn-connect", configText, splitTunnelHosts),
  vpnDisconnect: () => ipcRenderer.invoke("vpn-disconnect"),
  vpnTest: (url) => ipcRenderer.invoke("vpn-test", url),
  vpnSaveConfig: (configText) => ipcRenderer.invoke("vpn-save-config", configText),
  vpnLoadConfig: () => ipcRenderer.invoke("vpn-load-config"),

  // Speed test
  speedTest: () => ipcRenderer.invoke("speed-test"),

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
});
