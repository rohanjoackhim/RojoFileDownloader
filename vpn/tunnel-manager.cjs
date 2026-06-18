/**
 * WireGuard tunnel manager for Electron main process.
 *
 * Uses system wg-quick (macOS/Linux) or wireguard.exe (Windows).
 * Tracks active tunnel state and the interface address for binding.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dns = require("dns");
const { promisify } = require("util");
const { parseWireGuardConfig, validateWireGuardConfig, wireGuardInterfaceAddress, serializeWireGuardConfig } = require("./wireguard-config.cjs");

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/** @type {{configPath: string|null, interfaceName: string|null, address: string|null, active: boolean}} */
let tunnelState = {
  configPath: null,
  interfaceName: null,
  address: null,
  active: false,
};

/** Interval that keeps the sudo credential cache warm on macOS (4 min). */
let sudoRefreshInterval = null;

function getTunnelState() {
  return { ...tunnelState };
}

function isTunnelActive() {
  return tunnelState.active;
}

function getVpnInterfaceAddress() {
  return tunnelState.address;
}

function startSudoRefresh() {
  if (sudoRefreshInterval) return; // already running
  if (os.platform() !== "darwin") return; // macOS only
  console.log("[VPN] Starting sudo credential refresher (every 4 min)");
  sudoRefreshInterval = setInterval(() => {
    const proc = spawn("sudo", ["-v"], { stdio: "pipe" });
    proc.on("close", (code) => {
      if (code === 0) {
        console.log("[VPN] sudo credentials refreshed");
      } else {
        console.log("[VPN] sudo credential refresh failed (cache expired)");
      }
    });
    proc.on("error", () => {
      console.log("[VPN] sudo credential refresh error");
    });
  }, 4 * 60 * 1000); // 4 minutes
}

function stopSudoRefresh() {
  if (sudoRefreshInterval) {
    clearInterval(sudoRefreshInterval);
    sudoRefreshInterval = null;
    console.log("[VPN] Stopped sudo credential refresher");
  }
}

/**
 * Show a friendly dialog before the macOS system elevation prompt.
 * Uses Electron's dialog API if available, otherwise silently continues.
 */
function showMacOSElevationPrompt() {
  try {
    const { dialog } = require("electron");
    dialog.showMessageBoxSync({
      type: "info",
      title: "VPN Setup Required",
      message: "Your macOS password is needed to set up the WireGuard VPN tunnel.",
      detail:
        "VPN configuration changes require administrator privileges on macOS. " +
        "This is typically a one-time step — once you enter your password, the app will remember your credentials for the rest of this session.",
      buttons: ["Continue"],
      defaultId: 0,
    });
  } catch {
    // Electron not available — proceed silently to the system dialog
  }
}

/** Cached resolved path so we only search once. */
let cachedWgQuickPath = null;

/** @returns {Promise<string>} Path to wg-quick or equivalent. */
async function findWgQuick() {
  if (cachedWgQuickPath) return cachedWgQuickPath;

  const platform = os.platform();
  if (platform === "win32") {
    const candidates = [
      "C:\\Program Files\\WireGuard\\wireguard.exe",
      `${process.env.ProgramFiles}\\WireGuard\\wireguard.exe`,
      `${process.env.ProgramFiles}\\WireGuard\\wireguard.exe`.replace(/Program Files \(x86\)/, "Program Files"),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        cachedWgQuickPath = c;
        return c;
      }
    }
    throw new Error("WireGuard not found. Install WireGuard for Windows from https://wireguard.com/install/");
  }

  // macOS / Linux — search common paths because Electron lacks the user's PATH
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(
      "/opt/homebrew/bin/wg-quick",
      "/usr/local/bin/wg-quick",
      "/usr/bin/wg-quick",
      "/bin/wg-quick"
    );
  } else {
    candidates.push(
      "/usr/bin/wg-quick",
      "/usr/local/bin/wg-quick",
      "/bin/wg-quick",
      "/sbin/wg-quick"
    );
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cachedWgQuickPath = c;
      return c;
    }
  }

  // Last resort: try `which`
  return new Promise((resolve, reject) => {
    const proc = spawn("which", ["wg-quick"]);
    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.on("close", (code) => {
      const trimmed = out.trim();
      if (code === 0 && trimmed && fs.existsSync(trimmed)) {
        cachedWgQuickPath = trimmed;
        resolve(trimmed);
      } else {
        reject(new Error("wg-quick not found. Install WireGuard tools (macOS: brew install wireguard-tools, Linux: apt install wireguard-tools)."));
      }
    });
  });
}

