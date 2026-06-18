# WireGuard VPN Module for Electron

A self-contained, drop-in WireGuard VPN module for Electron apps. Manages tunnel lifecycle (start/stop/status), routes HTTP traffic through the tunnel, and handles privilege elevation cross-platform (macOS, Linux, Windows).

---

## Features

- **Cross-platform:** macOS (wg-quick + sudo/osascript), Linux (wg-quick + sudo), Windows (wireguard.exe)
- **Zero-config after first use:** Caches sudo credentials on macOS/Linux so reconnects don't ask for passwords
- **HTTP fetch via tunnel:** `vpnFetch()` and `defaultFetch()` with redirect following
- **Split tunneling:** Optional hostname-based split tunneling (resolve hostnames → IP CIDRs)
- **Electron-ready:** Uses Node's native `http`/`https` modules; no Chromium networking stack dependency
- **Graceful reconnects:** Hub-based upstream fan-out survives stream reconnections without ending recording sessions

---

## Directory Structure

```
electron/vpn/
  index.cjs              # Public API: tunnel lifecycle + HTTP fetch helpers
  tunnel-manager.cjs     # WireGuard tunnel lifecycle, sudo cache, osascript elevation
  wireguard-config.cjs   # .conf parser, validator, serializer
  README.md              # This file
```

---

## Installation

1. **Copy the entire `electron/vpn/` folder** into your new Electron project.

2. **Install dependencies** (already standard Node.js modules, no npm packages needed):
   - `http`, `https`, `url`, `stream`, `child_process`, `fs`, `path`, `os`, `dns`, `util` — all built-in.

