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
  hosts.add(os.hostname());

  for (const addrs of Object.values(os.networkInterfaces())) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        hosts.add(addr.address);
      }
    }
  }

  return Array.from(hosts, (host) => `http://${host}:${port}`);
}
