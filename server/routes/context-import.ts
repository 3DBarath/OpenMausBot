// Context import (server/context-import/job.ts; docs/memory.md, "Shared
// notes and import"): read a ChatGPT or Claude export, or pasted text, and
// save the facts the person keeps.
//
//   GET    /api/context-import                    the open import, the bots that can read one, past imports
//   POST   /api/context-import                    start one {source: chatgpt | claude | paste}
//   PUT    /api/context-import/<id>/file          the export, as the request body (a zip or conversations.json)
//   POST   /api/context-import/<id>/text          pasted text {text}
//   GET    /api/context-import/<id>               state, scan, progress, candidates; ?from=&to=&cap= prices another range
//   POST   /api/context-import/<id>/extract       read it {botId, from?, to?, cap?}
//   POST   /api/context-import/<id>/pause         and /cancel
//   POST   /api/context-import/<id>/resume        carry on {skipFailed?}: true leaves out the parts the engine failed
//   PATCH  /api/context-import/<id>/candidates    tick, edit, move, rename {changes?, renameSubject?, keepWhatFits?}
//   POST   /api/context-import/<id>/save          write the kept facts
//
// Owner only. An import writes About me and the shared notes, which are
// the installation owner's: admin scope by default (server/request-auth.ts
// lists none of these for a chat-only session), and `deps.owner` then
// refuses everyone who is not the owner (server/shared-notes-owner.ts): a
// second admin, anyone on a hosted installation. Never on the phone
// allowlist (companion/src/routes.ts). No route here returns a
// conversation's text: the export only ever leaves this server inside the
// extraction prompt, to the engine the person picked.
//
// An upload that is refused (over the limit, no such import, an import that
// has its file, a cancel while it arrives, a disk that is full, a sender who
// is not the owner) is answered only once the rest of it has been read and
// thrown away. An answer sent while the sender is still writing is lost
// when the connection then closes under it: the bytes still on their way
// reset it, on Windows always and elsewhere by the size of the upload, and
// the person sees a network error instead of the reason. What is thrown
// away is never stored and never held: it is read a piece at a time and
// dropped. It is read up to a bound in bytes and in time (UPLOAD_DISCARD);
// past that, the answer is sent and the connection closed as it stands,
// which is all that can be done for a sender who will not stop.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { ImportError, type ContextImport } from "../context-import/job.ts";
import { listImportRecords, recordView } from "../context-import/records.ts";
import type { RequestAuth } from "../request-auth.ts";
import { IMPORT_ORIGINS, UPLOAD_MAX_BYTES, type ImportEngineChoice, type ImportOverview } from "../../shared/context-import.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PREFIX = "/api/context-import";

/** How much of a refused upload is read and thrown away so that its answer can arrive. */
export interface UploadDiscard {
  /** At most this many bytes. An upload that says it has more left than this is not read on at all. */
  maxBytes: number;
  /** For at most this long in all. */
  maxMs: number;
  /** And never waiting longer than this for the sender's next bytes. */
  idleMs: number;
}

/** Twice what an upload may hold: a file up to that size gets its reason
 * however it is sent. A minute, and ten seconds for a sender that has gone
 * quiet: on the computer itself or its network that is gigabytes. The same
 * for everyone the route answers, the owner or not: whoever reaches it has
 * signed in, and before this bound an unread upload was read to its end
 * with no bound at all. */
export const UPLOAD_DISCARD: UploadDiscard = { maxBytes: 2 * UPLOAD_MAX_BYTES, maxMs: 60_000, idleMs: 10_000 };

/** The body of an upload, read through one iterator from its first byte to
 * its last, whoever is reading: the import first, and after a refusal
 * `discard`. When the import stops reading, the request is left exactly as
 * it is (a loop over the request itself would destroy it, and the
 * connection with it, the moment the import threw). */
function uploadBody(req: IncomingMessage) {
  const source = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let received = 0;
  let ended = false;
  let broken = false;
  const next = async (): Promise<IteratorResult<Buffer, undefined>> => {
    try {
      const step = await source.next();
      if (step.done) ended = true;
      else received += step.value.length;
      return step.done ? { done: true, value: undefined } : step;
    } catch (error) {
      broken = true;
      throw error;
    }
  };
  const stream: AsyncIterable<Buffer> = { [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }) };
  return {
    stream,
    /** Read what is left of the upload and keep none of it, within `limits`.
     * True when it was read to its end: the answer can then be sent on a
     * connection with nothing left on its way. Never throws. */
    async discard(limits: UploadDiscard): Promise<boolean> {
      if (ended) return true;
      if (broken || req.destroyed) return false;
      const declared = Number(req.headers["content-length"]);
      // it says how long it is, and that is more than will be read: not begun
      if (Number.isFinite(declared) && declared - received > limits.maxBytes) return false;
      const deadline = Date.now() + limits.maxMs;
      let discarded = 0;
      while (!ended) {
        const wait = Math.min(limits.idleMs, deadline - Date.now());
        if (wait <= 0 || discarded > limits.maxBytes) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const piece = next();
        // too slow, or the sender went away: either way there is no more to wait for
        const step = await Promise.race([piece, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), wait); })]).catch(() => null);
        clearTimeout(timer);
        if (step === null) {
          piece.catch(() => undefined);
          return false;
        }
        if (!step.done) discarded += step.value.length;
      }
      return true;
    },
  };
}