3. **Install WireGuard tools per platform:**
   - **macOS:** `brew install wireguard-tools`
   - **Linux:** `sudo apt install wireguard-tools` (Debian/Ubuntu) or equivalent
   - **Windows:** Install [WireGuard for Windows](https://wireguard.com/install/)

4. **Require it in your Electron main process:**

   ```js
   const vpn = require("./vpn/index.cjs");
   ```

---

## API Reference

### Tunnel Lifecycle

#### `vpn.startTunnel(configText, splitTunnelHosts?)`

Starts a WireGuard tunnel from a `.conf` file contents string.

| Param | Type | Description |
|-------|------|-------------|
| `configText` | `string` | Raw WireGuard `.conf` file contents |
| `splitTunnelHosts` | `string[]` | *(Optional)* Hostnames to restrict tunnel to. Resolved to IPs and injected as `AllowedIPs`. |

**Returns:** `Promise<{ok: boolean, address?: string, error?: string}>`

```js
const fs = require("fs");
const config = fs.readFileSync("/path/to/wg0.conf", "utf8");
const result = await vpn.startTunnel(config, ["iptv-server.example.com"]);
if (!result.ok) {
  console.error("VPN failed:", result.error);
}
```

---

#### `vpn.stopTunnel()`

Stops the active tunnel and cleans up.

**Returns:** `Promise<{ok: boolean, error?: string}>`

```js
await vpn.stopTunnel();
```

---

#### `vpn.getTunnelState()`

Gets current tunnel state.

**Returns:** `{active: boolean, address: string|null, interfaceName: string|null, configPath: string|null}`

```js
const state = vpn.getTunnelState();
console.log(state.active); // true | false
```

---

#### `vpn.isTunnelActive()`

Quick boolean check.

**Returns:** `boolean`

---

#### `vpn.getVpnInterfaceAddress()`

Returns the tunnel's local interface IP (e.g. `10.2.0.2`).

**Returns:** `string | null`

---

### HTTP Fetch (via VPN)

#### `vpn.vpnFetch(url, opts?)`

Fetches a URL **bound to the VPN interface** using Node's native `http`/`https`. Follows redirects (301/302/303/307/308) up to 10 hops.

| Param | Type | Description |
|-------|------|-------------|
| `url` | `string` | Target URL |
| `opts` | `object` | `{method?, headers?, body?, localAddress?, timeoutMs?, signal?}` |

**Returns:** `Promise<{ok, status, statusText, headers: Map, body: ReadableStream|null}>`

```js
const res = await vpn.vpnFetch("https://ipinfo.io/json", {
  localAddress: vpn.getVpnInterfaceAddress(),
  timeoutMs: 15000,
});
```

---

#### `vpn.defaultFetch(url, opts?)`

Same as `vpnFetch`, but **does NOT bind to VPN interface**. Uses default network route. Useful when you need a plain Node HTTP fetch that bypasses Chromium's `net.fetch` (which may not route through VPN).

```js
const res = await vpn.defaultFetch("http://example.com/stream.m3u8", {
  headers: { "User-Agent": "VLC/3.0.18" },
  timeoutMs: 30000,
});
```

---

#### `vpn.routedFetch(url, opts?)`

Convenience wrapper: **auto-routes through VPN if tunnel is active**, otherwise returns `null` (let caller fall back to `defaultFetch`).

```js
const res = await vpn.routedFetch(url, opts);
if (!res) {
  // VPN not active — use your normal fetch path
}
```

---

## macOS Sudo Caching

On macOS, `wg-quick` requires root. This module handles elevation intelligently:

1. **First connect:** Shows a friendly Electron dialog explaining why the password is needed, then falls back to the macOS system elevation dialog
2. **After success:** Runs `sudo -v` to prime the sudo timestamp cache
3. **While running:** A background interval runs `sudo -v` every **4 minutes** to keep the cache warm
4. **Reconnect:** Uses `sudo -n wg-quick up ...` — **no password dialog** if cache is valid
5. **Disconnect:** Stops the background refresher

The friendly dialog explains:
> "Your macOS password is needed to set up the WireGuard VPN tunnel. VPN configuration changes require administrator privileges on macOS. This is typically a one-time step — once you enter your password, the app will remember your credentials for the rest of this session."

The sudo cache on macOS lasts **5 minutes** by default. The 4-minute refresher ensures it never lapses while the app is running.

---

## Integration into Another Electron App

### 1. Copy the module

```bash
cp -r electron/vpn /path/to/your-new-app/electron/vpn
```

### 2. Add IPC handlers (main process)

```js
// main.cjs or your main entry file
const { ipcMain } = require("electron");
const vpn = require("./vpn/index.cjs");

ipcMain.handle("vpn-status", () => vpn.getTunnelState());

ipcMain.handle("vpn-connect", async (_evt, configText, splitTunnelHosts) => {
  try {
    return await vpn.startTunnel(configText, splitTunnelHosts);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("vpn-disconnect", async () => vpn.stopTunnel());

ipcMain.handle("vpn-test", async (_evt, url) => {
  try {
    const state = vpn.getTunnelState();
    if (!state.active) return { ok: false, error: "VPN not active" };
    const res = await vpn.vpnFetch(url, {
      method: "HEAD",
      localAddress: state.address,
      timeoutMs: 15000,
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
```

### 3. Expose to renderer (preload)

```js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vpnAPI", {
  status: () => ipcRenderer.invoke("vpn-status"),
  connect: (config, hosts) => ipcRenderer.invoke("vpn-connect", config, hosts),
  disconnect: () => ipcRenderer.invoke("vpn-disconnect"),
  test: (url) => ipcRenderer.invoke("vpn-test", url),
});
```

### 4. Use in renderer (React/Vue/etc)

```js
const result = await window.vpnAPI.connect(wireguardConfigText, ["iptv.example.com"]);
if (result.ok) {
  console.log("VPN connected, IP:", result.address);
}
```

---

## Platform Notes

| Platform | Elevation Method | Prerequisites |
|----------|------------------|---------------|
| macOS | `sudo -n` (cached) → `osascript` (dialog) | `brew install wireguard-tools` |
| Linux | `wg-quick` (plain) → `sudo -n` | `apt install wireguard-tools` |
| Windows | `wireguard.exe /installtunnelservice` | WireGuard for Windows installed |

### macOS
- `wg-quick` is searched at: `/opt/homebrew/bin/wg-quick`, `/usr/local/bin/wg-quick`, `/usr/bin/wg-quick`, `/bin/wg-quick`
- Falls back to `which wg-quick` if not found in standard paths
- The `osascript` elevation exports `PATH` so `wg-quick`, `bash`, and `wireguard-go` are discoverable

### Linux
- Tries running `wg-quick up` without sudo first
- If permission denied, retries with `sudo -n` (passwordless sudo required, or user must have entered password recently)

### Windows
- Expects `C:\Program Files\WireGuard\wireguard.exe`
- Uses `/installtunnelservice` to create a Windows service for the tunnel

---

## WireGuard Config Format

Accepts standard WireGuard `.conf` files:

```ini
[Interface]
PrivateKey = <base64-private-key>
Address = 10.2.0.2/24
DNS = 10.2.0.1

[Peer]
PublicKey = <base64-public-key>
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
```

When `splitTunnelHosts` is provided, the module resolves hostnames to IPs and replaces `AllowedIPs` with the resolved CIDRs. If resolution fails, it falls back to the original `AllowedIPs`.

---

## Troubleshooting

| Issue | Likely Cause | Fix |
|-------|-------------|-----|
| "wg-quick not found" | WireGuard tools not installed | Install per platform above |
| Password dialog on every connect | Sudo cache expired | Normal on first connect; refresher keeps it warm while running |
| "VPN is not active" | `startTunnel()` failed or `stopTunnel()` called | Check `result.error` from `startTunnel()` |
| Traffic not routing through VPN | OS routing table issue | Check `AllowedIPs` in config; verify `0.0.0.0/0` for full tunnel |
| `vpnFetch` returns 403/401 | VPN-bound fetch rejected | Some services block VPN IPs; try `defaultFetch` without VPN binding |

---

## License

Same as the parent project.
