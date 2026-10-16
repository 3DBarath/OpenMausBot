// "Run with full access" on a routine run's card: one of the owner's own devices confirms that a Cloud home's routine
// is theirs (server/cloud-routine-owner.ts). Anywhere else a routine is simply the server's owner's, so it is no route.
import type { CloudRoutineOwner } from "../cloud-routine-owner.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface RoutineOwnerRouteDeps {
  owner: Pick<CloudRoutineOwner, "confirm"> | null;
  /** An admin session: on a Cloud home only the owner's own devices have one. */
  ownerDevice(auth: RequestAuth): boolean;
  /** Re-renders the cards of its latest runs, so they stop offering the click. */
  confirmed(routineId: string): void;
}

export function createRoutineOwnerRoutes(deps: RoutineOwnerRouteDeps): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    const match = method === "POST" ? /^\/api\/routines\/([\w-]+)\/confirm$/.exec(path) : null;
    if (!match || !deps.owner) return PASS;
    if (!deps.ownerDevice(auth)) return json(res, 403, { error: "Only your own devices can confirm a routine." });
    if (!deps.owner.confirm(match[1]!)) return json(res, 404, { error: "no such routine" });
    deps.confirmed(match[1]!);
    return json(res, 200, { ok: true });
  };
}
