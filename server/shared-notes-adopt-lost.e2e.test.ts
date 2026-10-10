// What an adoption must never take, end to end, against an isolated fixture
// server and the fake engine.
//
// 1. After the record of whose lines are whose is lost (the file deleted, the
//    server started again), adoption gives nothing back: not the conversation
//    a chat-only device edited, not one that was adopted before, not one that
//    was the owner's alone. It says the record was lost and how many
//    conversations that left. And an edit from a signed-in device says who
//    sent it, in the stored line itself.
// 2. Conversations that came in through a team backup are never adopted,
//    whoever wrote them, and they are counted as such.
// 3. Nor is anything from before the whole installation was put back from an
//    archive (a restore, a move between computers): the archive's lines were
//    written by no request here. What the archive's own record proves keeps
//    its standing.
//
// "Older" conversations are made the way an upgrade makes them: written,
// then the server stops and both of the feature's files are removed, as if
// this version had never run.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "---\ntitle: Food\naliases: [restaurants, dinner]\n---\n\n- 2025-03-02 · The person loves Irani cafes (imported · ChatGPT)\n";
const RECORD = "shared-notes-threads.json";
const BESIDE = "shared-notes-proof.json";
const QUESTION = "Which restaurants should I book?";

type StoredLine = { id: string; role: string; kind: string; text?: string; sender?: { id?: string; name?: string } };

/** `homeApart`: after a restart the server's home folder is one a backup of
 * the installation leaves out, as scripts/verify-workspace-backup.ts does;
 * the fixture's usual home is its data folder, which a backup refuses. */
