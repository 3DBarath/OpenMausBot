// The shared-notes routes through the route table: list, open, edit and
// delete, the name gate over HTTP, and who may call them (the owner; never a
// chat-only session, never a phone).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { denyReason } from "../../companion/src/routes.ts";
import { DATA_DIR } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { appendImportRecord, listImportRecords } from "../context-import/records.ts";
import { appendAboutMe, commitLearned, listLearnedFacts, planLearned } from "../profile-learned.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { readSharedNote, writeSharedNote } from "../shared-notes.ts";
import { createSharedNotesRoutes } from "./shared-notes.ts";
import { dispatchRoutes } from "./table.ts";

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
/** How index.ts answers `deps.owner` on an installation with two admin addresses: only this computer is the owner. */
const onlyThisComputer = (auth: RequestAuth) => auth.kind === "loopback" && auth.trust !== "service";
const servers: Server[] = [];
let aboutMe = "";

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  aboutMe = "";
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** The table the way index.ts runs it: anything the module passes on falls
 * to a stand-in for the inline routes. */
async function serve(auth: RequestAuth = OWNER, owner: (auth: RequestAuth) => boolean = () => true): Promise<string> {
  const routes = [createSharedNotesRoutes({ owner, aboutMe: () => aboutMe, saveAboutMe: (text) => { aboutMe = text; } })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const put = (base: string, name: string, text: unknown) =>
  fetch(`${base}/api/shared-notes/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });

describe("shared notes over HTTP", () => {
  it("lists, opens, edits and deletes a note", async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/shared-notes`)).json()).toEqual({ notes: [] });
    const text = "---\ntitle: Food\naliases: [dinner]\n---\n\n- 2025-03-02 · The person is vegetarian (imported · ChatGPT)\n- Hates olives\n";
    const saved = await put(base, "food.md", text);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ name: "food.md", title: "Food", aliases: ["dinner"], entries: 1, imported: 1, text });
    expect(await (await fetch(`${base}/api/shared-notes`)).json()).toMatchObject({ notes: [{ name: "food.md", title: "Food", imported: 1 }] });
    expect(await (await fetch(`${base}/api/shared-notes/food.md`)).json()).toMatchObject({ name: "food.md", text });
    const removed = await fetch(`${base}/api/shared-notes/food.md`, { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true, notes: [] });
    expect((await fetch(`${base}/api/shared-notes/food.md`)).status).toBe(404);
    expect((await fetch(`${base}/api/shared-notes/food.md`, { method: "DELETE" })).status).toBe(404);
  });

  it("refuses a name that is not one plain .md file, a non-string text and an oversized note", async () => {
    const base = await serve();
    writeSharedNote("food.md", "- Hates olives\n");
    for (const name of ["..%2Fconfig.md", "..%2F..%2Fconfig.json", ".hidden.md", "notes.txt", "%E0%A4%A"]) {
      expect((await put(base, name, "x")).status, name).toBe(400);
      expect((await fetch(`${base}/api/shared-notes/${name}`)).status, name).toBeGreaterThanOrEqual(400);
    }
    expect((await put(base, "food.md", 7)).status).toBe(400);
    const big = await put(base, "food.md", "x".repeat(64 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: "too-large" });
    expect(readSharedNote("food.md")).toBe("- Hates olives\n");
  });

  it("redacts a credential in an edited note", async () => {
    const base = await serve();
    await put(base, "work.md", "- The key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
    expect(readSharedNote("work.md")).not.toContain("sk-ant-api03-AAAA");
  });

  it("deletes everything imported: entries, About me lines and the record of what was read", async () => {
    const base = await serve();
    writeSharedNote("food.md", "---\ntitle: Food\n---\n\n- 2025-03-02 · The person is vegetarian (imported · ChatGPT)\n- 2025-03-02 · Hates olives\n");
    writeSharedNote("work.md", "---\ntitle: Work\n---\n\n- 2025-03-02 · Ships on Fridays (imported · Claude)\n");
    const byBot = planLearned({ botId: "b1", botName: "Scout" }, ["Prefers short replies"], "", "2026-10-10");
    const byImport = planLearned({ botId: "import:chatgpt", botName: "ChatGPT import" }, ["Lives in Pune"], "", "2026-10-10");
    aboutMe = appendAboutMe("", [...byBot, ...byImport].map((fact) => fact.line))!;
    commitLearned([...byBot, ...byImport]);
    appendImportRecord({ id: "job-1", origin: "chatgpt", at: 1, conversations: 1, aboutMe: 1, sharedNotes: 2, from: 1, to: 2, hashes: ["abc"] });

    // the bare DELETE never means "all notes"
    expect((await fetch(`${base}/api/shared-notes`, { method: "DELETE" })).status).toBe(400);
    expect(readSharedNote("work.md")).not.toBeNull();
    // and an admin who is not the owner deletes nothing
    const secondAdmin = await serve({ kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s2", email: "second@example.test" } as never }, onlyThisComputer);
    expect((await fetch(`${secondAdmin}/api/shared-notes?imported=1`, { method: "DELETE" })).status).toBe(403);
    expect(readSharedNote("work.md")).not.toBeNull();
    expect(aboutMe).toContain("Lives in Pune");

    const response = await fetch(`${base}/api/shared-notes?imported=1`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, entries: 2, files: 1, aboutMe: 1, aboutMeText: "- 2026-10-10 · learned by Scout · Prefers short replies", notes: [{ name: "food.md", entries: 1, imported: 0 }] });
    expect(aboutMe).toBe("- 2026-10-10 · learned by Scout · Prefers short replies");
    expect(listLearnedFacts().map((fact) => fact.botName)).toEqual(["Scout"]);
    expect(readSharedNote("work.md")).toBeNull();
    expect(readSharedNote("food.md")).toContain("Hates olives");
    expect(listImportRecords()).toEqual([]);
  });

  it("passes on what is not its own and answers only the owner", async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/api/shared-notesx`)).json()).toEqual({ from: "inline routes" });
    expect(await (await fetch(`${base}/api/shared-notes/a/b.md`)).json()).toEqual({ from: "inline routes" });
    expect(await (await fetch(`${base}/api/shared-notes`, { method: "POST" })).json()).toEqual({ from: "inline routes" });
    const guest = await serve({ kind: "loopback", scopes: ["client"], trust: "service" });
    // a second admin has admin scope and is still not the owner: the notes are not theirs to read
    const secondAdmin = await serve({ kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s2", email: "second@example.test" } as never }, onlyThisComputer);
    writeSharedNote("food.md", "- Hates olives\n");
    for (const [method, path] of [["GET", "/api/shared-notes"], ["DELETE", "/api/shared-notes"], ["GET", "/api/shared-notes/food.md"], ["PUT", "/api/shared-notes/food.md"], ["DELETE", "/api/shared-notes/food.md"]] as const) {
      const response = await fetch(`${guest}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
      const refused = await fetch(`${secondAdmin}${path}`, { method, ...(method === "PUT" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "taken over" }) } : {}) });
      expect(refused.status, `second admin: ${method} ${path}`).toBe(403);
      expect(JSON.stringify(await refused.json()), `second admin: ${method} ${path}`).not.toContain("olives");
      // the gate in front of the table refuses a chat-only session too, and a phone never gets through
      expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
      expect(denyReason({ path, method, authenticated: true }), `${method} ${path}`).not.toBeNull();
    }
    expect(readSharedNote("food.md")).toBe("- Hates olives\n");
    // and the owner at the computer itself still can, on that same installation
    const owner = await serve(OWNER, onlyThisComputer);
    expect((await fetch(`${owner}/api/shared-notes/food.md`)).status).toBe(200);
  });
});
