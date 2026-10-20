// T0 credential broker (spike). It runs outside the bot box. An engine inside the box is pointed at the broker with its
// provider's base-URL setting and holds only an opaque per-turn token where the key used to be. The broker checks the
// token, strips it, adds the real credential and forwards the request to a fixed upstream, streaming the answer back.
// The same route shape carries remote MCP servers and the harness' capability routes, so nothing secret enters the box.
//
// Plain Node 24, no dependencies, so it runs on a bare Cloud image for the spike. The real build moves this into
// server/ (see T0-SPIKE.md, slice T0b).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** Where each provider's calls go and how its credential is written. The box can never choose an upstream. */
export const PROVIDERS = {
  anthropic: { upstream: "https://api.anthropic.com", inject: (headers, key) => { headers["x-api-key"] = key; } },
  openai: { upstream: "https://api.openai.com", inject: (headers, key) => { headers.authorization = `Bearer ${key}`; } },
  openrouter: { upstream: "https://openrouter.ai/api", inject: (headers, key) => { headers.authorization = `Bearer ${key}`; } },
  gemini: { upstream: "https://generativelanguage.googleapis.com", inject: (headers, key) => { headers["x-goog-api-key"] = key; } },
};

const HOP = new Set(["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
/** Every header a client may carry its key in; all are removed before the real one is added. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key"];

const digest = (token) => createHash("sha256").update(token).digest();

/** Pulls the per-turn token from wherever the provider's SDK puts its key. */
export function presentedToken(headers, url) {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? "")?.[1];
  return bearer ?? headers["x-api-key"] ?? headers["x-goog-api-key"] ?? headers["api-key"] ?? url.searchParams.get("key") ?? null;
}

export function createBroker({ credentials = {}, upstreams = {}, mcp = {}, harness = null, log = () => {} } = {}) {
  const grants = new Map(); // sha256(token) hex -> grant
  const usage = new Map();

  /** One token per turn: which providers and MCP servers it may use, until it is revoked or expires. */
  function mintTurn({ turnId, providers = [], mcpServers = [], ttlMs = 6 * 60 * 60 * 1000 }) {
    const token = `t0_${randomBytes(32).toString("base64url")}`;
    grants.set(digest(token).toString("hex"), { turnId, providers: new Set(providers), mcpServers: new Set(mcpServers), expires: Date.now() + ttlMs });
    return token;
  }
  function revokeTurn(turnId) {
    for (const [key, grant] of grants) if (grant.turnId === turnId) grants.delete(key);
  }
  function grantFor(token) {
    if (typeof token !== "string" || !token.startsWith("t0_")) return null;
    const wanted = digest(token);
    for (const [key, grant] of grants) {
      // Constant-time compare of the digests; the map is small (one entry per live turn).
      if (timingSafeEqual(Buffer.from(key, "hex"), wanted)) {
        if (grant.expires < Date.now()) { grants.delete(key); return null; }
        return grant;
      }
    }
    return null;
  }

  function forward(req, res, target, rewrite) {
    const url = new URL(target);
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP.has(name) && !CREDENTIAL_HEADERS.includes(name) && !name.startsWith("x-t0-")) headers[name] = value;
    }
    url.searchParams.delete("key");
    rewrite(headers, url);
    headers.host = url.host;
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(url, { method: req.method, headers }, (answer) => {
      const out = {};
      for (const [name, value] of Object.entries(answer.headers)) if (!HOP.has(name)) out[name] = value;
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    upstream.on("error", (error) => {
      log({ event: "upstream-error", message: error.message });
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream unreachable" }));
    });
    req.pipe(upstream);
  }

  const refuse = (res, status, why) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: why }));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://broker.invalid");
    const [, kind, name, ...rest] = url.pathname.split("/");
    if (kind === "harness") {
      // Only the bots' capability routes. Their bearer is the harness' own per-turn capability (mintInternalCapability),
      // so it passes through untouched; every other loopback route of the server stays closed to the box.
      const path = `/${[name, ...rest].join("/")}`;
      if (!harness || !path.startsWith("/api/internal/") || path.includes("..")) {
        log({ event: "refused", reason: "harness-route", path });
        return refuse(res, 403, "Only the bot capability routes are reachable from the box.");
      }
      const capability = req.headers.authorization;
      return forward(req, res, `${harness.url}${path}${url.search}`, (headers) => { if (capability) headers.authorization = capability; });
    }
    const grant = grantFor(presentedToken(req.headers, url));
    if (!grant) { log({ event: "refused", reason: "no-turn-token", path: url.pathname }); return refuse(res, 401, "This box has no valid turn token."); }
    const tail = `/${rest.join("/")}${url.search}`;
    if (kind === "p") {
      const provider = PROVIDERS[name];
      const key = credentials[name];
      if (!provider || !key || !grant.providers.has(name)) return refuse(res, 403, `This turn may not use ${name}.`);
      usage.set(grant.turnId, (usage.get(grant.turnId) ?? 0) + 1);
      log({ event: "model-call", turnId: grant.turnId, provider: name, path: tail.split("?")[0] });
      return forward(req, res, `${upstreams[name] ?? provider.upstream}${tail}`, (headers) => provider.inject(headers, key));
    }
    if (kind === "mcp") {
      const server = mcp[name];
      if (!server || !grant.mcpServers.has(name)) return refuse(res, 403, `This turn may not use the ${name} server.`);
      return forward(req, res, `${server.url.replace(/\/+$/, "")}${tail === "/" ? "" : tail}`, (headers) => Object.assign(headers, server.headers ?? {}));
    }
    return refuse(res, 404, "unknown broker route");
  });
  return { server, mintTurn, revokeTurn, usage };
}
