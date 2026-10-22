import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { env } from "../config/env.ts";
import { HttpError } from "./httpError.ts";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

// Every address the hostname resolves to must be public.
async function assertPublicHostname(hostname: string, what: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(bare)
    ? [{ address: bare, family: isIP(bare) }]
    : await lookup(bare, { all: true }).catch(() => {
        throw new HttpError(400, `Could not resolve ${bare}`);
      });
  for (const { address, family } of addresses) {
    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new HttpError(400, `${what} resolves to a private address`);
    }
  }
}

// A self-hosted forge host is user input that the server then calls with
// credentials. In production it must be https and resolve only to public
// addresses, so a connection cannot be pointed at internal services. Local
// development is exempt so a forge on localhost or the LAN still works.
// DNS rebinding after this check is not covered; an egress proxy is the
// complete answer if that matters for a deployment.
export async function assertSafeForgeHost(host: string): Promise<void> {
  if (env.NODE_ENV !== "production") {
    return;
  }
  if (host.startsWith("http://")) {
    throw new HttpError(400, "Forge host must use https");
  }
  await assertPublicHostname(new URL(`https://${host}`).hostname, "Forge host");
}

// The same rules for a URL the server posts to on a workspace's behalf, such
// as a notification webhook.
export async function assertSafeUrl(url: string): Promise<void> {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new HttpError(400, "URL must use https");
  }
  await assertPublicHostname(parsed.hostname, "URL");
}
