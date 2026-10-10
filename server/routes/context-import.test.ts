// The context-import routes through the route table, over a real job and a
// scripted engine: the whole flow by HTTP, the statuses each step answers
// with, what is refused, and who may call them (the owner; never a
// chat-only session, never a phone).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { denyReason } from "../../companion/src/routes.ts";
import { DATA_DIR } from "../config.ts";
import { createContextImport, type ContextImport } from "../context-import/job.ts";
import { json, readBody } from "../harness/http.ts";
import { TIDY_MARKER } from "../memory-tidy.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { readSharedNote } from "../shared-notes.ts";
import { chatGptConversation, sampleConversations, writeExportZip } from "../testing/context-import-fixtures.ts";
import type { ImportJobView, ImportOverview, ImportSaveResult } from "../../shared/context-import.ts";
import { createContextImportRoutes } from "./context-import.ts";
import { dispatchRoutes } from "./table.ts";

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const servers: Server[] = [];
let aboutMe = "";
let imports: ContextImport;
let scratch: string;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  aboutMe = "";
  scratch = mkdtempSync(join(tmpdir(), "omb-import-routes-"));
  imports = createContextImport({
    engine: (botId) => (botId === "bot-1" ? {
      generateText: async (prompt) => (prompt.startsWith(TIDY_MARKER) ? '{"pairs": []}' : JSON.stringify([
        { text: "The person is vegetarian", kind: "core", subject: "Food", aliases: ["dinner"], sensitive: null, chat: 1 },
        { text: "The person has type 1 diabetes", kind: "subject", subject: "Health", aliases: [], sensitive: "health", chat: 1 },
        { text: "The person loves Irani cafes", kind: "subject", subject: "Food", aliases: ["restaurants"], sensitive: null, chat: 1 },
      ])),
    } : {}),
    aboutMe: () => aboutMe,
    saveAboutMe: (text) => { aboutMe = text; },
    sleep: async () => undefined,
    uploadMaxBytes: 64 * 1024,
  });
});
afterEach(async () => {
  await imports.idle();
  rmSync(scratch, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** The table the way index.ts runs it: a thrown error is answered with its status. */
async function serve(auth: RequestAuth = OWNER, owner: (auth: RequestAuth) => boolean = () => true): Promise<string> {
  const routes = [createContextImportRoutes({
    owner,
    imports,
    engines: () => [{ botId: "bot-1", name: "Scout", available: true }, { botId: "bot-2", name: "Relay", available: false }],
  })];
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

async function call<T>(base: string, method: string, path: string, body?: unknown, status = 200): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const answer = await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(answer)}`).toBe(status);
  return answer as T;
}

function exportZip(): Buffer {
  const path = join(scratch, "export.zip");
  writeExportZip(path, sampleConversations(Date.now()).map(chatGptConversation));
  return readFileSync(path);
}

describe("an import over HTTP", () => {
  it("goes from a zip to saved facts, and answers each step with the job", async () => {
    const base = await serve();
    expect(await call<ImportOverview>(base, "GET", "/api/context-import")).toEqual({
      job: null, imports: [],
      engines: [{ botId: "bot-1", name: "Scout", available: true }, { botId: "bot-2", name: "Relay", available: false }],
    });
    const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
    expect(job.status).toBe("created");
    await call(base, "POST", "/api/context-import", { source: "claude" }, 409);

    const uploaded = await fetch(`${base}/api/context-import/${job.id}/file`, { method: "PUT", headers: { "content-type": "application/zip" }, body: exportZip() });
    expect(uploaded.status).toBe(200);
    expect(((await uploaded.json()) as { job: ImportJobView }).job.status).toBe("scanning");
    await imports.idle();
    const scanned = await call<{ job: ImportJobView }>(base, "GET", `/api/context-import/${job.id}`);
    expect(scanned.job).toMatchObject({ status: "scanned", scan: { format: "chatgpt", conversations: 3 }, estimate: { conversations: 2, calls: 2 } });
    // a wider range, priced before anything is spent
    const wider = await call<{ job: ImportJobView }>(base, "GET", `/api/context-import/${job.id}?from=0&cap=10`);
    expect(wider.job.estimate).toMatchObject({ conversations: 3 });
    expect(wider.job.slice).toMatchObject({ from: 0, cap: 10 });

    await call(base, "POST", `/api/context-import/${job.id}/extract`, { botId: "bot-2" }, 409);
    await call(base, "POST", `/api/context-import/${job.id}/extract`, {}, 400);
    const started = await call<{ job: ImportJobView }>(base, "POST", `/api/context-import/${job.id}/extract`, { botId: "bot-1", from: 0, cap: 10 }, 202);
    expect(started.job.status).toBe("preparing");
    await imports.idle();
    const review = (await call<ImportOverview>(base, "GET", "/api/context-import")).job!;
    expect(review.status).toBe("review");
    expect(review.candidates!.map((candidate) => [candidate.text, candidate.kind, candidate.keep])).toEqual([
      ["The person is vegetarian", "core", true],
      ["The person has type 1 diabetes", "subject", false],
      ["The person loves Irani cafes", "subject", true],
    ]);
    // no route hands back what the conversations said
    expect(JSON.stringify(review)).not.toMatch(/Suggest three places|We ship on Fridays/);

    const cafes = review.candidates![2]!;
    const patched = await call<{ job: ImportJobView }>(base, "PATCH", `/api/context-import/${job.id}/candidates`, { changes: [{ id: cafes.id, text: "The person loves Irani cafes in Pune" }], renameSubject: { from: "Food", to: "Eating out" } });
    expect(patched.job.candidates![2]).toMatchObject({ text: "The person loves Irani cafes in Pune", subject: "Eating out" });
    await call(base, "PATCH", `/api/context-import/${job.id}/candidates`, { changes: [{ id: "gone", keep: true }] }, 404);
    await call(base, "PATCH", `/api/context-import/${job.id}/candidates`, { changes: "all" }, 400);

    const { result } = await call<{ result: ImportSaveResult }>(base, "POST", `/api/context-import/${job.id}/save`);
    expect(result).toMatchObject({ aboutMe: 1, entries: 1, subjects: 1, overflowed: 0 });
    expect(aboutMe).toContain("learned by ChatGPT import · The person is vegetarian");
    expect(readSharedNote("eating-out.md")).toContain("The person loves Irani cafes in Pune (imported · ChatGPT)");
    expect(readSharedNote("health.md")).toBeNull();
    expect(existsSync(join(DATA_DIR, "context-import"))).toBe(false);
    const after = await call<ImportOverview>(base, "GET", "/api/context-import");
    expect(after.job).toBeNull();
    expect(after.imports).toMatchObject([{ id: job.id, origin: "chatgpt", conversations: 3, aboutMe: 1, sharedNotes: 1 }]);
    await call(base, "GET", `/api/context-import/${job.id}`, undefined, 404);
  });

  it("takes pasted text, pauses only what runs, and cancels", async () => {
    const base = await serve();
    const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "paste" }, 201);
    await call(base, "POST", `/api/context-import/${job.id}/text`, { text: 7 }, 400);
    await call(base, "POST", `/api/context-import/${job.id}/text`, { text: "  " }, 400);
    const pasted = await call<{ job: ImportJobView }>(base, "POST", `/api/context-import/${job.id}/text`, { text: "I am vegetarian and I live in Pune." });
    expect(pasted.job).toMatchObject({ status: "scanned", scan: { format: "paste" }, estimate: { calls: 2 } });
    await call(base, "POST", `/api/context-import/${job.id}/pause`, undefined, 409);
    await call(base, "POST", `/api/context-import/${job.id}/resume`, undefined, 409);
    await call(base, "POST", `/api/context-import/${job.id}/save`, undefined, 409);
    expect(await call(base, "POST", `/api/context-import/${job.id}/cancel`)).toEqual({ ok: true });
    expect(existsSync(join(DATA_DIR, "context-import"))).toBe(false);
    await call(base, "POST", `/api/context-import/${job.id}/cancel`, undefined, 404);
  });

  it("refuses a bad source, an upload over the limit and a file with no conversations", async () => {
    const base = await serve();
    await call(base, "POST", "/api/context-import", { source: "gemini" }, 400);
    const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
    const big = await fetch(`${base}/api/context-import/${job.id}/file`, { method: "PUT", body: Buffer.alloc(65 * 1024) });
    expect(big.status).toBe(413);
    expect(((await big.json()) as { error: string }).error).toMatch(/conversations\.json/);
    const junk = await fetch(`${base}/api/context-import/${job.id}/file`, { method: "PUT", body: "<html>not an export</html>" });
    expect(junk.status).toBe(200);
    await imports.idle();
    const failed = await call<{ job: ImportJobView }>(base, "GET", `/api/context-import/${job.id}`);
    expect(failed.job).toMatchObject({ status: "failed" });
    expect(failed.job.error).toMatch(/No ChatGPT or Claude conversations were found/);
  });

  it("passes on what is not its own and answers only the owner", async () => {
    const base = await serve();
    expect(await call(base, "GET", "/api/context-importx", undefined, 404)).toEqual({ from: "inline routes" });
    expect(await call(base, "DELETE", "/api/context-import", undefined, 404)).toEqual({ from: "inline routes" });
    expect(await call(base, "POST", "/api/context-import/abc/unknown", undefined, 404)).toEqual({ from: "inline routes" });
    expect(await call(base, "GET", "/api/context-import/abc/save", undefined, 404)).toEqual({ from: "inline routes" });
    const guest = await serve({ kind: "loopback", scopes: ["client"], trust: "service" });
    // a second admin has admin scope and is still not the owner: About me and the shared notes are not theirs to fill
    const secondAdmin = await serve({ kind: "session", via: "bearer", scopes: ["admin", "client"], session: { id: "s2", email: "second@example.test" } as never }, () => false);
    for (const [method, path] of [
      ["GET", "/api/context-import"], ["POST", "/api/context-import"], ["GET", "/api/context-import/abc"],
      ["PUT", "/api/context-import/abc/file"], ["POST", "/api/context-import/abc/text"], ["POST", "/api/context-import/abc/extract"],
      ["POST", "/api/context-import/abc/pause"], ["POST", "/api/context-import/abc/resume"], ["POST", "/api/context-import/abc/cancel"],
      ["PATCH", "/api/context-import/abc/candidates"], ["POST", "/api/context-import/abc/save"],
    ] as const) {
      expect((await fetch(`${guest}${path}`, { method })).status, `${method} ${path}`).toBe(403);
      expect((await fetch(`${secondAdmin}${path}`, { method })).status, `second admin: ${method} ${path}`).toBe(403);
      // the gate in front of the table refuses a chat-only session too, and a phone never gets through
      expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
      expect(denyReason({ path, method, authenticated: true }), `${method} ${path}`).not.toBeNull();
    }
    // nothing was started on anyone's behalf
    expect(imports.current()).toBeNull();
  });
});