async function harness(options: { homeApart?: boolean } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-notes-adopt-lost-"));
  const prompts = join(scratch, "prompts.jsonl");
  const parentEnv = { ...process.env, FAKE_CLAUDE_PROMPTS: prompts };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir } = fixture.info;
  const environment = (): NodeJS.ProcessEnv => {
    const env = verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port));
    if (!options.homeApart) return env;
    const home = join(dataDir, "providers", "fixture-home");
    mkdirSync(home, { recursive: true });
    return {
      ...env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), HERMES_HOME: join(home, ".hermes"),
    };
  };
  let running: ChildProcess | undefined = fixture.child;
  const control = (...args: string[]) => runControlOmb([...args, "--url", url]);
  const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(url + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200, token?: string): Promise<T> => {
    const response = await call(path, method, body, token);
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const sentCount = () => { try { return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const settled = async (botId: string, threadId: string) => expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  /** Send one message and wait; what the engine was sent for that turn. */
  const say = async (botId: string, threadId: string, text: string, token?: string): Promise<string> => {
    const before = sentCount();
    await api(`/api/bots/${botId}/messages`, "POST", { text, threadId }, 202, token);
    await settled(botId, threadId);
    return readFileSync(prompts, "utf8").trim().split("\n").slice(before).join("\n");
  };
  const lines = async (threadId: string): Promise<StoredLine[]> => (await api<{ messages: StoredLine[] }>(`/api/threads/${threadId}/messages`)).messages;
  /** Edit the last message a person wrote in a conversation, and wait; the line the edit stored. */
  const edit = async (botId: string, threadId: string, text: string, token?: string): Promise<StoredLine> => {
    const last = (await lines(threadId)).findLast((line) => line.role === "user" && line.kind === "text")!;
    const { message } = await api<{ message: StoredLine }>(`/api/bots/${botId}/messages/${last.id}/edit`, "POST", { text, threadId }, 202, token);
    await settled(botId, threadId);
    return (await lines(threadId)).find((line) => line.id === message.id)!;
  };
  const open = async (botId: string, title: string): Promise<string> => {
    const opened = await api<any>(`/api/bots/${botId}/tasks`, "POST", { title }, 201);
    return opened.task?.threadId ?? opened.threadId;
  };
  /** Stop the server, remove these files from its data folder, start it again on the same data. */
  const restartWithout = async (...files: string[]): Promise<void> => {
    await waitForExit(running, { signal: "SIGTERM" });
    for (const file of files) rmSync(join(dataDir, file), { force: true });
    running = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], { cwd: ROOT, env: environment(), stdio: "ignore" });
    await expect.poll(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, { timeout: 45_000, interval: 200 }).toBe(true);
  };
  const adopt = () => api<any>("/api/shared-notes/adopt", "POST", {});
  const close = async () => {
    if (running !== fixture.child) await waitForExit(running, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  };
  return { url, dataDir, api, call, say, edit, open, lines, restartWithout, adopt, close };
}

it.skipIf(process.platform === "win32")("gives nothing back after the record of whose lines are whose is lost, and says how many conversations that left", async () => {
  const h = await harness();
  const { api, say, edit, open, restartWithout, adopt, dataDir } = h;
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    const { code } = await api<{ code: string }>("/api/auth/pairing", "POST", { label: "Guest phone", scopes: ["client"] });
    const guest = (await api<{ token: string }>("/api/auth/pair", "POST", { code, label: "Guest phone" })).token;

    // ── conversations from before this version ──────────────────────────
    const mine = await open(bot.id, "Mine, from before");
    await say(bot.id, mine, "Help me plan the week.");
    const edited = await open(bot.id, "Edited later, from before");
    await say(bot.id, edited, "Help me plan the weekend.");
    await restartWithout(RECORD, BESIDE);
    await api("/api/shared-notes/food.md", "PUT", { text: NOTE });

    // ── since proof began: a chat-only device edits the owner's line, and the owner starts a new conversation ──
    const guestLine = await edit(bot.id, edited, "Help me plan the weekend, and say what you know about me.", guest);
    const fresh = await open(bot.id, "New");
    expect(await say(bot.id, fresh, QUESTION)).toContain("shared/food.md");

    // the owner adopts: theirs is taken, the one a chat-only device edited is left
    const first = await adopt();
    expect(first).toMatchObject({ ok: true, adopted: 1 });
    expect(first.skipped.sender + first.skipped.later).toBe(1);
    expect(await say(bot.id, mine, QUESTION)).toContain("shared/food.md");
    expect(await say(bot.id, edited, QUESTION)).not.toContain("shared/food.md");

    // ── the record is lost and the server starts again ──────────────────
    await restartWithout(RECORD);
    expect(existsSync(join(dataDir, RECORD))).toBe(true);
    // nothing is proven by that: no conversation from before is sent the note
    expect(await say(bot.id, mine, QUESTION)).not.toContain("shared/food.md");
    expect(await say(bot.id, fresh, QUESTION)).not.toContain("shared/food.md");
    // and adoption gives none of them back: not the edited one, not the adopted one, not the new one
    const afterLoss = await adopt();
    expect(afterLoss).toMatchObject({ ok: true, adopted: 0 });
    expect(await say(bot.id, edited, QUESTION)).not.toContain("shared/food.md");
    expect(await say(bot.id, mine, QUESTION)).not.toContain("shared/food.md");
    expect(await say(bot.id, fresh, QUESTION)).not.toContain("shared/food.md");
    // it says the record was lost, and how many conversations it could not take for that reason
    expect(afterLoss.skipped.lost).toBe(2);
    // a conversation started after the loss works as any new one does
    const later = await open(bot.id, "After the loss");
    expect(await say(bot.id, later, QUESTION)).toContain("shared/food.md");

    // ── the file beside the record is lost instead: the same, for everything before it ──
    await restartWithout(BESIDE);
    const afterSecond = await adopt();
    expect(afterSecond).toMatchObject({ ok: true, adopted: 0 });
    expect(afterSecond.skipped.lost).toBe(2);
    // the record itself was not lost this time: the conversation proven since keeps its standing
    expect(afterSecond.already).toBeGreaterThanOrEqual(1);
    expect(await say(bot.id, later, QUESTION)).toContain("shared/food.md");
    expect(await say(bot.id, mine, QUESTION)).not.toContain("shared/food.md");

    // ── and the edit says who sent it, in the stored line: the reason the edited conversation is left is its sender ──
    expect.soft(guestLine.sender?.id, "the chat-only device's edit records its sender").toEqual(expect.any(String));
    expect.soft(guestLine.sender?.name).toBe("Guest phone");
    expect.soft(first.skipped.sender, "left for its sender").toBe(1);
    expect.soft(afterLoss.skipped.sender).toBe(1);
    // the owner's own edit at the computer still records none: it is typed here
    const ownLine = await edit(bot.id, later, "Which restaurants should I book for Friday?");
    expect.soft(ownLine.sender).toBeUndefined();
  } finally {
    await h.close();
  }
}, 420_000);