/** Before a refused upload is answered: read the rest of it and throw it
 * away. Read to its end, the answer goes out on a quiet connection, which
 * is then closed in the ordinary way. Otherwise the answer is sent and the
 * connection is let go as it stands. */
async function settleUpload(body: ReturnType<typeof uploadBody>, req: IncomingMessage, res: ServerResponse, limits: UploadDiscard): Promise<void> {
  const whole = await body.discard(limits);
  if (res.headersSent) return;
  res.setHeader("connection", "close");
  if (!whole) res.once("finish", () => req.destroy());
}

export interface ContextImportRouteDeps {
  /** Whether this request is the installation owner's (server/shared-notes-owner.ts). */
  owner(auth: RequestAuth): boolean;
  imports: ContextImport;
  /** Every bot, whether its engine can make the quick text call an import
   * uses, and whether that engine may keep its own record of the text. */
  engines(): Promise<ImportEngineChoice[]>;
  /** How much of a refused upload is read and thrown away before it is
   * answered. Absent: UPLOAD_DISCARD. */
  uploadDiscard?: UploadDiscard;
}

const candidatePatch = z.object({
  changes: z.array(z.object({
    id: z.string().min(1).max(64),
    keep: z.boolean().optional(),
    text: z.string().max(4_000).optional(),
    kind: z.enum(["core", "subject"]).optional(),
    subject: z.string().max(200).optional(),
  })).max(2_000).optional(),
  renameSubject: z.object({ from: z.string().max(200), to: z.string().max(200) }).optional(),
  keepWhatFits: z.boolean().optional(),
});

export function createContextImportRoutes(deps: ContextImportRouteDeps): RouteHandler {
  const number = (value: string | null): number | undefined => (value !== null && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);

  const discard = deps.uploadDiscard ?? UPLOAD_DISCARD;
  const UPLOAD = /^\/api\/context-import\/[\w-]{1,64}\/file$/;

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return PASS;
    if (!auth.scopes.includes("admin") || !deps.owner(auth)) {
      // someone who may not upload is answered the same way: once what they sent has been read and thrown away
      if (method === "PUT" && UPLOAD.test(path)) await settleUpload(uploadBody(req), req, res, discard);
      return json(res, 403, { error: "Only the owner of this installation can import what another assistant knows about them." });
    }
    try {
      if (path === PREFIX) {
        if (method === "GET") {
          const overview: ImportOverview = { job: deps.imports.current(), engines: await deps.engines(), imports: listImportRecords().map(recordView) };
          return json(res, 200, overview);
        }
        if (method === "POST") {
          const parsed = z.object({ source: z.enum(IMPORT_ORIGINS as [string, ...string[]]) }).safeParse(await readBody(req));
          if (!parsed.success) return json(res, 400, { error: "source must be chatgpt, claude or paste" });
          return json(res, 201, { job: deps.imports.create(parsed.data.source as (typeof IMPORT_ORIGINS)[number]) });
        }
        return PASS;
      }
      const m = path.match(/^\/api\/context-import\/([\w-]{1,64})(?:\/(file|text|extract|pause|resume|cancel|candidates|save))?$/);
      if (!m) return PASS;
      const [, id, action] = m;
      if (!action && method === "GET") {
        return json(res, 200, { job: deps.imports.view(id, { from: number(url.searchParams.get("from")), to: number(url.searchParams.get("to")), cap: number(url.searchParams.get("cap")) }) });
      }
      if (action === "file" && method === "PUT") {
        const declared = number(req.headers["content-length"] ?? null);
        const body = uploadBody(req);
        try {
          return json(res, 200, { job: await deps.imports.receiveFile(id, body.stream, declared) });
        } catch (error) {
          // Refused, for whatever reason and at whatever point: the import has
          // stopped storing. The rest is read and thrown away before the
          // answer below goes out (the top of this file says why).
          await settleUpload(body, req, res, discard);
          throw error;
        }
      }
      if (action === "text" && method === "POST") {
        const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string" });
        return json(res, 200, { job: deps.imports.receiveText(id, parsed.data.text) });
      }
      if (action === "extract" && method === "POST") {
        const parsed = z.object({ botId: z.string().min(1).max(128), from: z.number().optional(), to: z.number().optional(), cap: z.number().optional() }).safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "botId is required; from, to and cap are optional numbers" });
        return json(res, 202, { job: deps.imports.extract(id, parsed.data) });
      }
      if (action === "pause" && method === "POST") return json(res, 200, { job: deps.imports.pause(id) });
      if (action === "resume" && method === "POST") {
        // no body at all is a plain resume
        const parsed = z.object({ skipFailed: z.boolean().optional() }).safeParse((await readBody(req)) ?? {});
        if (!parsed.success) return json(res, 400, { error: "skipFailed is true or false" });
        return json(res, 202, { job: deps.imports.resume(id, { skipFailed: parsed.data.skipFailed === true }) });
      }
      if (action === "cancel" && method === "POST") {
        await deps.imports.cancel(id);
        return json(res, 200, { ok: true });
      }
      if (action === "candidates" && method === "PATCH") {
        const parsed = candidatePatch.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "changes is a list of {id, keep?, text?, kind?, subject?}; renameSubject is {from, to}; keepWhatFits is true or false" });
        return json(res, 200, { job: deps.imports.patch(id, parsed.data) });
      }
      if (action === "save" && method === "POST") return json(res, 200, { result: await deps.imports.save(id) });
      return PASS;
    } catch (error) {
      if (error instanceof ImportError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
