// Host orchestrator for the bwrap box security matrix, run on the Fly test machine as `maus`.
// Sets up fixtures, starts a fake upstream + the broker + the egress gate on unix sockets, starts a canary process,
// spawns probe-inbox.mjs inside a bwrap box granted only one workspace + one person folder, and prints the box's report.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createBroker } from "./broker.mjs";
import { createEgressGate } from "./egress.mjs";
import { spawnInBox, BROKER_PORT, EGRESS_PORT } from "./box.mjs";

const MARKER = "SECRET-MARKER-" + "Z".repeat(10);
const REAL_KEY = "sk-ant-" + MARKER + "-" + "x".repeat(16);
const root = join(tmpdir(), "t0e2e-" + Date.now());
const data = join(root, "server-data");       // the server's private dir (NOT bound into the box)
const wsA = join(root, "ws", "botA");          // this bot's workspace (bound rw)
const wsB = join(root, "ws", "botB");          // another bot's workspace (NOT bound)
const personA = join(root, "people", "pA");    // asking person's folder (bound rw)
const personB = join(root, "people", "pB");    // another person's folder (NOT bound)
const home = join(root, "home");               // engine HOME (bound rw)
for (const d of [data, wsA, wsB, personA, personB, home]) mkdirSync(d, { recursive: true });
writeFileSync(join(data, "messages.db"), "SQLite format 3\x00 " + MARKER);
writeFileSync(join(data, "config.json"), JSON.stringify({ anthropic: { key: REAL_KEY } }));
writeFileSync(join(wsB, "botB-notes.md"), "botB private " + MARKER);
writeFileSync(join(personB, "about.json"), "person B " + MARKER);

// A canary process holding the secret in its environment, so the box can try to read another turn's env.
const canary = spawn("sleep", ["120"], { env: { ...process.env, T0_CANARY_SECRET: MARKER }, detached: true, stdio: "ignore" });
canary.unref();

const upstream = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, content: [{ type: "text", text: "hi" }] })); });
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");

const sockDir = join(root, "sock"); mkdirSync(sockDir);
const brokerSock = join(sockDir, "broker.sock"), egressSock = join(sockDir, "egress.sock");
const { server: brokerServer, mintTurn } = createBroker({ credentials: { anthropic: REAL_KEY }, upstreams: { anthropic: `http://127.0.0.1:${upstream.address().port}` }, log: () => {} });
brokerServer.listen(brokerSock); await once(brokerServer, "listening");
const { server: egressServer } = createEgressGate({ log: () => {} });
egressServer.listen(egressSock); await once(egressServer, "listening");

const token = mintTurn({ turnId: "turn-A", providers: ["anthropic"] });

// Mutation knobs: T0_MUTATE=bind-data (grant the data dir), bind-otherws (grant another bot/person), share-pid (no PID ns).
const mutate = (process.env.T0_MUTATE ?? "").split(",").filter(Boolean);
const spec = {
  workspace: wsA, person: personA, home,
  readOnly: [...(mutate.includes("bind-data") ? [data] : []), ...(mutate.includes("bind-otherws") ? [wsB, personB] : [])],
  noUnsharePid: mutate.includes("share-pid"),
  sockets: { broker: brokerSock, egress: egressSock },
  env: {
    T0_TOKEN: token, T0_SECRET_MARKER: MARKER,
    T0_DATA_DIR: data, T0_OTHER_WS: wsB, T0_OTHER_PERSON: personB, T0_PERSON: personA,
    T0_CANARY_PID: String(canary.pid), T0_BROKER_PORT: String(BROKER_PORT), T0_EGRESS_PORT: String(EGRESS_PORT),
    T0_SERVER_PORT: String(upstream.address().port), T0_PRIVATE_TARGET: `127.0.0.1:${upstream.address().port}`,
    T0_PUBLIC_TARGET: process.env.T0_PUBLIC_TARGET ?? "example.com:443",
  },
};
// Host-side control: does the egress gate itself reach the public internet? (isolates a Fly network block from a box bug)
const net = await import("node:net");
const hostEgress = await new Promise((resolve) => {
  const s = net.connect({ path: egressSock }, () => s.write(`CONNECT ${spec.env.T0_PUBLIC_TARGET}\r\nHost: x\r\n\r\n`));
  let buf = ""; s.setTimeout(8000, () => { s.destroy(); resolve("timeout"); });
  s.on("data", (d) => { buf += d; if (buf.includes("\r\n\r\n")) { s.destroy(); resolve(/^HTTP\/1\.[01] (\d+)/.exec(buf)?.[1] ?? buf.slice(0, 40)); } });
  s.on("error", (e) => resolve(e.code));
});
const child = spawnInBox(spec, [process.execPath, "/opt/t0/probe-inbox.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
const [code] = await once(child, "exit");

let report = null; try { report = JSON.parse(stdout.trim().split("\n").pop()); } catch {}
// Also confirm from the host side that a model call with the token reaches the upstream with the real key.
const verdict = report && {
  // PASS means the hostile attempt failed / the legitimate one worked.
  "cannot read messages.db": report.readMessagesDb.ok === false,
  "cannot read config/keys": report.readConfig.ok === false,
  "cannot list data dir": report.readDataDir.ok === false,
  "cannot read other bot workspace": report.readOtherWorkspace.ok === false,
  "cannot read other person folder": report.readOtherPerson.ok === false,
  "cannot see Fly api socket": report.readFlyApi.ok === false,
  "no model key in env": report.keyInEnv === false,
  "no model key on disk": report.keyOnDisk === 0,
  "cannot see other turn's pid": report.canaryPidVisible === false,
  "cannot read other turn's env": report.canaryEnvReadable === false,
  "own workspace is read-write": report.ownWorkspaceRW.ok === true && report.ownWorkspaceRW.value === "ok",
  "person folder is read-write": report.personFolderRW?.ok === true,
  "broker call with token works": report.brokerWithToken.status === "200",
  "broker refuses without token": report.brokerNoToken.status === "401",
  "server loopback port unreachable": report.serverLoopbackPort.status === undefined,
  "egress refuses private/loopback": report.egressToPrivate.status === "403",
  "egress allows public": report.egressToPublic.status === "200",
};
console.log(JSON.stringify({ code, hostEgressToPublic: hostEgress, verdict, allPass: verdict && Object.values(verdict).every(Boolean), report, stderr: stderr.slice(-800) }, null, 1));
canary.kill("SIGKILL"); brokerServer.close(); egressServer.close(); upstream.close();
rmSync(root, { recursive: true, force: true });