function tempConfigPath() {
  const tmpDir = path.join(os.tmpdir(), "iptv-wireguard");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, "iptv-vpn.conf");
}

function generateInterfaceName() {
  const platform = os.platform();
  if (platform === "darwin") return "utun9";
  if (platform === "linux") return "wg-iptv";
  if (platform === "win32") return "IPTV-VPN";
  return "utun9";
}

/**
 * Resolve hostnames to IPs for split tunneling.
 * @param {string[]} hostnames
 * @returns {Promise<string[]>} Array of "ip/32" CIDR strings
 */
async function resolveHostnames(hostnames) {
  const cidrs = [];
  for (const h of hostnames) {
    const hostname = h.trim();
    if (!hostname) continue;
    try {
      const v4 = await dnsResolve4(hostname);
      for (const ip of v4) cidrs.push(`${ip}/32`);
    } catch (e) {
      console.warn(`[VPN] Could not resolve ${hostname} (A):`, e.message);
    }
    try {
      const v6 = await dnsResolve6(hostname);
      for (const ip of v6) cidrs.push(`${ip}/128`);
    } catch (e) {
      // IPv6 not available, ignore
    }
  }
  return cidrs;
}

/**
 * Start the WireGuard tunnel.
 * @param {string} configText - Raw .conf file contents
 * @param {string[]} [splitTunnelHosts] - Optional hostnames to restrict tunnel to (split tunneling)
 * @returns {Promise<{ok: boolean, error?: string, address?: string}>}
 */
async function startTunnel(configText, splitTunnelHosts = []) {
  if (tunnelState.active) {
    return { ok: false, error: "Tunnel is already active. Disconnect first." };
  }

  let parsed;
  try {
    parsed = parseWireGuardConfig(configText);
  } catch (e) {
    return { ok: false, error: `Failed to parse config: ${e.message}` };
  }

  const validation = validateWireGuardConfig(parsed);
  if (validation.length) {
    return { ok: false, error: `Invalid config: ${validation.join("; ")}` };
  }

  const address = wireGuardInterfaceAddress(parsed);
  if (!address) {
    return { ok: false, error: "Could not parse IPv4 address from [Interface] Address." };
  }

  // Split tunneling: if hostnames provided, resolve them and replace AllowedIPs
  if (splitTunnelHosts && splitTunnelHosts.length > 0) {
    console.log("[VPN] Split tunnel mode: resolving hostnames:", splitTunnelHosts.join(", "));
    const resolved = await resolveHostnames(splitTunnelHosts);
    if (resolved.length > 0) {
      console.log("[VPN] Split tunnel IPs:", resolved.join(", "));
      for (const peer of parsed.peers) {
        peer.AllowedIPs = resolved.join(", ");
      }
    } else {
      console.warn("[VPN] Could not resolve any split tunnel hostnames; falling back to full tunnel.");
    }
  }

  const sanitizedConfig = serializeWireGuardConfig(parsed);

  const configPath = tempConfigPath();
  fs.writeFileSync(configPath, sanitizedConfig, "utf-8");

  const platform = os.platform();
  const interfaceName = generateInterfaceName();

  try {
    if (platform === "win32") {
      await startWindowsTunnel(configPath, interfaceName);
    } else {
      await startUnixTunnel(configPath, interfaceName);
    }
  } catch (e) {
    try { fs.unlinkSync(configPath); } catch {}
    return { ok: false, error: e.message };
  }

  tunnelState = {
    configPath,
    interfaceName,
    address,
    active: true,
  };

  startSudoRefresh();

  // Prime sudo cache on macOS so next connect can use sudo -n (no dialog)
  if (os.platform() === "darwin") {
    const sudoV = spawn("sudo", ["-v"], { stdio: "pipe" });
    sudoV.on("close", (code) => {
      if (code === 0) console.log("[VPN] sudo cache primed for next connect");
    });
  }

  console.log(`[VPN] Tunnel active on ${interfaceName} with address ${address}`);
  return { ok: true, address };
}

