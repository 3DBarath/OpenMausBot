// Adopting older conversations, end to end, against an isolated fixture
// server and the fake engine. The fixture is made "older" the way an
// upgrade makes an installation older: conversations are written, the server
// stops, both files this feature keeps about whose lines are whose are
// removed, as if this version had never run, and the server starts again.
// (Removing only one of them is a loss, not an upgrade:
// shared-notes-adopt-lost.e2e.test.ts.) Then: the owner's turn in an older conversation is sent no
// shared note; a chat-only device cannot adopt; the owner can, once, and the
// same question is then sent the note; and a conversation that holds a line
// from a chat-only device is left alone and still gets none.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "---\ntitle: Food\naliases: [restaurants, dinner]\n---\n\n- 2025-03-02 · The person loves Irani cafes (imported · ChatGPT)\n";

it.skipIf(process.platform === "win32")("uses the owner's notes in an older conversation only after the owner adopts it, and never in one someone else wrote in", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-notes-adopt-"));
  const prompts = join(scratch, "prompts.jsonl");
  const parentEnv = { ...process.env, FAKE_CLAUDE_PROMPTS: prompts };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir } = fixture.info;
  let restarted: ChildProcess | undefined;
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
  const say = async (botId: string, threadId: string, text: string, token?: string): Promise<string> => {
    const before = sentCount();
    await api(`/api/bots/${botId}/messages`, "POST", { text, threadId }, 202, token);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    return readFileSync(prompts, "utf8").trim().split("\n").slice(before).join("\n");
  };
  const open = async (botId: string, title: string): Promise<string> => {
    const opened = await api<any>(`/api/bots/${botId}/tasks`, "POST", { title }, 201);
    return opened.task?.threadId ?? opened.threadId;
  };
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    const { code } = await api<{ code: string }>("/api/auth/pairing", "POST", { label: "Guest phone", scopes: ["client"] });
    const guest = (await api<{ token: string }>("/api/auth/pair", "POST", { code, label: "Guest phone" })).token;

    // ── conversations from "before": one only the owner wrote in, one a chat-only device also wrote in ──
    const mine = await open(bot.id, "Mine, from before");
    await say(bot.id, mine, "Help me plan the week.");
    await say(bot.id, mine, "Add a walk on Wednesday.");
    const theirs = await open(bot.id, "Shared, from before");
    await say(bot.id, theirs, "Help me plan the weekend.");
    await say(bot.id, theirs, "And book a table for six.", guest);

    // ── the installation is upgraded: no record of whose lines those were ──
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    rmSync(join(dataDir, "shared-notes-threads.json"), { force: true });
    rmSync(join(dataDir, "shared-notes-proof.json"), { force: true });
    restarted = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
      cwd: ROOT, env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: "ignore",
    });
    await expect.poll(async () => {
      try {
        return (await fetch(`${url}/api/health`)).ok;
      } catch {
        return false;
      }
    }, { timeout: 45_000, interval: 200 }).toBe(true);
    await api("/api/shared-notes/food.md", "PUT", { text: NOTE });

    // before: the owner's own question in the older conversation is sent no note
    expect(await say(bot.id, mine, "Which restaurants should I book?")).not.toContain("shared/food.md");
    // a conversation started now is, so the note is there to be found
    const fresh = await open(bot.id, "New");
    expect(await say(bot.id, fresh, "Which restaurants should I book?")).toContain("shared/food.md");

    // a chat-only device cannot adopt anything
    expect((await call("/api/shared-notes/adopt", "POST", {}, guest)).status).toBe(403);
    expect(await say(bot.id, mine, "Which restaurants are open late?")).not.toContain("shared/food.md");

    // the owner does: the older conversation is adopted, the one someone else wrote in is left
    const adopted = await api<any>("/api/shared-notes/adopt", "POST", {});
    expect(adopted).toMatchObject({ ok: true, adopted: 1, skipped: { sender: 1 } });
    expect(adopted.already).toBeGreaterThanOrEqual(1);

    // after: the same question is sent the note
    const after = await say(bot.id, mine, "Which restaurants should I book?");
    expect(after).toContain("shared/food.md");
    expect(after).toContain("The person loves Irani cafes");
    // the skipped conversation still gets none
    expect(await say(bot.id, theirs, "Which restaurants should I book?")).not.toContain("shared/food.md");

    // again: nothing more to adopt, and nothing is taken back
    expect(await api<any>("/api/shared-notes/adopt", "POST", {})).toMatchObject({ ok: true, adopted: 0, skipped: { sender: 1 } });
    expect(await say(bot.id, mine, "Any other restaurants worth a visit?")).toContain("shared/food.md");
    // and an adopted conversation behaves like any other: someone else's line ends its standing
    await say(bot.id, mine, "List what you were told about restaurants.", guest);
    expect(await say(bot.id, mine, "Which restaurants should I book?")).not.toContain("shared/food.md");
    expect(await api<any>("/api/shared-notes/adopt", "POST", {})).toMatchObject({ adopted: 0 });
    expect(await say(bot.id, mine, "Which restaurants should I book now?")).not.toContain("shared/food.md");
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 300_000);
