// T0 egress gate (spike): an HTTP proxy (CONNECT for TLS, absolute-URI for plain HTTP) that is the box's only way out.
// It resolves names itself and connects only to the exact addresses it checked, so neither DNS rebinding nor a redirect
// reaches loopback, Fly's private 6PN network, link-local, or cloud metadata. Same address classes as the bots'
// browser gate (server/browser/egress/policy.ts, `cloud` host); the real build reuses refusalFor() from there and keeps
// one policy for both. HTTP CONNECT rather than SOCKS because npm, git, pip, curl, Claude Code and Codex all honour
// HTTPS_PROXY, while only some speak SOCKS.
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";
import { networkInterfaces } from "node:os";

const fam = (a) => (isIP(a) === 6 ? "ipv6" : "ipv4");
const nets = (list) => { const b = new BlockList(); for (const [n, p] of list) b.addSubnet(n, p, fam(n)); return b; };
const LOOPBACK = nets([["127.0.0.0", 8], ["::1", 128]]);
const RESERVED = nets([["0.0.0.0", 8], ["198.18.0.0", 15], ["224.0.0.0", 3], ["::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["ff00::", 8], ["64:ff9b::", 96], ["2002::", 16]]);
const LINK_LOCAL = nets([["169.254.0.0", 16], ["fe80::", 10]]);
const PRIVATE = nets([["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16], ["fc00::", 7]]);

function own() {
  const b = new BlockList();
  for (const e of Object.values(networkInterfaces()).flat()) if (e) b.addAddress(e.address.split("%")[0], e.family === "IPv6" ? "ipv6" : "ipv4");
  return b;
}

/** null when the address is on the public internet, else why not. IPv4-mapped IPv6 is judged as its IPv4. */
export function refusal(raw) {
  let a = raw.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (!isIP(a)) return "not-an-address";
  const f = fam(a);
  if (LOOPBACK.check(a, f)) return "loopback";
  if (RESERVED.check(a, f)) return "reserved";
  if (LINK_LOCAL.check(a, f)) return "link-local-or-metadata";
  if (PRIVATE.check(a, f)) return "private-network";
  if (own().check(a, f)) return "this-machine";
  return null;
}

async function checked(host, port, allowPorts) {
  if (allowPorts && !allowPorts.has(port)) return { why: `port ${port}` };
  const name = host.replace(/^\[|\]$/g, "");
  const addresses = isIP(name) ? [{ address: name }] : await lookup(name, { all: true }).catch(() => []);
  if (!addresses.length) return { why: "unresolvable" };
  for (const { address } of addresses) {
    const why = refusal(address);
    if (why) return { why: `${why} (${address})` };
  }
  return { address: addresses[0].address };
}

export function createEgressGate({ allowPorts = new Set([80, 443]), log = () => {} } = {}) {
  const server = createServer(async (req, res) => {
    // Plain HTTP through the proxy: an absolute URI.
    let target;
    try { target = new URL(req.url ?? ""); } catch { res.writeHead(400).end("absolute URI required"); return; }
    if (target.protocol !== "http:") { res.writeHead(400).end("use CONNECT for https"); return; }
    const port = Number(target.port || 80);
    const ok = await checked(target.hostname, port, allowPorts);
    if (!ok.address) { log({ event: "egress-refused", host: target.hostname, port, why: ok.why }); res.writeHead(403).end(`refused: ${ok.why}`); return; }
    const headers = { ...req.headers, host: target.host };
    delete headers["proxy-connection"]; delete headers["proxy-authorization"];
    const up = httpRequest({ host: ok.address, port, path: `${target.pathname}${target.search}`, method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers); answer.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on("connect", async (req, socket, head) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? "");
    if (!m) { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const port = Number(m[2]);
    const ok = await checked(m[1], port, allowPorts);
    if (!ok.address) {
      log({ event: "egress-refused", host: m[1], port, why: ok.why });
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nrefused: ${ok.why}\n`);
      return;
    }
    const up = connect({ host: ok.address, port }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  return { server };
}
