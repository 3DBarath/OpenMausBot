// Whose the shared notes are. Like About me, they are one person's: the
// installation's owner. On an installation only its owner reaches, that is
// every request and every one-to-one chat. Where other people reach it too
// (a device paired with chat-only access, members who sign in by email, a
// Slack relay), only the owner's own requests and the chats the owner
// started count. Where no single owner can be told (a hosted installation,
// more than one admin), nobody's do: an import is not offered there and no
// shared note is ever recalled. Pure rules; server/index.ts supplies the facts.

export interface OwnerFacts {
  /** A hosted installation: its admins come from a portal, and none of them is "the" owner. */
  hosted: boolean;
  /** A request from this computer without a session is its owner's (not just some local service's). */
  loopbackIsOwner: boolean;
  /** The addresses that may sign in as admin: emails, or `@domain` for a whole domain. */
  admins: readonly string[];
}

/** One person owns this installation, so admin access means "the owner":
 * not hosted, and at most one address may sign in as admin. A device paired
 * with full access is the owner's own, as it is everywhere else in the server. */
export function hasSingleOwner(facts: OwnerFacts): boolean {
  return !facts.hosted && facts.admins.length <= 1 && !facts.admins.some((entry) => entry.trim().startsWith("@"));
}

/** Whether a request is the owner's: made on this computer, or from a
 * signed-in device with admin access where there is one owner. */
export function ownerRequest(auth: { kind: "loopback" | "session"; scopes: readonly string[]; trust?: "service" }, facts: OwnerFacts): boolean {
  if (auth.kind === "loopback") return facts.loopbackIsOwner && auth.trust !== "service";
  return auth.scopes.includes("admin") && hasSingleOwner(facts);
}

/** Whether the owner wrote this user line. A line with no sender was sent on
 * this computer; a line with one came from a signed-in device, and is the
 * owner's only when that device has admin access (`adminDevice`) and there
 * is one owner. A line another bot asked, or one an outside service relayed
 * for someone, is never the owner's. */
export function ownerLine(
  line: { role?: string; peerAsk?: unknown; relayed?: boolean; sender?: { id?: string } } | undefined,
  facts: OwnerFacts & { adminDevice: (person: string) => boolean },
): boolean {
  if (!line || line.role !== "user" || line.peerAsk || line.relayed) return false;
  if (!line.sender) return facts.loopbackIsOwner;
  return typeof line.sender.id === "string" && hasSingleOwner(facts) && facts.adminDevice(line.sender.id);
}
