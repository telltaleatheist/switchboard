import * as os from 'node:os';

/**
 * Builds the list of URLs agents on other machines can use to reach this
 * switchboard: the local hostname plus every non-internal IPv4 address,
 * each rendered as `http://<host>:<port>`.
 *
 * Per ARCHITECTURE.md app/ contract: "advertisedUrls = os.hostname() +
 * non-internal IPv4s from os.networkInterfaces(), each as
 * http://<x>:<port>."
 */
export function buildAdvertisedUrls(port: number): string[] {
  const hosts = new Set<string>();
  // Loopback first: for agents on this same machine it always works, and the
  // Monitor tool's WS guard rejects HOSTNAMES that resolve to link-local or
  // private ranges (DNS-rebinding protection) while accepting literal IPs —
  // so literal-IP variants are the reliable ones. Hostname goes last.
  hosts.add('127.0.0.1');

  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        hosts.add(addr.address);
      }
    }
  }
  hosts.add(os.hostname());

  return Array.from(hosts, (host) => `http://${host}:${port}`);
}
