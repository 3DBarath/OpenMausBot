// Whether an engine's address is a program on this computer or on its own
// network, rather than a hosted provider. A hosted provider gets a request
// and what it does with it is its own policy; a model server the person
// runs (Ollama, LM Studio, a box on the LAN) is a program that may write
// what it is sent to a log nobody here can see or delete. An import tells
// the person so before it sends anything (ProviderInstance.textRecord).
//
// Decided from the address as written, with no lookup: a name is not
// resolved, so a public-looking name that points at a private address is
// taken for a hosted provider. An address that cannot be read is local:
// not knowing is no reason to say nothing is kept.
import { isIP } from "node:net";

/** Names only this computer or its own network can resolve. */
const LOCAL_NAME = /(?:^|\.)(?:localhost|local|lan|internal|localdomain|home\.arpa)$/;

function localV4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 127 || a === 0 // this computer
    || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private networks
    || (a === 169 && b === 254) // link-local
    || (a === 100 && b >= 64 && b <= 127); // shared address space (a tailnet, a carrier's NAT)
}

function localV6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  // an IPv4 address written as IPv6 (::ffff:7f00:1 is 127.0.0.1)
  const mapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return localV4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  // unique local (fc00::/7) and link-local (fe80::/10)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

export function localAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true;
  }
  host = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  const kind = isIP(host);
  if (kind === 4) return localV4(host);
  if (kind === 6) return localV6(host);
  // a name with no dot is one only this computer or its network knows
  return !host.includes(".") || LOCAL_NAME.test(host);
}
