// The context-import routes through the route table, over a real job and a
// scripted engine: the whole flow by HTTP, the statuses each step answers
// with, what is refused, and who may call them (the owner; never a
// chat-only session, never a phone).
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
import { createContextImportRoutes, type ContextImportRouteDeps } from "./context-import.ts";
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
async function serve(auth: RequestAuth = OWNER, owner: (auth: RequestAuth) => boolean = () => true, more: Partial<ContextImportRouteDeps> = {}): Promise<string> {
  const routes = [createContextImportRoutes({
    owner,
    imports,
    ...more,
    engines: async () => [{ botId: "bot-1", name: "Scout", available: true, keepsText: false }, { botId: "bot-2", name: "Relay", available: false }, { botId: "bot-3", name: "Agent", available: true, keepsText: true }],
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

const KB = 1024;
const MB = 1024 * KB;

/** A sender that uploads by hand over a plain connection, a piece at a time,
 * and says what came back and when: fetch only tells the end of the story. */
function sender(base: string, path: string, declared?: number) {
  const socket = connect(Number(new URL(base).port), "127.0.0.1");
  let received = Buffer.alloc(0);
  let closed = false;
  let failure: Error | null = null;
  let sent = 0;
  const piece = Buffer.alloc(64 * KB, "x");
  socket.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
  socket.on("close", () => { closed = true; });
  socket.on("error", (error) => { failure = error; });
  socket.write(`PUT ${path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/octet-stream\r\n${declared === undefined ? "transfer-encoding: chunked" : `content-length: ${declared}`}\r\n\r\n`);
  const write = (bytes: Uint8Array | string): Promise<boolean> => new Promise((resolve) => {
    if (closed || socket.destroyed) return resolve(false);
    socket.write(bytes, (error) => resolve(!error));
  });
  /** The answer, once all of it has arrived. */
  const answer = (): { status: number; headers: Record<string, string>; body: any } | null => {
    const text = received.toString("utf8");
    const split = text.indexOf("\r\n\r\n");
    if (split < 0) return null;
    const [first, ...lines] = text.slice(0, split).split("\r\n");
    const headers = Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
    let body = text.slice(split + 4);
    if (headers["transfer-encoding"] === "chunked") {
      if (!body.endsWith("0\r\n\r\n")) return null;
      body = body.split("\r\n").filter((_, index) => index % 2 === 1).join("");
    } else if (Buffer.byteLength(body) < Number(headers["content-length"] ?? 0)) return null;
    try {
      return { status: Number(first!.split(" ")[1]), headers, body: JSON.parse(body) };
    } catch {
      return null;
    }
  };
  return {
    /** Send this many more bytes of the upload. False once the connection is gone. */
    async send(bytes: number): Promise<boolean> {
      for (let left = bytes; left > 0; ) {
        const now = piece.subarray(0, Math.min(left, piece.length));
        const ok = declared === undefined ? await write(`${now.length.toString(16)}\r\n`) && await write(now) && await write("\r\n") : await write(now);
        if (!ok) return false;
        left -= now.length;
        sent += now.length;
      }
      return true;
    },
    /** Say the upload is over (one sent without its length ahead of it). */
    end: () => write("0\r\n\r\n"),
    sent: () => sent,
    answer,
    closed: () => closed,
    failure: () => failure,
    answered: () => expect.poll(answer, { timeout: 15_000, interval: 10 }).not.toBeNull().then(() => answer()!),
    gone: () => expect.poll(() => closed, { timeout: 15_000, interval: 10 }).toBe(true),
    destroy: () => socket.destroy(),
  };
}

/** The import with every upload it refused noted, so a test can wait for the refusal itself. */
function noting(refused: unknown[]): ContextImport {
  return {
    ...imports,
    receiveFile: async (...input) => {
      try {
        return await imports.receiveFile(...input);
      } catch (error) {
        refused.push(error);
        throw error;
      }
    },
  };
}

/** The memory in use once everything that can be let go has been: what is
 * held, not what is waiting to be collected. A piece read from a connection
 * and dropped stays counted until the collector runs, and it runs when it
 * likes. */
const collect = (() => {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
})();
const held = () => {
  collect();
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.external + memory.arrayBuffers;
};

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
      // each bot that can read an export says whether its engine may keep its own record of the text
      engines: [{ botId: "bot-1", name: "Scout", available: true, keepsText: false }, { botId: "bot-2", name: "Relay", available: false }, { botId: "bot-3", name: "Agent", available: true, keepsText: true }],
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

  // An answer sent while the sender is still writing can be lost with the
  // connection: a server that answers and closes with bytes still on their way
  // has the connection reset under the answer (always on Windows, by the size
  // of the upload elsewhere), and the person sees a network error instead of
  // the reason. So a refused upload is read to its end first, and none of it
  // is kept.
  describe("an upload that is refused", () => {
    const uploadFile = () => join(DATA_DIR, "context-import", "tmp");
    const stored = () => (existsSync(uploadFile()) ? readdirSync(uploadFile()).filter((name) => name.endsWith(".upload")) : []);

    it("is read to its end and thrown away before it is answered, so the answer arrives", async () => {
      const refused: unknown[] = [];
      const base = await serve(OWNER, () => true, { imports: noting(refused) });
      const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
      // 8 MB, against a limit of 64 KB
      const upload = sender(base, `/api/context-import/${job.id}/file`);
      expect(await upload.send(256 * KB)).toBe(true);
      // the import has refused it: over the limit, and what it had stored is gone
      await expect.poll(() => refused.length, { timeout: 10_000, interval: 5 }).toBe(1);
      expect(stored()).toEqual([]);
      // The answer is held back while the sender is still writing, and the connection stays open…
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(upload.answer()).toBeNull();
      expect(upload.closed()).toBe(false);
      // …and the rest is taken, with none of it kept
      expect(await upload.send(8 * MB - 256 * KB)).toBe(true);
      expect(stored()).toEqual([]);
      expect(upload.answer()).toBeNull();
      await upload.end();
      const answer = await upload.answered();
      expect(answer.status).toBe(413);
      expect(answer.body.error).toMatch(/conversations\.json/);
      // then the connection is closed, by an ordinary close and not a reset
      expect(answer.headers.connection).toBe("close");
      await upload.gone();
      expect(upload.failure()).toBeNull();
      // and the import is as it was: a file can still be uploaded
      expect((await call<{ job: ImportJobView }>(base, "GET", `/api/context-import/${job.id}`)).job).toMatchObject({ status: "created" });
      const ok = await fetch(`${base}/api/context-import/${job.id}/file`, { method: "PUT", body: exportZip() });
      expect(ok.status).toBe(200);
    });

    it("answers with its reason whatever the reason and however much was sent, where a network error used to stand", async () => {
      const guest = await serve({ kind: "loopback", scopes: ["client"], trust: "service" });
      const base = await serve();
      const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
      const put = async (to: string, path: string, bytes: number) => {
        const response = await fetch(`${to}${path}`, { method: "PUT", body: Buffer.alloc(bytes, "x") });
        return { status: response.status, error: ((await response.json()) as { error?: string }).error ?? "" };
      };
      for (const bytes of [65 * KB, MB, 5 * MB, 24 * MB]) {
        // over the limit, known from the first header and found again by counting
        expect(await put(base, `/api/context-import/${job.id}/file`, bytes), `over the limit: ${bytes}`).toMatchObject({ status: 413, error: expect.stringMatching(/conversations\.json/) });
        // no such import
        expect(await put(base, "/api/context-import/no-such-import/file", bytes), `no such import: ${bytes}`).toMatchObject({ status: 404 });
        // someone who may not import at all
        expect(await put(guest, `/api/context-import/${job.id}/file`, bytes), `not the owner: ${bytes}`).toMatchObject({ status: 403 });
      }
      // an import that already has its file
      expect((await fetch(`${base}/api/context-import/${job.id}/file`, { method: "PUT", body: exportZip() })).status).toBe(200);
      await imports.idle();
      for (const bytes of [MB, 24 * MB]) {
        expect(await put(base, `/api/context-import/${job.id}/file`, bytes), `has its file: ${bytes}`).toMatchObject({ status: 409, error: "This import already has its file." });
      }
      // an import that takes pasted text
      await call(base, "POST", `/api/context-import/${job.id}/cancel`, {});
      const { job: paste } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "paste" }, 201);
      expect(await put(base, `/api/context-import/${paste.id}/file`, 5 * MB)).toMatchObject({ status: 409, error: "This import takes pasted text, not a file." });
      expect(stored()).toEqual([]);
    });

    it("is answered after a cancel during the upload too", async () => {
      const refused: unknown[] = [];
      const base = await serve(OWNER, () => true, { imports: noting(refused) });
      const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
      // 32 KB of a 48 KB upload, under the limit, and then the person cancels
      const upload = sender(base, `/api/context-import/${job.id}/file`, 48 * KB);
      expect(await upload.send(32 * KB)).toBe(true);
      await expect.poll(() => imports.current()?.uploadedBytes, { timeout: 10_000, interval: 5 }).toBe(32 * KB);
      await call(base, "POST", `/api/context-import/${job.id}/cancel`, {});
      await expect.poll(() => refused.length, { timeout: 10_000, interval: 5 }).toBe(1);
      expect(existsSync(join(DATA_DIR, "context-import"))).toBe(false);
      expect(upload.answer()).toBeNull();
      // the sender finishes what it was sending, and is told
      expect(await upload.send(16 * KB)).toBe(true);
      const answer = await upload.answered();
      expect(answer).toMatchObject({ status: 409, body: { error: "The import was cancelled." } });
      await upload.gone();
      expect(upload.failure()).toBeNull();
      expect(existsSync(join(DATA_DIR, "context-import"))).toBe(false);
    });

    it("is not read past a bound: not when it says it is longer, not when it goes on, and not when it stalls", async () => {
      const refused: unknown[] = [];
      const base = await serve(OWNER, () => true, { imports: noting(refused), uploadDiscard: { maxBytes: 512 * KB, maxMs: 4_000, idleMs: 400 } });
      const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
      const path = `/api/context-import/${job.id}/file`;
      // It says how long it is, and that is more than will be thrown away: answered at once, with nothing more read.
      const long = sender(base, path, 64 * MB);
      const told = await long.answered();
      expect(told).toMatchObject({ status: 413, headers: { connection: "close" } });
      expect(long.sent()).toBe(0);
      await long.gone();
      // It does not say, and goes on: read for about the bound and no further. (Nowhere near the 64 MB it would send.)
      const endless = sender(base, path);
      let more = true;
      for (let pieces = 0; more && pieces < 1024 && !endless.closed(); pieces += 1) more = await endless.send(64 * KB);
      await endless.gone();
      expect(endless.sent()).toBeLessThan(32 * MB);
      expect(refused).toHaveLength(2);
      // It stalls: waited for as long as the bound says, then answered and let go.
      const stalled = sender(base, path, 200 * KB);
      expect(await stalled.send(100 * KB)).toBe(true);
      await expect.poll(() => refused.length, { timeout: 10_000, interval: 5 }).toBe(3);
      const since = performance.now();
      const late = await stalled.answered();
      const waited = performance.now() - since;
      expect(late).toMatchObject({ status: 413, headers: { connection: "close" } });
      // it did wait for the sender, and not for ever (400 ms here; a busy machine adds, never subtracts)
      expect(waited).toBeGreaterThan(250);
      await stalled.gone();
      expect(stored()).toEqual([]);
    });

    it("keeps none of what it throws away: nothing on the disk, and no more memory for 256 MB than for one piece", async () => {
      const refused: unknown[] = [];
      const base = await serve(OWNER, () => true, { imports: noting(refused) });
      const { job } = await call<{ job: ImportJobView }>(base, "POST", "/api/context-import", { source: "chatgpt" }, 201);
      const upload = sender(base, `/api/context-import/${job.id}/file`, 256 * MB);
      expect(await upload.send(MB)).toBe(true);
      await expect.poll(() => refused.length, { timeout: 10_000, interval: 5 }).toBe(1);
      const baseline = held();
      let peak = baseline;
      for (let sent = MB; sent < 256 * MB; sent += 8 * MB) {
        expect(await upload.send(Math.min(8 * MB, 256 * MB - sent))).toBe(true);
        peak = Math.max(peak, held());
        expect(stored()).toEqual([]);
      }
      expect((await upload.answered()).status).toBe(413);
      await upload.gone();
      expect(upload.failure()).toBeNull();
      // 256 MB went through; holding it would show as that much. (Not a few
      // megabytes: what a collection lets go is given back to the system by
      // another thread, which a busy machine keeps waiting.)
      expect(peak - baseline).toBeLessThan(64 * MB);
      expect(stored()).toEqual([]);
    }, 120_000);
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
