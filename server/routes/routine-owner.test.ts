import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createRoutineOwnerRoutes } from "./routine-owner.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const session = (scopes: RequestAuth["scopes"]): RequestAuth =>
  ({ kind: "session", session: { id: "s1", scopes } as unknown as SessionRecord, via: "bearer", scopes });

async function serve(auth: RequestAuth, cloudHome = true) {
  const owner = { confirm: vi.fn((id: string) => id !== "missing") };
  const confirmed = vi.fn();
  const routes = [createRoutineOwnerRoutes({
    owner: cloudHome ? owner : null,
    ownerDevice: (who) => who.kind === "session" && who.scopes.includes("admin"),
    confirmed,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { owner, confirmed, post: async (path: string) => { const res = await fetch(`${base}${path}`, { method: "POST" }); return { status: res.status, body: await res.json() }; } };
}

describe("Run with full access (server/routes/routine-owner.ts)", () => {
  it("one of the owner's own devices confirms a Cloud home's routine, and its run cards are redrawn", async () => {
    const { owner, confirmed, post } = await serve(session(["admin", "client"]));
    expect(await post("/api/routines/r1/confirm")).toEqual({ status: 200, body: { ok: true } });
    expect(owner.confirm).toHaveBeenCalledWith("r1");
    expect(confirmed).toHaveBeenCalledWith("r1");
    expect((await post("/api/routines/missing/confirm")).status).toBe(404);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("nothing but an owner's device confirms one: not a local process, not a chat-only session", async () => {
    for (const auth of [{ kind: "loopback", scopes: ["admin", "client"] } as RequestAuth, { kind: "loopback", scopes: ["client"], trust: "service" } as RequestAuth, session(["client"])]) {
      const { owner, confirmed, post } = await serve(auth);
      expect(await post("/api/routines/r1/confirm")).toEqual({ status: 403, body: { error: "Only your own devices can confirm a routine." } });
      expect(owner.confirm).not.toHaveBeenCalled();
      expect(confirmed).not.toHaveBeenCalled();
    }
  });

  it("is no route off a Cloud home, nor for another method or path", async () => {
    expect(await (await serve(session(["admin", "client"]), false)).post("/api/routines/r1/confirm")).toEqual({ status: 404, body: { from: "inline routes" } });
    const { owner, post } = await serve(session(["admin", "client"]));
    expect((await post("/api/routines/r1/run")).body).toEqual({ from: "inline routes" });
    expect(owner.confirm).not.toHaveBeenCalled();
  });
});
