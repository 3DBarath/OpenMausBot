// A Cloud home booted the way the image's launcher boots it, synthetic engines. What a Cloud from before it was only
// its owner's left behind (no ownership record, routines with no writer, the receipt of the owner's copy) is written
// into its files while the server is stopped, exactly as v0.1.91 left them; the next start settles it like any Cloud.
import { randomBytes, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawnWithSecrets } from "./cloud-home-start.ts";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { CLOUD_NOBODY_KEY, markLeftBehind } from "./testing/cloud-left-behind.ts";
import { hostTimeout } from "./testing/host-timeout.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const UNCONFIRMED = "OpenMausBot can't tell who wrote this routine, so it runs without a shell until you confirm it's yours: press Run with full access on its run, or open it and save it.";
const REFUSED = `This bot's engine needs a shell, so this run stopped. ${UNCONFIRMED}`;
const NOTICE = "It can't use a shell until you confirm it's yours: press Run with full access on its run.";
const secret = randomBytes(32).toString("base64url");
let home = "";
let dataDir = "";
let base = "";
let child: ChildProcess | undefined;
let log = "";
let owner = "";

async function api(method: string, path: string, options: { body?: unknown; token?: string; local?: boolean } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.local ? {} : { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function boot(): Promise<void> {
  const offline = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  const port = Number(new URL(base).port);
  log = "";
  child = spawnWithSecrets(process.execPath, ["--import", offline, join(SERVER_DIR, "index.ts")], {
    PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home, USERPROFILE: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
    OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
    OMB_PUBLIC_URL: `https://${HOST}`, OMB_CLOUD_SECRETS_FD: "3",
  }, { OMB_CLOUD_BOOTSTRAP_SECRET: secret }, undefined, true);
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + hostTimeout(20_000);
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** Its files change only while it is stopped: it reads them at start. */
async function whileStopped(change: () => void): Promise<void> {
  await waitForExit(child, { signal: "SIGTERM" });
  change();
  await boot();
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-cloud-routine-owner-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const claude = join(home, "claude-cli.mjs");
  writeFileSync(claude, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(join(home, "claude.json"))};
await import(${JSON.stringify(pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: claude } },
      // An engine that cannot run a turn without its own shell (ACP).
      shelled: { driver: "grokAgent", displayName: "Shelled", config: { cli: join(SERVER_DIR, "testing", "fake-acp-cli.ts") } },
    },
  }));
  base = `http://127.0.0.1:${await freePortBlock([0, 1])}`;
  await boot();
  owner = await adminPairing();
}, hostTimeout(40_000));

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const newBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", { token: owner, body: { name, modelSelection: { instanceId, model: "claude-sonnet-5" } } })).body.bot as { id: string; threadId: string };
async function newRoutine(botId: string, name: string): Promise<string> {
  const created = await api("POST", "/api/routines", { token: owner, body: { name, prompt: "Check the site and fix what is broken.", botId, enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.routine.id as string;
}
const writers = () => JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8")).writers as Record<string, string>;
const routineOf = async (id: string) => ((await api("GET", "/api/routines", { token: owner })).body.routines as any[]).find((routine) => routine.id === id);
const runsOf = async (id: string) => ((await api("GET", "/api/routines", { token: owner })).body.runs as any[]).filter((run) => run.routineId === id);
async function runToEnd(id: string): Promise<any> {
  const started = await api("POST", `/api/routines/${id}/run`, { token: owner });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  let run: any;
  await expect.poll(async () => {
    run = (await runsOf(id)).find((candidate) => candidate.id === started.body.run.id);
    return ["completed", "failed", "cancelled"].includes(run?.status);
  }, { timeout: hostTimeout(20_000) }).toBe(true);
  return run;
}
const routineNotices = async (botId: string) => ((await api("GET", "/api/notifications", { token: owner })).body.notifications as any[])
  .filter((notification) => notification.botId === botId && ["routine-failed", "incident"].includes(notification.kind));
async function runCards(id: string): Promise<any[]> {
  const results = (await routineOf(id))?.resultsThreadId as string | undefined;
  if (!results) return [];
  return ((await api("GET", `/api/threads/${results}/messages`, { token: owner })).body.messages as any[])
    .filter((message) => message.kind === "routine.run" && message.routineRun?.routineId === id).map((message) => message.routineRun);
}

/** As v0.1.91 left a Cloud the owner had copied their computer to: no ownership record yet, no writer for the routines
 * the copy brought (the desktop records none), and the receipt of that restore. */
function asBeforeItWasOnlyYours(routineIds: string[]): void {
  rmSync(join(dataDir, "cloud-owner.json"), { force: true });
  const authors = JSON.parse(readFileSync(join(dataDir, "lending-routines.json"), "utf8"));
  for (const id of routineIds) { delete authors.routines[id]; delete authors.writers?.[id]; }
  writeFileSync(join(dataDir, "lending-routines.json"), JSON.stringify(authors), { mode: 0o600 });
  mkdirSync(join(dataDir, ".backups"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, ".backups", "last-restore.json"), JSON.stringify({ restored: true, id: randomUUID(), summary: {}, clientState: {} }), { mode: 0o600 });
}

it("routines the owner copied in before their Cloud was only theirs: refused on an engine that needs its shell, the owner told once in plain words, one click runs them fully, kept across restarts", async () => {
  const bot = await newBot("Copied site bot", "shelled");
  const copied = await newRoutine(bot.id, "Copied site check");
  await whileStopped(() => asBeforeItWasOnlyYours([copied]));
  // The first personal start found no proof the owner wrote it: nobody's, like production.
  expect(log).toContain("settled what came before");
  expect(writers()[copied]).toBe(CLOUD_NOBODY_KEY);
  // The owner turns it on, as the copy told them to; that alone proves nothing.
  expect((await api("PATCH", `/api/routines/${copied}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  expect(writers()[copied]).toBe(CLOUD_NOBODY_KEY);

  const first = await runToEnd(copied);
  expect(first.status).toBe("failed");
  expect(first.error, "the refusal says plainly why and what to press").toBe(REFUSED);
  const second = await runToEnd(copied);
  expect(second.error).toBe(REFUSED);
  expect((await routineNotices(bot.id)).length, "the owner is told once, not at every run").toBe(1);
  expect((await routineNotices(bot.id))[0].body).toBe(`Copied site check: ${NOTICE}`);
  expect((await runCards(copied)).every((card) => card.needsOwner === true), "each run's card offers Run with full access").toBe(true);

  // A restart neither tells the owner again nor makes the routine theirs.
  await whileStopped(() => {});
  expect(writers()[copied]).toBe(CLOUD_NOBODY_KEY);
  expect((await runToEnd(copied)).error).toBe(REFUSED);
  expect((await routineNotices(bot.id)).length).toBe(1);

  // One click from the owner's own device.
  const confirmed = await api("POST", `/api/routines/${copied}/confirm`, { token: owner });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  await expect.poll(async () => (await runCards(copied)).some((card) => card.needsOwner), { timeout: hostTimeout(5_000) }).toBe(false);
  const fully = await runToEnd(copied);
  expect(fully.error ?? null).toBeNull();
  expect(fully.status).toBe("completed");
  await whileStopped(() => {});
  const afterRestart = await runToEnd(copied);
  expect(afterRestart.status, "the owner's confirmation survives a restart").toBe("completed");
  expect((await runCards(copied)).at(-1)?.needsOwner).toBeUndefined();
}, hostTimeout(150_000));

it("on an engine that can confine it, such a routine runs without a shell, says so once, and runs with it once the owner confirms", async () => {
  const bot = await newBot("Copied report bot", "claude");
  const copied = await newRoutine(bot.id, "Copied weekly report");
  await whileStopped(() => asBeforeItWasOnlyYours([copied]));
  expect(writers()[copied]).toBe(CLOUD_NOBODY_KEY);
  const dump = join(home, "claude.json");
  const argv = () => JSON.parse(readFileSync(dump, "utf8")).argv as string[];
  rmSync(dump, { force: true });
  expect((await runToEnd(copied)).status).toBe("completed");
  expect(existsSync(dump)).toBe(true);
  expect(argv()).toContain("--restricted");
  await runToEnd(copied);
  expect((await routineNotices(bot.id)).length).toBe(1);
  expect((await routineNotices(bot.id))[0].body).toBe(`Copied weekly report: ${NOTICE}`);
  expect((await api("POST", `/api/routines/${copied}/confirm`, { token: owner })).status).toBe(200);
  rmSync(dump, { force: true });
  expect((await runToEnd(copied)).status).toBe("completed");
  expect(argv()).not.toContain("--restricted");
}, hostTimeout(120_000));

it("a routine someone else wrote stays confined: turning it on, running it, notices and restarts never make it the owner's; only the owner's device can confirm one", async () => {
  const bot = await newBot("Guest's routine bot", "claude");
  const theirs = await newRoutine(bot.id, "Guest's routine");
  // What a guest left behind is nobody's once settled.
  await whileStopped(() => markLeftBehind(dataDir, { routineIds: [theirs] }));
  expect((await api("PATCH", `/api/routines/${theirs}`, { token: owner, body: { enabled: true } })).status).toBe(200);
  const dump = join(home, "claude.json");
  const argv = () => JSON.parse(readFileSync(dump, "utf8")).argv as string[];
  rmSync(dump, { force: true });
  await runToEnd(theirs);
  expect(argv()).toContain("--restricted");
  await whileStopped(() => {});
  expect(writers()[theirs]).toBe(CLOUD_NOBODY_KEY);
  rmSync(dump, { force: true });
  await runToEnd(theirs);
  expect(argv()).toContain("--restricted");
  // A bot's shell is a local process without a session: it cannot confirm anything.
  expect((await api("POST", `/api/routines/${theirs}/confirm`, { local: true })).status).toBe(403);
  expect(writers()[theirs]).toBe(CLOUD_NOBODY_KEY);
  // A routine that is already the owner's needs nothing.
  const mine = await newRoutine(bot.id, "Owner's own routine");
  expect((await api("POST", `/api/routines/${mine}/confirm`, { token: owner })).status).toBe(200);
  expect((await api("POST", "/api/routines/no-such-routine/confirm", { token: owner })).status).toBe(404);
}, hostTimeout(120_000));
