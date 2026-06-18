/**
 * WireGuard config parser (.conf INI format).
 *
 * Example:
 *   [Interface]
 *   PrivateKey = <base64>
 *   Address = 10.0.0.2/24, fd00::2/128
 *   DNS = 1.1.1.1
 *   MTU = 1420
 *
 *   [Peer]
 *   PublicKey = <base64>
 *   PresharedKey = <base64>
 *   AllowedIPs = 0.0.0.0/0
 *   Endpoint = vpn.example.com:51820
 *   PersistentKeepalive = 25
 */

function parseWireGuardConfig(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    interface: {},
    peers: [],
  };
  let section = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (name === "Interface") {
        section = result.interface;
      } else if (name === "Peer") {
        section = {};
        result.peers.push(section);
      } else {
        section = null;
      }
      continue;
    }

    if (!section) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    section[key] = val;
  }

  return result;
}

function validateWireGuardConfig(parsed) {
  const errors = [];
  const iface = parsed.interface;
  if (!iface.PrivateKey) errors.push("Missing [Interface] PrivateKey");
  if (!iface.Address) errors.push("Missing [Interface] Address");

  if (!parsed.peers.length) {
    errors.push("Missing [Peer] section");
  } else {
    for (let i = 0; i < parsed.peers.length; i++) {
      const peer = parsed.peers[i];
      if (!peer.PublicKey) errors.push(`Peer ${i + 1}: missing PublicKey`);
      if (!peer.Endpoint) errors.push(`Peer ${i + 1}: missing Endpoint`);
    }
  }

  return errors;
}

/** Extract the first IPv4 address from the Interface Address field. */
function wireGuardInterfaceAddress(parsed) {
  const addrStr = parsed.interface.Address || "";
  const addrs = addrStr.split(",").map((s) => s.trim());
  for (const a of addrs) {
    const m = a.match(/^(\d+\.\d+\.\d+\.\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** Generate a .conf file text from parsed config. */
function serializeWireGuardConfig(parsed) {
  const lines = [];
  lines.push("[Interface]");
  for (const [k, v] of Object.entries(parsed.interface)) {
    lines.push(`${k} = ${v}`);
  }
  for (const peer of parsed.peers) {
    lines.push("");
    lines.push("[Peer]");
    for (const [k, v] of Object.entries(peer)) {
      lines.push(`${k} = ${v}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  parseWireGuardConfig,
  validateWireGuardConfig,
  wireGuardInterfaceAddress,
  serializeWireGuardConfig,
};
