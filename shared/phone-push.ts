/** Closed-app phone alerts: the wire contract between a harness and the push
 * relay in the hosted control plane (cloudflare/control-plane), version 1.
 *
 * A paired phone gives its harness an APNs device token. When the harness
 * emits a notification, it asks the relay to wake that phone. The relay holds
 * the project's APNs key; the harness never does, so this works for App Store
 * and TestFlight builds and for a harness on a Mac, a VPS or in Docker alike.
 *
 * The push is content-free by construction. It carries the alert's kind, the
 * bot's and room's names and opaque ids, and nothing else: never the message
 * text, a reply, a file path or a secret. The phone fetches the content from
 * its harness when it opens. `phonePushNotification` is the only way the
 * harness builds one, and it reads only those fields.
 *
 * The same contract is written out in docs/ios-companion.md (for the iOS app)
 * and cloudflare/control-plane/README.md (for the relay). Change all three
 * together, and bump the version for anything a deployed relay or app could
 * misread. */

export const PHONE_PUSH_WIRE_VERSION = 1 as const;

/** The relay's paths, under the control plane's origin. Each takes
 * `Authorization: Bearer <omb_install_…>`, the installation credential the
 * harness already holds for the hosted transport. */
export const PHONE_PUSH_RELAY_PATHS = {
  register: "/v1/installations/self/push/register",
  unregister: "/v1/installations/self/push/unregister",
  send: "/v1/installations/self/push/send",
} as const;

export type ApnsEnvironment = "production" | "sandbox";
export const APNS_ENVIRONMENTS: readonly ApnsEnvironment[] = ["production", "sandbox"];

/** An APNs device token as the app hands it over: lowercase hex. Today's
 * tokens are 32 bytes; Apple reserves the right to grow them. */
export const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
/** An opaque tag the app makes up per saved computer and the harness echoes
 * in every push, so a tap opens the right computer in a multi-computer app. */
export const PAIRING_TAG = /^[A-Za-z0-9_-]{8,64}$/;
/** Ids as the harness mints them (bots, threads, rooms). */
export const PUSH_ID = /^[\w-]{1,120}$/;
/** A notification kind: today's NotifyKind values, and whatever a newer
 * harness adds (a relay or app treats an unknown kind as a plain alert). */
export const PUSH_KIND = /^[a-z][a-z-]{0,39}$/;
export const PUSH_NAME_MAX = 80;
export const PUSH_TITLE_MAX = 200;

/** What the phone gets, beside the alert's title. */
export interface PhonePushNotification {
  kind: string;
  /** Lock-screen title, built from `kind`, the bot's and the room's names alone. */
  title: string;
  botId: string;
  botName: string;
  threadId: string;
  roomId?: string;
  roomName?: string;
}

/** `PUT` body of the harness's own `/api/push/device`, from the phone. */
export interface PhonePushDeviceRegistration {
  token: string;
  environment: ApnsEnvironment;
  pairing?: string;
  /** false: this phone opted out; the registration is kept, nothing is sent. */
  enabled?: boolean;
}

/** Harness → relay: register or unregister one device token. */
export interface PushRelayDeviceRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  /** register only */
  environment?: ApnsEnvironment;
}

/** Harness → relay: wake one registered device. */
export interface PushRelaySendRequest {
  v: typeof PHONE_PUSH_WIRE_VERSION;
  token: string;
  /** Echoed to the app as `omb.pairing`. */
  pairing?: string;
  notification: PhonePushNotification;
}

/** The relay's error codes a harness acts on. Anything else is transient. */
export const PUSH_RELAY_ERRORS = {
  /** The relay has no registration of this token for this installation:
   * register it again, then retry once. */
  unknownDevice: "push_device_unknown",
  /** APNs says the token is dead (410 Unregistered, BadDeviceToken). The
   * relay already dropped it; the harness drops it too. */
  unregistered: "push_device_unregistered",
  /** The relay has no APNs key configured. Silent; try again much later. */
  unavailable: "push_unavailable",
} as const;

/** Kinds that mean a bot is blocked on the person: the relay marks them
 * time-sensitive. Everything else is an ordinary alert. */
export const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(["approval", "question", "sign-in", "mention"]);

/** The title for a push, in the same words the harness's own banner uses,
 * from names alone. Two kinds differ from buildNotification on purpose: a
 * sign-in request leaves out the website, and a spend notice its amounts. */
export function phonePushTitle(kind: string, botName: string, roomName?: string): string {
  const who = roomName ? `${botName} in ${roomName}` : botName;
  const title = (() => {
    switch (kind) {
      case "approval": return `${who} needs approval`;
      case "question": return `${who} has a question`;
      case "sign-in": return `${who} needs you to sign in`;
      case "mention": return `${who} mentioned you`;
      case "routine-failed": return `${who}'s routine failed`;
      case "routine-deferred": return `${who}'s routine is waiting`;
      case "turn-failed": return `${who} couldn't start`;
      case "incident": return `${who} hit a problem`;
      case "delegation-settled": return `${who} resumed with results`;
      case "done": return `${who} finished`;
      case "spend": return "Workspace spend notice";
      default: return `${who} needs you`;
    }
  })();
  return clip(title, PUSH_TITLE_MAX);
}

function clip(value: string, max: number): string {
  // Code points, not UTF-16 units, so a name is never cut inside an emoji.
  const points = [...value.replace(/[\p{Cc}\u2028\u2029]/gu, " ").trim()];
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : points.join("");
}

/** The push for one harness notification, or null when it cannot be sent
 * content-free (an id the contract does not allow). Reads only the kind,
 * the ids and the names; the notification's body never enters it. */
export function phonePushNotification(
  notification: { kind: string; botId: string; botName: string; threadId: string },
  room?: { id: string; name: string },
): PhonePushNotification | null {
  if (!PUSH_KIND.test(notification.kind) || !PUSH_ID.test(notification.botId) || !PUSH_ID.test(notification.threadId)) return null;
  const botName = clip(notification.botName, PUSH_NAME_MAX) || "A bot";
  const roomName = room && PUSH_ID.test(room.id) ? clip(room.name, PUSH_NAME_MAX) : "";
  return {
    kind: notification.kind,
    title: phonePushTitle(notification.kind, botName, roomName || undefined),
    botId: notification.botId,
    botName,
    threadId: notification.threadId,
    ...(room && roomName ? { roomId: room.id, roomName } : {}),
  };
}