/**
 * Spawn wg-quick on Unix.
 * On macOS we go straight to osascript elevation (wg-quick always needs root).
 * On Linux we try plain first, then sudo -n fallback.
 */
async function startUnixTunnel(configPath, _interfaceName) {
  const wgQuickPath = await findWgQuick();
  const isMac = os.platform() === "darwin";

  // Helper: on macOS run down+up in a single elevated shell to avoid 2 password dialogs.
  // On Linux they remain separate.
  async function retryUpAfterDown(errMsg) {
    const alreadyExists = errMsg.toLowerCase().includes("already exists");
    if (!alreadyExists) return false;
    console.log("[VPN] Tunnel already exists from a previous session; bringing it down first…");
    try {
      if (isMac) {
        const safePath = configPath.replace(/'/g, "'\\''");
        await runWgQuickElevatedMacOS(wgQuickPath, `wg-quick down '${safePath}' && wg-quick up '${safePath}'`);
      } else {
        await runWgQuickSudo(wgQuickPath, ["down", configPath]);
        await runWgQuickSudo(wgQuickPath, ["up", configPath]);
      }
      return true;
    } catch (e) {
      console.error("[VPN] Failed to bring existing tunnel down:", e.message);
      return false;
    }
  }

  // macOS: try cached sudo first (instant, no dialog), then osascript fallback.
  if (isMac) {
    try {
      await runWgQuickMacOSFast(wgQuickPath, ["up", configPath]);
      return;
    } catch (err) {
      if (await retryUpAfterDown(err.message)) return;
      throw err;
    }
  }

  // Linux: try plain first, then sudo fallback.
  return new Promise((resolve, reject) => {
    const args = ["up", configPath];
    const proc = spawn(wgQuickPath, args, { stdio: "pipe", timeout: 8000 });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        console.log("[VPN] wg-quick timed out (likely waiting for password); retrying with sudo…");
        runWgQuickSudo(wgQuickPath, args)
          .then(resolve)
          .catch(async (err) => {
            if (await retryUpAfterDown(err.message)) resolve();
            else reject(err);
          });
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const errText = (stderr + stdout).toLowerCase();
      const isPerm =
        errText.includes("permission") ||
        errText.includes("operation not permitted") ||
        errText.includes("not permitted") ||
        errText.includes("must be run as root") ||
        errText.includes("root privilege") ||
        errText.includes("sudo") ||
        errText.includes("password is required");
      if (isPerm) {
        console.log("[VPN] wg-quick permission denied; retrying with sudo…");
        runWgQuickSudo(wgQuickPath, args)
          .then(resolve)
          .catch(async (err) => {
            if (await retryUpAfterDown(err.message)) resolve();
            else reject(err);
          });
      } else {
        const errMsg = stderr || stdout || "Unknown error";
        retryUpAfterDown(errMsg).then((fixed) => {
          if (fixed) resolve();
          else reject(new Error(`wg-quick failed (exit ${code}): ${errMsg}`));
        });
      }
    });
    proc.on("error", (err) => {
      console.warn("[VPN] spawn error:", err.message);
      runWgQuickSudo(wgQuickPath, args)
        .then(resolve)
        .catch(async (sudoErr) => {
          if (await retryUpAfterDown(sudoErr.message)) resolve();
          else reject(sudoErr);
        });
    });
  });
}

/**
 * Run wg-quick via osascript so macOS shows a single admin-password dialog.
 * @param {string} wgQuickPath
 * @param {string[]|string} argsOrCmd — array of wg-quick args, OR a raw shell command string
 * @param {boolean} [skipPrompt] — if true, skip the friendly Electron dialog (used for disconnect)
 */
