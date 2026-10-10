// Shared notes in Settings (server/shared-notes.ts): the notes every bot can
// recall from, listed, opened, edited and deleted by the person.
//
//   GET    /api/shared-notes          every note: title, other words, size, entry counts
//   GET    /api/shared-notes/<name>   one note with its text
//   PUT    /api/shared-notes/<name>   replace its text {text}
//   DELETE /api/shared-notes/<name>   delete it
//
// Owner only. The notes are the installation owner's, like About me: admin
// scope by default (server/request-auth.ts lists none of these for a
// chat-only session), and `deps.owner` then refuses everyone who is not the
// owner (server/shared-notes-owner.ts): a second admin, anyone on a hosted
// installation. Never on the phone allowlist (companion/src/routes.ts). Bots
// get no route or tool for shared notes; recall is their only way in.
import { z } from "zod";

import type { RequestAuth } from "../request-auth.ts";
import { deleteSharedNote, describeSharedNotes, readSharedNote, SharedNotesError, writeSharedNote } from "../shared-notes.ts";
import type { SharedNoteDoc } from "../../shared/shared-notes.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SharedNotesRouteDeps {
  /** Whether this request is the installation owner's (server/shared-notes-owner.ts). */
  owner(auth: RequestAuth): boolean;
}

const PREFIX = "/api/shared-notes";

function doc(name: string): SharedNoteDoc | null {
  const text = readSharedNote(name);
  const info = describeSharedNotes().find((note) => note.name === name);
  return text === null || !info ? null : { ...info, text };
}

export function createSharedNotesRoutes(deps: SharedNotesRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return PASS;
    if (!auth.scopes.includes("admin") || !deps.owner(auth)) return json(res, 403, { error: "Only the owner of this installation can read or change shared notes." });
    if (path === PREFIX) {
      if (method === "GET") return json(res, 200, { notes: describeSharedNotes() });
      return PASS;
    }
    const m = path.match(/^\/api\/shared-notes\/([^/]+)$/);
    if (!m) return PASS;
    let name: string;
    try {
      name = decodeURIComponent(m[1]);
    } catch {
      return json(res, 400, { error: "That is not a shared note name." });
    }
    try {
      if (method === "GET") {
        const note = doc(name);
        return note ? json(res, 200, note) : json(res, 404, { error: "No such shared note." });
      }
      if (method === "PUT") {
        const parsed = z.object({ text: z.string() }).safeParse(await readBody(req));
        if (!parsed.success) return json(res, 400, { error: "text must be a string" });
        writeSharedNote(name, parsed.data.text);
        return json(res, 200, doc(name));
      }
      if (method === "DELETE") {
        if (!deleteSharedNote(name)) return json(res, 404, { error: "No such shared note." });
        return json(res, 200, { ok: true, notes: describeSharedNotes() });
      }
    } catch (error) {
      if (error instanceof SharedNotesError) return json(res, error.status, { error: error.message, code: error.code });
      throw error;
    }
    return PASS;
  };
}
