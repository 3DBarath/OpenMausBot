// Proves the broker: a client holding only a per-turn token (never the real key) makes a model call that succeeds, the
// fake upstream sees the REAL key, and a request without / with a wrong / with a revoked token is refused. The fake
// upstream stands in for api.anthropic.com so no real call is made. Run: node spike/t0/broker.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBroker } from "./broker.mjs";

const REAL_KEY = "sk-ant-REAL-" + "x".repeat(24);
let sawAuthHeader = null, sawTokenLeak = false, calls = 0;

const upstream = createServer((req, res) => {
  calls++;
  sawAuthHeader = req.headers["x-api-key"] ?? null;
  // The box's token must never reach the upstream.
  if ((req.headers["x-api-key"] ?? "").startsWith("t0_")) sawTokenLeak = true;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, model: "fake", content: [{ type: "text", text: "hi" }] }));
});
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

const logs = [];
const { server, mintTurn, revokeTurn, usage } = createBroker({
  credentials: { anthropic: REAL_KEY },
  upstreams: { anthropic: upstreamUrl },
  log: (e) => logs.push(e),
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const brokerUrl = `http://127.0.0.1:${server.address().port}`;

const token = mintTurn({ turnId: "turn-1", providers: ["anthropic"] });
assert.ok(token.startsWith("t0_"));
assert.ok(!token.includes(REAL_KEY));

// 1. A call with the per-turn token in the x-api-key slot (where the Anthropic SDK puts its key) succeeds.
const good = await fetch(`${brokerUrl}/p/anthropic/v1/messages`, {
  method: "POST", headers: { "x-api-key": token, "content-type": "application/json" },
  body: JSON.stringify({ model: "claude", messages: [] }),
});
assert.equal(good.status, 200, "model call through the broker should succeed");
assert.deepEqual((await good.json()).ok, true);
assert.equal(sawAuthHeader, REAL_KEY, "upstream must receive the REAL key");
assert.equal(sawTokenLeak, false, "the per-turn token must never reach the upstream");

// 2. No token -> 401.
const anon = await fetch(`${brokerUrl}/p/anthropic/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(anon.status, 401);

// 3. Wrong token -> 401.
const wrong = await fetch(`${brokerUrl}/p/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": "t0_" + "a".repeat(40) }, body: "{}" });
assert.equal(wrong.status, 401);

// 4. Valid token, provider not granted -> 403.
const gemini = await fetch(`${brokerUrl}/p/gemini/v1/x`, { method: "POST", headers: { "x-api-key": token }, body: "{}" });
assert.equal(gemini.status, 403);

// 5. Revoked token -> 401, and the real key still never appeared client-side.
revokeTurn("turn-1");
const afterRevoke = await fetch(`${brokerUrl}/p/anthropic/v1/messages`, { method: "POST", headers: { "x-api-key": token }, body: "{}" });
assert.equal(afterRevoke.status, 401);

assert.equal(usage.get("turn-1"), 1, "one model call recorded for the turn");
assert.equal(calls, 1, "only the one authorized call reached the upstream");

server.close(); upstream.close();
console.log(JSON.stringify({
  ok: true,
  modelCallThroughBroker: good.status,
  upstreamReceivedRealKey: sawAuthHeader === REAL_KEY,
  tokenLeakedToUpstream: sawTokenLeak,
  refused: { noToken: anon.status, wrongToken: wrong.status, ungrantedProvider: gemini.status, revoked: afterRevoke.status },
  callsRecorded: usage.get("turn-1"),
}, null, 1));
