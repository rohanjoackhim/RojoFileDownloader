/**
 * VPN module entry point for Electron main process.
 *
 * Exports:
 *   - WireGuard tunnel lifecycle (start/stop/status)
 *   - vpnFetch: HTTP fetch bound to the VPN interface when tunnel is active
 */
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { Readable } = require("stream");
const { startTunnel, stopTunnel, getTunnelState, isTunnelActive, getVpnInterfaceAddress } = require("./tunnel-manager.cjs");

/**
 * Internal: single request without redirect handling.
 */
function _vpnRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const client = isHttps ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: opts.method || "GET",
      headers: opts.headers || {},
    };

    if (opts.timeoutMs != null && opts.timeoutMs > 0) {
      reqOpts.timeout = opts.timeoutMs;
    }

    if (opts.localAddress) {
      reqOpts.localAddress = opts.localAddress;
    }

    const req = client.request(reqOpts, (res) => {
      const headers = new Map();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) headers.set(k, v.join(", "));
        else headers.set(k, String(v ?? ""));
      }

      const body = res.statusCode === 204 || req.method === "HEAD"
        ? null
        : Readable.toWeb(res);

      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode || 0,
        statusText: res.statusMessage || "",
        headers,
        body,
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (opts.signal) {
      const onAbort = () => {
        req.destroy();
        reject(new Error("Aborted"));
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
    }

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

/**
 * Fetch a URL using Node's native http/https modules, optionally bound to a specific local address.
 * Follows HTTP redirects (301/302/303/307/308) up to 10 hops.
 * This is used by the stream proxy to route IPTV traffic through the WireGuard tunnel.
 *
 * @param {string} url - Target URL
 * @param {{method?: string, headers?: Record<string,string>, body?: Buffer, localAddress?: string, timeoutMs?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: Map<string,string>, body: ReadableStream|null}>}
 */
async function vpnFetch(url, opts = {}) {
  const maxRedirects = 10;
  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount < maxRedirects) {
    const res = await _vpnRequest(currentUrl, opts);

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      redirectCount++;
      const loc = res.headers.get("location");
      const nextUrl = new URL(loc, currentUrl).toString();
      console.log(`[VPN] Redirect ${redirectCount}: ${res.status} → ${nextUrl.slice(0, 120)}`);
      // Cancel body stream so the underlying Node response can close cleanly
      if (res.body) {
        try { res.body.cancel(); } catch {}
      }
      currentUrl = nextUrl;
      continue;
    }

    console.log(`[VPN] Final response: ${res.status} ${res.statusText} for ${currentUrl.slice(0, 120)}`);
    return res;
  }

  throw new Error(`Too many redirects (>${maxRedirects})`);
}

/**
 * Fetch a URL using Node's native http/https modules (no VPN binding).
 * Same redirect-following logic as vpnFetch but uses the default network interface.
 * Used as a fallback when vpnFetch fails, avoiding Chromium's stricter SSL handling.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: Buffer, timeoutMs?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: Map<string,string>, body: ReadableStream|null}>}
 */
async function defaultFetch(url, opts = {}) {
  const maxRedirects = 10;
  let currentUrl = url;
  let redirectCount = 0;

  console.log(`[VPN] defaultFetch: ${opts.method || "GET"} ${currentUrl.slice(0, 120)}`);

  while (redirectCount < maxRedirects) {
    const res = await _vpnRequest(currentUrl, opts);

    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      redirectCount++;
      const loc = res.headers.get("location");
      currentUrl = new URL(loc, currentUrl).toString();
      console.log(`[VPN] defaultFetch redirect ${redirectCount}: ${res.status} → ${currentUrl.slice(0, 120)}`);
      if (res.body) {
        try { res.body.cancel(); } catch {}
      }
      continue;
    }

    console.log(`[VPN] defaultFetch response: ${res.status} ${res.statusText} for ${currentUrl.slice(0, 120)}`);
    return res;
  }

  throw new Error(`Too many redirects (>${maxRedirects})`);
}

/**
 * Fetch a URL, routing through the VPN tunnel if it's active.
 * Falls back to Electron's net.fetch if VPN is inactive.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: Buffer, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, status: number, statusText: string, headers: Map<string,string>, body: ReadableStream|null}>}
 */
async function routedFetch(url, opts = {}) {
  const vpnAddress = getVpnInterfaceAddress();
  if (vpnAddress && isTunnelActive()) {
    try {
      return await vpnFetch(url, { ...opts, localAddress: vpnAddress });
    } catch (err) {
      console.warn("[VPN] vpnFetch failed, falling back to default:", err.message);
      // Fall through to default fetch
    }
  }
  // Default: no VPN routing
  return null;
}

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelState,
  isTunnelActive,
  getVpnInterfaceAddress,
  vpnFetch,
  defaultFetch,
  routedFetch,
};
