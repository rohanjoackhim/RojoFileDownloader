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

  // VPN
  vpnStatus: () => ipcRenderer.invoke("vpn-status"),
  vpnConnect: (configText, splitTunnelHosts) => ipcRenderer.invoke("vpn-connect", configText, splitTunnelHosts),
  vpnDisconnect: () => ipcRenderer.invoke("vpn-disconnect"),
  vpnTest: (url) => ipcRenderer.invoke("vpn-test", url),
  vpnSaveConfig: (configText) => ipcRenderer.invoke("vpn-save-config", configText),
  vpnLoadConfig: () => ipcRenderer.invoke("vpn-load-config"),

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
});
