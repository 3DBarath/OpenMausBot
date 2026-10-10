// Context import end to end, against an isolated fixture server and the fake
// engine: an export goes in, facts are proposed, nothing is written before
// save, save puts core facts in About me and the rest in shared notes, the
// upload is gone afterwards, and what was imported reaches every bot's
// one-to-one chats (server/shared-notes.e2e.test.ts covers where a shared
// note is never recalled). The model steps are scripted with
// FAKE_CLAUDE_TEXT_ROUTES, so this proves the plumbing, not what a real model
// would pick out of a real export.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { ImportJobView, ImportOverview, ImportSaveResult } from "../shared/context-import.ts";
import type { WireBot } from "../shared/wire.ts";
import { IMPORT_MARKER } from "./context-import/extract.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";
import { chatGptConversation, sampleConversations, writeExportZip } from "./testing/context-import-fixtures.ts";

it("imports a ChatGPT export into About me and shared notes that every bot then knows", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-context-import-"));
  const routes = join(scratch, "routes.json");
  const prompts = join(scratch, "prompts.jsonl");
  const textDump = join(scratch, "one-shot.json");
  writeFileSync(routes, JSON.stringify({
    [IMPORT_MARKER]: JSON.stringify([
      { text: "The person is vegetarian", kind: "core", subject: "Food", aliases: ["restaurants", "dinner"], sensitive: null, chat: 1 },
      { text: "The person loves Irani cafes", kind: "subject", subject: "Food", aliases: ["restaurants", "cafes"], sensitive: null, chat: 1 },
      { text: "The person takes medication for asthma", kind: "subject", subject: "Health", aliases: ["doctor"], sensitive: "health", chat: 1 },
      { text: "The person's company Supamaus ships on Fridays", kind: "subject", subject: "Work", aliases: ["launch"], sensitive: null, chat: 2 },
    ]),
    [TIDY_MARKER]: '{"pairs": []}',
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TEXT_DUMP: textDump });
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
  const sentSince = (count: number) => readFileSync(prompts, "utf8").trim().split("\n").slice(count).join("\n");
  const sentCount = () => { try { return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const status = async (id: string) => (await api<{ job: ImportJobView }>(`/api/context-import/${id}`)).job.status;
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    // upkeep off: this test is about what the import writes, not what capture notices
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });
    const overview = await api<ImportOverview>("/api/context-import");
    expect(overview.job).toBeNull();
    expect(overview.engines.find((engine) => engine.botId === bot.id)).toMatchObject({ name: "Memo", available: true });

    // ── upload and scan: no model ───────────────────────────────────────
    const { job } = await api<{ job: ImportJobView }>("/api/context-import", "POST", { source: "chatgpt" }, 201);
    const zip = join(scratch, "export.zip");
    writeExportZip(zip, sampleConversations(Date.now()).map(chatGptConversation));
    const uploaded = await fetch(`${fixture.info.url}/api/context-import/${job.id}/file`, { method: "PUT", headers: { "content-type": "application/zip" }, body: readFileSync(zip) });
    expect(uploaded.status).toBe(200);
    await expect.poll(() => status(job.id), { timeout: 20_000 }).toBe("scanned");
    const scanned = (await api<{ job: ImportJobView }>(`/api/context-import/${job.id}`)).job;
    expect(scanned).toMatchObject({ scan: { format: "chatgpt", conversations: 3, withOwnMessages: 3 }, estimate: { conversations: 2, calls: 2 } });
    expect(existsSync(join(fixture.info.dataDir, "context-import", "tmp", `${job.id}.upload`))).toBe(true);
    expect(existsSync(textDump)).toBe(false);

    // ── extract and review: nothing is written where a bot reads ───────
    await api(`/api/context-import/${job.id}/extract`, "POST", { botId: bot.id }, 202);
    await expect.poll(() => status(job.id), { timeout: 60_000 }).toBe("review");
    const review = (await api<{ job: ImportJobView }>(`/api/context-import/${job.id}`)).job;
    expect(review.progress).toMatchObject({ batches: 1, done: 1, skipped: 0, candidates: 4 });
    expect(review.candidates!.map((candidate) => [candidate.text, candidate.kind, candidate.keep, candidate.chatTitle])).toEqual([
      ["The person is vegetarian", "core", true, "Dinner ideas"],
      ["The person loves Irani cafes", "subject", true, "Dinner ideas"],
      ["The person takes medication for asthma", "subject", false, "Dinner ideas"],
      ["The person's company Supamaus ships on Fridays", "subject", true, "Launch plan"],
    ]);
    // the last one-shot was the conflict check, over the proposed facts
    const lastCall = JSON.parse(readFileSync(textDump, "utf8")) as { prompt: string; argv: string[] };
    expect(lastCall.prompt).toContain("The person is vegetarian");
    // an import's calls keep no session of the chat text and have no tools
    expect(lastCall.argv).toContain("--no-session-persistence");
    expect(lastCall.argv[lastCall.argv.indexOf("--tools") + 1]).toBe("");
    expect((await api("/api/config")).profile.aboutMe).toBe("");
    expect((await api("/api/shared-notes")).notes).toEqual([]);
    expect((await api("/api/profile/learned")).learned).toEqual([]);

    // ── save ────────────────────────────────────────────────────────────
    const { result } = await api<{ result: ImportSaveResult }>(`/api/context-import/${job.id}/save`, "POST");
    expect(result).toMatchObject({ aboutMe: 1, overflowed: 0, subjects: 2, entries: 2, full: [] });
    expect((await api("/api/config")).profile.aboutMe).toMatch(/^- \d{4}-\d{2}-\d{2} · learned by ChatGPT import · The person is vegetarian$/);
    const { learned } = await api<{ learned: Array<{ id: string; text: string; botName: string }> }>("/api/profile/learned");
    expect(learned).toMatchObject([{ text: "The person is vegetarian", botName: "ChatGPT import" }]);
    const { notes } = await api<{ notes: Array<{ name: string; imported: number }> }>("/api/shared-notes");
    expect(notes).toMatchObject([{ name: "food.md", imported: 1 }, { name: "work.md", imported: 1 }]);
    expect((await api("/api/shared-notes/food.md")).text).toContain("- ");
    expect((await api("/api/shared-notes/food.md")).text).toContain("The person loves Irani cafes (imported · ChatGPT)");
    // the upload, the cut text and the candidates are gone; the record holds no text
    expect(existsSync(join(fixture.info.dataDir, "context-import"))).toBe(false);
    const record = readFileSync(join(fixture.info.dataDir, "context-imports.json"), "utf8");
    expect(record).not.toMatch(/vegetarian|Dinner ideas|Supamaus/);
    const after = await api<ImportOverview>("/api/context-import");
    expect(after.job).toBeNull();
    expect(after.imports).toMatchObject([{ origin: "chatgpt", conversations: 2, aboutMe: 1, sharedNotes: 2 }]);

    // ── every bot knows: About me in the prompt, shared notes by recall ─
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).toContain("learned by ChatGPT import · The person is vegetarian");
    let before = sentCount();
    await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", "Can you suggest some restaurants for Friday?");
    expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSince(before)).toContain("shared/food.md");
    expect(sentSince(before)).toContain("The person loves Irani cafes (imported · ChatGPT)");

    // a bot created after the import knows too
    const { bot: later } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Later" }, 201);
    await api(`/api/bots/${later.id}`, "PATCH", { memoryUpkeep: false });
    before = sentCount();
    await control("send", "--bot", later.id, "--task", later.threadId, "--text", "What should we plan for the launch?");
    expect(await control("wait", "--bot", later.id, "--task", later.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    expect(sentSince(before)).toContain("shared/work.md");

    // ── someone else on the installation ────────────────────────────────
    // A device paired with chat-only access is not the owner: it can neither
    // see past imports nor start one of its own.
    const { code } = await api<{ code: string }>("/api/auth/pairing", "POST", { label: "Guest phone", scopes: ["client"] });
    const guest = (await api<{ token: string }>("/api/auth/pair", "POST", { code, label: "Guest phone" })).token;
    await api("/api/context-import", "GET", undefined, 403, guest);
    await api("/api/context-import", "POST", { source: "paste" }, 403, guest);
    expect((await api<ImportOverview>("/api/context-import")).job).toBeNull();

    // ── delete everything imported ──────────────────────────────────────
    const wiped = await api("/api/shared-notes?imported=1", "DELETE");
    expect(wiped).toMatchObject({ ok: true, entries: 2, files: 2, aboutMe: 1, notes: [] });
    expect((await api("/api/config")).profile.aboutMe).toBe("");
    expect((await api("/api/profile/learned")).learned).toEqual([]);
    expect((await api<ImportOverview>("/api/context-import")).imports).toEqual([]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240_000);