function runWgQuickElevatedMacOS(wgQuickPath, argsOrCmd, skipPrompt = false) {
  return new Promise((resolve, reject) => {
    // Show a friendly explanation before the generic system dialog (only for connect/up)
    if (!skipPrompt) showMacOSElevationPrompt();

    // Export PATH so elevated shell can find bash and wireguard-go if needed
    const pathEnv = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
    let shellCmd;
    if (typeof argsOrCmd === "string") {
      shellCmd = `export PATH="${pathEnv}:$PATH" && ${argsOrCmd}`;
    } else {
      // Pre-emptively run "wg-quick down" before "up" so a single osascript call
      // handles both the teardown and the bring-up. This avoids a second password
      // prompt when the tunnel already exists from a previous session.
      const isUpCommand = argsOrCmd.length >= 1 && argsOrCmd[0] === "up";
      const wgArgs = ["wg-quick", ...argsOrCmd].map((s) => {
        if (/[^a-zA-Z0-9._~\/=\-:]/.test(s)) return "'" + s.replace(/'/g, "'\\''") + "'";
        return s;
      }).join(" ");
      if (isUpCommand) {
        const configFile = argsOrCmd[1];
        const safeConfig = configFile.replace(/'/g, "'\\''");
        shellCmd = `export PATH="${pathEnv}:$PATH" && wg-quick down '${safeConfig}' 2>/dev/null; ${wgArgs}`;
      } else {
        shellCmd = `export PATH="${pathEnv}:$PATH" && ${wgArgs}`;
      }
    }
    const appleScript = `do shell script "${shellCmd.replace(/"/g, '\\"')}" with administrator privileges`;
    console.log("[VPN] Elevated AppleScript:", appleScript.slice(0, 200));
    const proc = spawn("osascript", ["-e", appleScript], { stdio: "pipe" });

    // Timeout so a hung osascript doesn't block forever.
    // 60s allows time for the user to enter their password in the dialog.
    const timeoutMs = 60000;
    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`wg-quick (elevated) timed out after ${timeoutMs}ms — password dialog may have been dismissed`));
    }, timeoutMs);

    let out = "";
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { out += d; });
    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) resolve();
      else reject(new Error(`wg-quick (elevated) failed: ${out.trim() || "Unknown error"}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn osascript: ${err.message}`));
    });
  });
}

/** Linux / macOS fast-path using cached sudo ticket (no password prompt). */
function runWgQuickSudo(wgQuickPath, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("sudo", ["-n", wgQuickPath, ...args], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });

    // 8s timeout so a hung wg-quick down/up doesn't block forever
    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("wg-quick (sudo) timed out after 8000ms"));
    }, 8000);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code === 0) resolve();
      else reject(new Error(`wg-quick (sudo) failed (exit ${code}): ${stderr || "Passwordless sudo required."}`));
    });
    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn sudo wg-quick: ${err.message}`));
    });
  });
}

/** macOS: try cached sudo first (instant, no dialog), then fall back to osascript. */
async function runWgQuickMacOSFast(wgQuickPath, args) {
  const isDown = args.length >= 1 && args[0] === "down";
  try {
    await runWgQuickSudo(wgQuickPath, args);
    return;
  } catch (sudoErr) {
    const msg = sudoErr.message.toLowerCase();
    if (msg.includes("password") || msg.includes("sudo") || msg.includes("required")) {
      console.log("[VPN] Cached sudo not available; using osascript elevation…");
    } else {
      console.warn("[VPN] sudo failed, trying osascript:", sudoErr.message);
    }
    // Skip the friendly dialog for disconnect — it's annoying
    await runWgQuickElevatedMacOS(wgQuickPath, args, isDown);
  }
}

function startWindowsTunnel(configPath, interfaceName) {
  return new Promise((resolve, reject) => {
    const wireguardExe = "C:\\Program Files\\WireGuard\\wireguard.exe";
    if (!fs.existsSync(wireguardExe)) {
      reject(new Error("WireGuard not found at C:\\Program Files\\WireGuard\\wireguard.exe"));
      return;
    }
    // Import config as a named tunnel then start it
    const proc = spawn(wireguardExe, ["/installtunnelservice", configPath], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`wireguard.exe failed (exit ${code}): ${stderr || "Unknown error"}`));
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn wireguard.exe: ${err.message}`)));
  });
}

