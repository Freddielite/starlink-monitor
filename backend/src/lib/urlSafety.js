import dns from "node:dns/promises";
import net from "node:net";

// What an uptime monitor, a webhook, and a security scan all have in
// common: each one makes this app's own server issue a request to a
// URL a user supplied. That's the entire feature - there's no version
// of "check if my site is up" that doesn't require fetching an
// arbitrary URL - but it also means a monitor or webhook URL is a way
// to make this server's own network position do something: reach
// Render's internal network, a cloud metadata endpoint, or a service
// on localhost that was never meant to be internet-reachable. This
// module is the one place that boundary is drawn, so every caller
// (httpCheck, syntheticCheck, tcpCheck, scanner, webhook) enforces the
// same rule the same way rather than five slightly different ones.

// IPv4 ranges that are private, loopback, link-local (which is also
// where AWS/GCP/Azure/DigitalOcean all serve their instance-metadata
// endpoint from - 169.254.169.254), or otherwise not a real public
// destination. Deliberately conservative: when in doubt, this treats a
// range as unsafe rather than trying to be clever about which parts of
// it might be fine.
function isPrivateOrReservedIpv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC6598)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast (224+) through reserved/broadcast (240-255)
  return false;
}

function isPrivateOrReservedIpv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fe80:") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local (fc00::/7)
  // IPv4-mapped/-compatible IPv6 addresses embed a real v4 address at
  // the end - re-check that address rather than waving it through just
  // because it's wrapped in IPv6 syntax.
  const mapped = lower.match(/(?:^::ffff:|^::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateOrReservedIpv4(mapped[1]);
  return false;
}

function isPrivateOrReservedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true; // not a parseable IP at all - fail closed
}

// Resolves the hostname and rejects the URL if the scheme isn't
// http(s), or if ANY resolved address is private/reserved - checking
// every address dns.lookup returns, not just the first, since a
// hostname resolving to more than one address only needs one of them
// to be internal. Re-resolves on every call rather than trusting a
// cached result from monitor/webhook creation time, which is what
// actually closes the DNS-rebinding gap: a hostname that was safe when
// a monitor was created but points at a private address by the time a
// later check runs gets caught then, not just once at save time.
export async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("only http:// and https:// URLs are allowed");
  }

  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true });
  } catch {
    throw new Error("could not resolve host");
  }
  if (addresses.length === 0) {
    throw new Error("could not resolve host");
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`resolves to a private or reserved address (${address}), which isn't allowed`);
    }
  }
  return parsed;
}

// Same check for a bare host (monitor_type "tcp" targets a host:port,
// not a URL) - no scheme to validate, otherwise identical reasoning.
export async function assertPublicHost(hostname) {
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("could not resolve host");
  }
  if (addresses.length === 0) {
    throw new Error("could not resolve host");
  }
  for (const { address } of addresses) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error(`resolves to a private or reserved address (${address}), which isn't allowed`);
    }
  }
}