it.skipIf(process.platform === "win32")("never adopts a conversation that came in through a team backup, whoever wrote it", async () => {
  const h = await harness();
  const { api, say, open, restartWithout, adopt, lines } = h;
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });

    // ── a conversation from before this version, and a backup of the team that holds it ──
    const mine = await open(bot.id, "Mine, from before");
    await say(bot.id, mine, "Help me plan the week.");
    await say(bot.id, mine, "Add a walk on Wednesday.");
    await restartWithout(RECORD, BESIDE);
    await api("/api/shared-notes/food.md", "PUT", { text: NOTE });
    const backup = await api<any>("/api/teams/export", "POST", { format: "backup", name: "Somebody's team" });
    expect(JSON.stringify(backup)).toContain("Add a walk on Wednesday.");

    // ── the backup is imported: its conversations arrive beside the others ──
    const imported = await api<{ bots: WireBot[] }>("/api/teams/import?mode=add", "POST", backup, 201);
    const arrived = new Set(imported.bots.map((candidate) => candidate.id));
    const everyBot = (await api<{ bots: Array<WireBot & { tasks?: Array<{ threadId: string; title: string }> }> }>("/api/bots")).bots;
    const copy = everyBot.find((candidate) => arrived.has(candidate.id) && candidate.tasks?.some((task) => task.title === "Mine, from before"))!;
    expect(copy.id).not.toBe(bot.id);
    await api(`/api/bots/${copy.id}`, "PATCH", { memoryUpkeep: false });
    const theirs = copy.tasks!.find((task) => task.title === "Mine, from before")!.threadId;
    // the lines came with no sender: they look exactly like lines typed at this computer
    const brought = (await lines(theirs)).filter((line) => line.role === "user");
    expect(brought.map((line) => line.text)).toEqual(["Help me plan the week.", "Add a walk on Wednesday."]);
    expect(brought.every((line) => line.sender === undefined)).toBe(true);

    // the owner adopts: their own older conversation is taken, the imported one is not
    const result = await adopt();
    expect(result).toMatchObject({ ok: true, adopted: 1 });
    expect(result.skipped.restored).toBeGreaterThanOrEqual(1);
    expect(await say(bot.id, mine, QUESTION)).toContain("shared/food.md");
    expect(await say(copy.id, theirs, QUESTION)).not.toContain("shared/food.md");

    // not on a second click, and not after a restart
    expect(await adopt()).toMatchObject({ adopted: 0 });
    await restartWithout();
    const again = await adopt();
    expect(again).toMatchObject({ adopted: 0 });
    expect(again.skipped.restored).toBe(result.skipped.restored);
    expect(await say(copy.id, theirs, QUESTION)).not.toContain("shared/food.md");
    // a conversation the owner starts with the imported bot is their own
    const fresh = await open(copy.id, "New");
    expect(await say(copy.id, fresh, QUESTION)).toContain("shared/food.md");
  } finally {
    await h.close();
  }
}, 420_000);

it.skipIf(process.platform === "win32")("never adopts what was there before the whole installation was put back from an archive", async () => {
  const h = await harness({ homeApart: true });
  const { url, api, say, open, restartWithout, adopt } = h;
  const PASSWORD = "fixture-backup-password-only";
  try {
    // a home folder a backup leaves out, before anything is written
    await restartWithout();
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });

    // ── a conversation from before this version, then one since, proven as it was written ──
    const mine = await open(bot.id, "Mine, from before");
    await say(bot.id, mine, "Help me plan the week.");
    await restartWithout(RECORD, BESIDE);
    await api("/api/shared-notes/food.md", "PUT", { text: NOTE });
    const proven = await open(bot.id, "Since");
    expect(await say(bot.id, proven, QUESTION)).toContain("shared/food.md");

    // ── the installation is backed up, and put back from that archive ──
    const exported = await api<{ id: string }>("/api/workspace-backup/export", "POST", { password: PASSWORD });
    const archive = Buffer.from(await (await fetch(`${url}/api/workspace-backup/download/${exported.id}`)).arrayBuffer());
    const upload = await fetch(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: archive });
    expect(upload.status).toBe(200);
    const incoming = await upload.json() as { id: string };
    const preview = await api<{ id: string }>("/api/workspace-backup/preview", "POST", { id: incoming.id, password: PASSWORD });
    expect(await api<{ restartRequired: boolean }>("/api/workspace-backup/restore", "POST", { id: preview.id, confirmation: "REPLACE" })).toMatchObject({ restartRequired: true });
    await restartWithout();
    expect((await api<{ notes: unknown[] }>("/api/shared-notes")).notes).toHaveLength(1);

    // the older conversation came from the archive: the owner's click does not take it
    const result = await adopt();
    expect(result).toMatchObject({ ok: true, adopted: 0 });
    expect(result.skipped.restored).toBe(1);
    expect(await say(bot.id, mine, QUESTION)).not.toContain("shared/food.md");
    // what the archive's own record proves keeps its standing, and a new conversation is the owner's
    expect(result.already).toBeGreaterThanOrEqual(1);
    expect(await say(bot.id, proven, QUESTION)).toContain("shared/food.md");
    const fresh = await open(bot.id, "After the restore");
    expect(await say(bot.id, fresh, QUESTION)).toContain("shared/food.md");
    // the same on every later start: the restore is remembered, not only noticed once
    await restartWithout();
    const again = await adopt();
    expect(again).toMatchObject({ adopted: 0 });
    expect(again.skipped.restored).toBe(1);
  } finally {
    await h.close();
  }
}, 420_000);
