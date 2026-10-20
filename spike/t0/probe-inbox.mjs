// Runs INSIDE a T0 box. Does the things a hostile bot would try and reports what it found. Prints one JSON line.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const env = process.env;
const out = { role: "in-box" };
const can = (fn) => { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, err: e.code ?? e.message }; } };
const marker = env.T0_SECRET_MARKER ?? "SECRET-MARKER";

// A) can it find the model key anywhere it can see?  (T0_SECRET_MARKER is test scaffolding that tells the probe what
// to grep for; it is not present in a real box, so it is excluded from the leak check.)
out.keyInEnv = Object.entries(env).some(([k, v]) => k !== "T0_SECRET_MARKER" && typeof v === "string" && v.includes(marker));
out.keyInToken = (env.T0_TOKEN ?? "").includes(marker);
let fsHits = 0;
const walk = (dir, depth) => {
  if (depth > 4) return;
  for (const name of can(() => readdirSync(dir, { withFileTypes: true })).value ?? []) {
    const p = `${dir}/${name.name}`;
    if (name.isDirectory()) walk(p, depth + 1);
    else { const r = can(() => readFileSync(p, "utf8")); if (r.ok && r.value.includes(marker)) fsHits++; }
  }
};
for (const root of ["/run/t0", env.HOME, process.cwd()]) if (root) walk(root, 0);
out.keyOnDisk = fsHits;

// B) the server's private data must be invisible (not bound into the box).
out.readDataDir = can(() => readdirSync(env.T0_DATA_DIR ?? "/nope"));
out.readMessagesDb = can(() => readFileSync(`${env.T0_DATA_DIR}/messages.db`, "utf8").slice(0, 8));
out.readConfig = can(() => readFileSync(`${env.T0_DATA_DIR}/config.json`, "utf8").slice(0, 8));
out.readOtherWorkspace = can(() => readdirSync(env.T0_OTHER_WS ?? "/nope"));
out.readOtherPerson = can(() => readdirSync(env.T0_OTHER_PERSON ?? "/nope"));
out.readFlyApi = can(() => readdirSync("/.fly"));

// C) its own folders must work.
out.ownWorkspaceRW = can(() => { const p = `${process.cwd()}/t0-wrote.txt`; writeFileSync(p, "ok"); return readFileSync(p, "utf8"); });
out.personFolderRW = env.T0_PERSON ? can(() => { const p = `${env.T0_PERSON}/t0-wrote.txt`; writeFileSync(p, "ok"); return readFileSync(p, "utf8"); }) : null;

// D) processes: its PID namespace shows only its own; a host canary is invisible.
out.visiblePids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
out.canaryPidVisible = out.visiblePids.includes(String(env.T0_CANARY_PID ?? "0"));
out.canaryEnvReadable = can(() => readFileSync(`/proc/${env.T0_CANARY_PID}/environ`, "utf8").includes(marker)).value === true;

// E) network: broker with/without token; the server's real loopback port; egress public vs private.
const tcp = (host, port, firstLine, token) => new Promise((resolve) => {
  const s = connect({ host, port }, () => {
    if (firstLine) s.write(firstLine);
    else s.write(`POST /p/anthropic/v1/messages HTTP/1.1\r\nHost: b\r\nx-api-key: ${token ?? ""}\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`);
  });
  let buf = "", done = false;
  const finish = (r) => { if (done) return; done = true; s.destroy(); resolve(r); };
  s.setTimeout(6000, () => finish({ err: "timeout" }));
  // A successful CONNECT tunnel stays open, so resolve as soon as the status line / headers arrive, not on close.
  s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) finish({ status: /^HTTP\/1\.[01] (\d+)/.exec(buf)?.[1], body: buf.slice(0, 120) }); });
  s.on("error", (e) => finish({ err: e.code }));
  s.on("close", () => finish({ status: /^HTTP\/1\.[01] (\d+)/.exec(buf)?.[1], body: buf.slice(0, 120) }));
});
out.brokerWithToken = await tcp("127.0.0.1", Number(env.T0_BROKER_PORT), null, env.T0_TOKEN);
out.brokerNoToken = await tcp("127.0.0.1", Number(env.T0_BROKER_PORT), null, "");
out.serverLoopbackPort = await tcp("127.0.0.1", Number(env.T0_SERVER_PORT ?? 8799), "GET / HTTP/1.1\r\nHost: x\r\nconnection: close\r\n\r\n");
out.egressToPrivate = await tcp("127.0.0.1", Number(env.T0_EGRESS_PORT), `CONNECT ${env.T0_PRIVATE_TARGET}\r\nHost: x\r\n\r\n`);
out.egressToPublic = await tcp("127.0.0.1", Number(env.T0_EGRESS_PORT), `CONNECT ${env.T0_PUBLIC_TARGET ?? "example.com:443"}\r\nHost: x\r\n\r\n`);

console.log(JSON.stringify(out));
