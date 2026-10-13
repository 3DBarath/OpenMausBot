// Closed-app phone alerts, wired into the server (server/host/README.md):
// where the relay access comes from, the registered phones and their alerts
// (server/phone-push.ts), who may see an alert, and the /api/push/device
// routes. server/index.ts creates this once, before its private parent port
// listener, and hands it the singletons it reads at dispatch.
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

import { DEFAULT_COMPANION_CONTROL_PLANE_URL } from "../../electron/companion-account-service.mjs";
import type { Notification } from "../../shared/notification.ts";
import type { Viewer, VisibleSet } from "../bot-visibility.ts";
import type { AppConfig } from "../config.ts";
import { PhonePush, PhonePushAccessSource, phonePushEnabled } from "../phone-push.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createPhonePushRoutes, phonePushIdentity } from "../routes/phone-push.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { Store } from "../store.ts";

export interface PhonePushHostDeps {
  dataDir: string;
  cfg: () => AppConfig;
  /** Late-bound: index.ts constructs the store after this. */
  store: () => Pick<Store, "group" | "groupByThread">;
  sessions: Pick<SessionRegistry, "list">;
  visibleTo: (viewer: Viewer) => VisibleSet;
  /** The open event streams, each with the phone behind it, if any. */
  streams: () => Iterable<{ pushKey?: string }>;
}

export interface PhonePushHost {
  /** The desktop app's private message carrying the relay access. */
  receive(message: unknown): boolean;
  dispatch: PhonePush["dispatch"];
  forget(key: string): void;
  /** features.phonePush, for the config status. */
  enabled(): boolean;
  /** The phone behind an event stream, keyed as its registration is. */
  streamKey(req: IncomingMessage, auth: RequestAuth): string | null;
  routes(): RouteHandler;
}

export function createPhonePushHost(deps: PhonePushHostDeps): PhonePushHost {
  // The control-plane access closed-app phone alerts use: the desktop app's
  // message, else `serve --tunnel`'s account file or a fleet's env.
  const access = new PhonePushAccessSource({
    // server/tunnel.ts TUNNEL_CREDENTIALS_FILE (`openmausbot serve --tunnel`)
    tunnelFile: join(deps.dataDir, "tunnel-account.json"),
    defaultControlPlane: DEFAULT_COMPANION_CONTROL_PLANE_URL,
  });

  /** Whether a registered phone may see this notification: the rule its event
   * stream applies (broadcast and bot-visibility.ts), for a phone that has no
   * stream open. A companion phone is the desktop owner's; a paired session
   * is judged by its own scopes and email. */
  function audience(key: string, notification: Notification, adminOnly: boolean): boolean {
    if (key.startsWith("companion:")) return true;
    const session = deps.sessions.list().find((candidate) => `session:${candidate.id}` === key);
    if (!session) return false;
    if (session.scopes.includes("admin")) return true;
    if (adminOnly) return false;
    const visible = deps.visibleTo({ kind: "member", ...(session.email ? { email: session.email } : {}) });
    return visible.everything || (visible.thread(notification.threadId) && (!notification.botId || visible.bot(notification.botId)));
  }

  // The callbacks read the event streams and visibility lazily, at dispatch.
  const push = new PhonePush({
    file: join(deps.dataDir, "push-devices.json"),
    access: () => access.current(),
    enabled: () => phonePushEnabled(deps.cfg()),
    live: (key) => Array.from(deps.streams()).some((client) => client.pushKey === key),
    audience,
    room: (notification) => {
      const store = deps.store();
      const group = (notification.groupId ? store.group(notification.groupId) : undefined) ?? store.groupByThread(notification.threadId);
      return group && !group.dm ? { id: group.id, name: group.name } : undefined;
    },
  });

  return {
    receive: (message) => access.receive(message),
    dispatch: (notification, options) => push.dispatch(notification, options),
    forget: (key) => push.forget(key),
    enabled: () => phonePushEnabled(deps.cfg()),
    streamKey: phonePushIdentity,
    routes: () => createPhonePushRoutes({ push }),
  };
}
