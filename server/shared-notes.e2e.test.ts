// Shared notes end to end, against an isolated fixture server and the fake
// engine: a note saved through the API is recalled in the owner's one-to-one
// chats, by any bot, and never in a routine run or a room. They are the
// owner's alone: a device paired with chat-only access neither reads them
// nor has them recalled in its chats, while the owner's own paired device
// does. FAKE_CLAUDE_PROMPTS records what each turn was sent, which is where
// recall shows.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";

it("recalls a shared note in the owner's 1:1 chats with any bot, and never in a routine run, a room or someone else's chat", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-shared-notes-"));
  const prompts = join(scratch, "prompts.jsonl");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_PROMPTS: prompts });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200, token?: string): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  /** Pair a device the way Remote access does, and return its session token. */
  const pair = async (label: string, scopes: string[]): Promise<string> => {
    const { code } = await api<{ code: string }>("/api/auth/pairing", "POST", { label, scopes });
    return (await api<{ token: string }>("/api/auth/pair", "POST", { code, label })).token;
  };
  const sentSince = (count: number) => readFileSync(prompts, "utf8").trim().split("\n").slice(count).join("\n");
  const sentCount = () => { try { return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const turn = async (botId: string, threadId: string, text: string) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  };
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    const { bot: other } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Other" }, 201);
    // upkeep off: this is about what recall reads, not what capture notices
    for (const id of [bot.id, other.id]) await api(`/api/bots/${id}`, "PATCH", { memoryUpkeep: false });

    const text = "---\ntitle: Food\naliases: [restaurants, dinner]\n---\n\n- 2025-03-02 · The person loves Irani cafes (imported · ChatGPT)\n";
    expect(await api("/api/shared-notes/food.md", "PUT", { text })).toMatchObject({ name: "food.md", title: "Food", entries: 1, imported: 1 });
    expect((await api("/api/shared-notes")).notes).toMatchObject([{ name: "food.md" }]);
    expect(readFileSync(join(fixture.info.dataDir, "shared-notes", "food.md"), "utf8")).toBe(text);

    // a one-to-one chat the person started: recalled, by either bot
    for (const one of [bot, other]) {
      const before = sentCount();
      await turn(one.id, one.threadId, "Can you suggest some restaurants for Friday?");
      expect(sentSince(before)).toContain("shared/food.md");
      expect(sentSince(before)).toContain("The person loves Irani cafes (imported · ChatGPT)");
    }

    // never in a routine run
    const { routine } = await api("/api/routines", "POST", {
      name: "Dinner picks", prompt: "Suggest some restaurants for dinner.", botId: bot.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    let before = sentCount();
    const { run } = await api(`/api/routines/${routine.id}/run`, "POST", undefined, 201);
    await expect.poll(async () => (await api("/api/routines")).runs.find((entry: any) => entry.id === run.id)?.status, { timeout: 30_000 }).toBe("completed");
    expect(sentSince(before)).toContain("Suggest some restaurants for dinner.");
    expect(sentSince(before)).not.toContain("shared/food.md");

    // never in a room
    const { group } = await api<{ group: { id: string } }>("/api/groups", "POST", {
      name: "Dinner room", memberIds: [bot.id, other.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    }, 201);
    before = sentCount();
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Memo, which restaurants should we book for dinner?" }, 202);
    await expect.poll(() => sentSince(before).includes("which restaurants should we book"), { timeout: 30_000 }).toBe(true);
    expect(await control("wait", "--bot", bot.id, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSince(before)).not.toContain("shared/food.md");
    expect(sentSince(before)).not.toContain("Irani cafes");

    // ── other people on the installation ────────────────────────────────
    // A device paired with chat-only access is someone else: it cannot read
    // the notes, and its own one-to-one chat never recalls them.
    const guest = await pair("Guest phone", ["client"]);
    await api("/api/shared-notes", "GET", undefined, 403, guest);
    await api("/api/shared-notes/food.md", "GET", undefined, 403, guest);
    const guestChat = await api<any>(`/api/bots/${other.id}/tasks`, "POST", { title: "Guest chat" }, 201, guest);
    const guestThread: string = guestChat.task?.threadId ?? guestChat.threadId;
    before = sentCount();
    await api(`/api/bots/${other.id}/messages`, "POST", { text: "Which restaurants would you pick for dinner?", threadId: guestThread }, 202, guest);
    expect(await control("wait", "--bot", other.id, "--task", guestThread, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSince(before)).toContain("Which restaurants would you pick for dinner?");
    expect(sentSince(before)).not.toContain("shared/food.md");
    expect(sentSince(before)).not.toContain("Irani cafes");

    // The owner's own device, paired with full access, is still the owner:
    // it reads the notes and its chats recall them, guest or no guest.
    const laptop = await pair("Owner laptop", ["admin", "client"]);
    expect((await api("/api/shared-notes", "GET", undefined, 200, laptop)).notes).toMatchObject([{ name: "food.md" }]);
    const laptopChat = await api<any>(`/api/bots/${bot.id}/tasks`, "POST", { title: "Laptop chat" }, 201, laptop);
    const laptopThread: string = laptopChat.task?.threadId ?? laptopChat.threadId;
    before = sentCount();
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Any restaurants near the office?", threadId: laptopThread }, 202, laptop);
    expect(await control("wait", "--bot", bot.id, "--task", laptopThread, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSince(before)).toContain("shared/food.md");

    // deleted: nothing left to recall
    await api("/api/shared-notes/food.md", "DELETE");
    before = sentCount();
    await turn(bot.id, bot.threadId, "Any other restaurants worth a visit?");
    expect(sentSince(before)).not.toContain("shared/food.md");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
