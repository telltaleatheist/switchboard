import * as dgram from 'node:dgram';
import * as os from 'node:os';

/**
 * Builds the ranked list of URLs agents can use to reach this switchboard,
 * each rendered as `http://<ip>:<port>`. LITERAL IPs ONLY — the Monitor
 * tool's WS guard rejects hostnames that resolve to link-local or private
 * ranges (DNS-rebinding protection) while accepting literal IPs, so a
 * hostname variant is strictly worse than any IP variant and is not offered.
 *
 * Ordering contract (ARCHITECTURE.md app/): the FIRST entry is the one the
 * console shows in the join block; the rest are alternates behind a picker.
 *
 *   1. The primary outbound IPv4 (the interface holding the default route,
 *      discovered with a connected UDP socket — no packet is ever sent).
 *   2. Remaining private-LAN IPv4s (RFC1918).
 *   3. Everything else non-internal (CGNAT/tailnet 100.64/10, public, …).
 *   4. Loopback last — always works on this machine, useless anywhere else.
 */
export async function buildAdvertisedUrls(port: number): Promise<string[]> {
  const primary = await primaryOutboundIPv4();

  const lan: string[] = [];
  const other: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal || addr.address === primary) continue;
      (isRfc1918(addr.address) ? lan : other).push(addr.address);
    }
  }

  const hosts: string[] = [];
  for (const host of [primary, ...lan, ...other, '127.0.0.1']) {
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.map((host) => `http://${host}:${port}`);
}

function isRfc1918(ip: string): boolean {
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  const octets = ip.split('.');
  return octets[0] === '172' && Number(octets[1]) >= 16 && Number(octets[1]) <= 31;
}

/**
 * The IPv4 this machine would use to reach the wider network: connect() on a
 * UDP socket picks the default-route interface WITHOUT sending anything (UDP
 * connect only sets the peer address). Resolves null when there is no route
 * at all (offline) — the caller falls back to interface enumeration.
 */
function primaryOutboundIPv4(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const finish = (address: string | null): void => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(address);
    };
    socket.once('error', () => finish(null));
    try {
      socket.connect(53, '8.8.8.8', () => {
        try {
          finish(socket.address().address);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}
