// Host orchestrator for the in-box compatibility matrix, as `maus` on the Fly test machine.
// Starts only the egress gate (npm needs the internet through it), then runs compat-inbox.mjs inside a bwrap box.
import { mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressGate } from "./egress.mjs";
import { spawnInBox, EGRESS_PORT, BROKER_PORT } from "./box.mjs";

const root = join(tmpdir(), "t0compat-" + Date.now());
const ws = join(root, "ws"), home = join(root, "home"), sockDir = join(root, "sock");
for (const d of [ws, home, sockDir]) mkdirSync(d, { recursive: true });
const egressSock = join(sockDir, "egress.sock"), brokerSock = join(sockDir, "broker.sock");

const { server: egress } = createEgressGate({ log: () => {} });
egress.listen(egressSock); await once(egress, "listening");
// box.mjs always bridges both sockets; a dummy broker socket keeps box-init happy (compat does no model calls).
const net = await import("node:net");
const dummy = net.createServer(() => {}); dummy.listen(brokerSock); await once(dummy, "listening");

const spec = {
  workspace: ws, home,
  sockets: { broker: brokerSock, egress: egressSock },
  env: { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? "/opt/openmausbot-browser/chrome" },
};
const child = spawnInBox(spec, [process.execPath, "/opt/t0/compat-inbox.mjs"], { stdio: ["ignore", "pipe", "pipe"] });
let o = "", e = ""; child.stdout.on("data", (d) => (o += d)); child.stderr.on("data", (d) => (e += d));
const [code] = await once(child, "exit");
let report = null; try { report = JSON.parse(o.trim().split("\n").pop()); } catch {}
console.log(JSON.stringify({ code, egressPort: EGRESS_PORT, brokerPort: BROKER_PORT, summary: report?.summary, report, stderr: e.slice(-600) }, null, 1));
egress.close(); dummy.close();
rmSync(root, { recursive: true, force: true });