/**
 * Stop the WireGuard tunnel.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function stopTunnel() {
  if (!tunnelState.active) {
    return { ok: true };
  }

  const { configPath, interfaceName } = tunnelState;
  const platform = os.platform();

  try {
    if (platform === "win32") {
      await stopWindowsTunnel(interfaceName);
    } else {
      await stopUnixTunnel(configPath);
    }
  } catch (e) {
    console.error("[VPN] Error stopping tunnel:", e.message);
    // Continue cleanup even if stop failed
  }

  if (configPath && fs.existsSync(configPath)) {
    try { fs.unlinkSync(configPath); } catch {}
  }

  tunnelState = {
    configPath: null,
    interfaceName: null,
    address: null,
    active: false,
  };

  stopSudoRefresh();

  console.log("[VPN] Tunnel stopped");
  return { ok: true };
}

async function stopUnixTunnel(configPath) {
  const wgQuickPath = await findWgQuick();
  const isMac = os.platform() === "darwin";

  // macOS: try cached sudo first (instant), then fall back to osascript.
  // Hard timeout + force-kill so disconnect never hangs.
  if (isMac) {
    const downPromise = runWgQuickMacOSFast(wgQuickPath, ["down", configPath]);
    const timeoutMs = 15000;
    try {
      await Promise.race([
        downPromise,
        new Promise((_res, rej) => setTimeout(() => rej(new Error(`wg-quick down timed out after ${timeoutMs}ms`)), timeoutMs)),
      ]);
      return;
    } catch (err) {
      console.warn("[VPN] wg-quick down failed/timed out:", err.message);
      // Force-kill any lingering wireguard-go / wg processes as last resort
      try {
        const killer = spawn("sudo", ["-n", "pkill", "-f", "wireguard-go"], { stdio: "ignore" });
        killer.on("close", () => console.log("[VPN] Force-killed lingering wireguard-go processes"));
      } catch {
        /* ignore */
      }
      return;
    }
  }

  // Linux: try plain first, then sudo fallback.
  return new Promise((resolve, reject) => {
    const args = ["down", configPath];
    const proc = spawn(wgQuickPath, args, { stdio: "pipe", timeout: 8000 });
    let stderr = "";
    let stdout = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code, signal) => {
      if (signal === "SIGTERM") {
        console.log("[VPN] wg-quick down timed out; retrying with sudo…");
        runWgQuickSudo(wgQuickPath, args).then(resolve).catch(reject);
        return;
      }
      if (code === 0 || code === 1) {
        resolve(); // 1 = already down
        return;
      }
      const errText = (stderr + stdout).toLowerCase();
      const isPerm =
        errText.includes("permission") ||
        errText.includes("operation not permitted") ||
        errText.includes("not permitted") ||
        errText.includes("must be run as root") ||
        errText.includes("root privilege") ||
        errText.includes("sudo") ||
        errText.includes("password is required");
      if (isPerm) {
        console.log("[VPN] wg-quick down permission denied; retrying with sudo…");
        runWgQuickSudo(wgQuickPath, args).then(resolve).catch(reject);
      } else {
        reject(new Error(`wg-quick down failed (exit ${code}): ${stderr || stdout || "Unknown error"}`));
      }
    });
    proc.on("error", (err) => {
      console.warn("[VPN] spawn error:", err.message);
      runWgQuickSudo(wgQuickPath, args).then(resolve).catch(reject);
    });
  });
}

function stopWindowsTunnel(interfaceName) {
  return new Promise((resolve, reject) => {
    const wireguardExe = "C:\\Program Files\\WireGuard\\wireguard.exe";
    if (!fs.existsSync(wireguardExe)) {
      reject(new Error("WireGuard not found"));
      return;
    }
    // /uninstalltunnelservice needs the config path, not just the name
    // We stored the config path; use it.
    const proc = spawn(wireguardExe, ["/uninstalltunnelservice", tunnelState.configPath], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`wireguard.exe uninstall failed (exit ${code}): ${stderr || "Unknown error"}`));
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn wireguard.exe: ${err.message}`)));
  });
}

module.exports = {
  startTunnel,
  stopTunnel,
  getTunnelState,
  isTunnelActive,
  getVpnInterfaceAddress,
};
