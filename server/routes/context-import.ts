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
//   POST   /api/context-import/<id>/pause         and /resume, /cancel
//   PATCH  /api/context-import/<id>/candidates    tick, edit, move, rename {changes?, renameSubject?}
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
import { z } from "zod";

import { ImportError, type ContextImport } from "../context-import/job.ts";
import { listImportRecords, recordView } from "../context-import/records.ts";
import type { RequestAuth } from "../request-auth.ts";
import { IMPORT_ORIGINS, type ImportEngineChoice, type ImportOverview } from "../../shared/context-import.ts";
import { PASS, type RouteHandler } from "./table.ts";

const PREFIX = "/api/context-import";

export interface ContextImportRouteDeps {
  /** Whether this request is the installation owner's (server/shared-notes-owner.ts). */
  owner(auth: RequestAuth): boolean;
  imports: ContextImport;
  /** Every bot, and whether its engine can make the quick text call an import uses. */
  engines(): ImportEngineChoice[];
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
});

export function createContextImportRoutes(deps: ContextImportRouteDeps): RouteHandler {
  const number = (value: string | null): number | undefined => (value !== null && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : undefined);

  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return PASS;
    if (!auth.scopes.includes("admin") || !deps.owner(auth)) return json(res, 403, { error: "Only the owner of this installation can import what another assistant knows about them." });
    try {
      if (path === PREFIX) {
        if (method === "GET") {
          const overview: ImportOverview = { job: deps.imports.current(), engines: deps.engines(), imports: listImportRecords().map(recordView) };
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
        try {
          return json(res, 200, { job: await deps.imports.receiveFile(id, req, declared) });
        } catch (error) {
          // the rest of a refused upload is not read: answer, then let the connection go
          res.setHeader("connection", "close");
          res.once("finish", () => req.destroy());
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
      if (action === "resume" && method === "POST") return json(res, 202, { job: deps.imports.resume(id) });
      if (action === "cancel" && method === "POST") {
        await deps.imports.cancel(id);
        return json(res, 200, { ok: true });
      }
      if (action === "candidates" && method === "PATCH") {
        const parsed = candidatePatch.safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "changes is a list of {id, keep?, text?, kind?, subject?}; renameSubject is {from, to}" });
        return json(res, 200, { job: deps.imports.patch(id, parsed.data) });
      }
      if (action === "save" && method === "POST") return json(res, 200, { result: deps.imports.save(id) });
      return PASS;
    } catch (error) {
      if (error instanceof ImportError) return json(res, error.status, { error: error.message });
      throw error;
    }
  };
}
