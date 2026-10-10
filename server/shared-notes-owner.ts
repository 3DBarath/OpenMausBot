// Whose the shared notes are. Like About me, they are one person's: the
// installation's owner. On an installation only its owner reaches, that is
// every request and every one-to-one chat. Where other people reach it too
// (a device paired with chat-only access, members who sign in by email, a
// Slack relay), only the owner's own requests and the chats the owner
// started count. Where no single owner can be told (a hosted installation,
// more than one admin), nobody's do: an import is not offered there and no
// shared note is ever recalled. Pure rules; server/index.ts supplies the facts.
//
// Positive proof only. A shared note reaches a turn when three things are
// each proven, and never because something is missing:
//
//   1. the turn is a person's own one-to-one turn (server/recall.ts);
//   2. the request that started the turn was the owner's (`ownerRequest`,
//      taken from that request's own authentication, never from the stored
//      line: a line without a sender proves nothing);
//   3. every line a person wrote in the conversation was written by such a
//      request (server/shared-notes-threads.ts).
//
// Every way a turn can start in server/index.ts, and how its starter is known:
//
//   How the turn starts                         Who started it, and how that is known
//   ------------------------------------------  ----------------------------------------------------------
//   A message sent in a one-to-one chat         The sending request's authentication (`byOwner`), passed
//   (POST /api/bots/:id/messages, the words     from the route through acceptDirectSend to startTurn.
//   of a Live call)
//   The same message, after it waited in the    The proof taken when it was queued, kept in memory by
//   queue (a busy bot, a full slot list)        queue id. Every line the turn starts with must have it.
//                                               A restart loses it: not the owner.
//   An edit, a regenerate, or a rewind and      The editing request's authentication, never the line
//   resend (POST …/messages/:id/edit)           that was edited: an edit of the owner's line by anyone
//                                               else is theirs.
//   A late answer to a question card            The answering request's authentication.
//   The same request continued on another       The request it continues: the same starting message and
//   surface or on a backup engine (computer     the same record. Nothing new was said by anyone.
//   selection, automatic recovery)
//   A turn resumed after a card (connector,     Unknown: whoever answered or resumed the card is not
//   credential, computer, team setup), a        recorded with the turn. Not the owner.
//   compaction, a delegation's result coming
//   back, a coordination hand-off
//   A guarded send (a Slack relay, a worker)    Relayed for someone else. Never the owner.
//   A routine run, a webhook                    Nobody at the keyboard. Never the owner.
//   Another bot's words: an ask, a delegation,  A bot. Never the owner.
//   an aside, an incident report, a Chief's
//   retry, a thread a bot opened on itself
//   A room                                      Rooms never recall shared notes at all.
//   Anything else, or anything unprovable       Not the owner.
//
// Words steered into a turn that is already running start no turn; the line
// is proven or not like any other (3), and a line that is not is never
// steered into a turn whose session holds a recalled note.

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

/** What the harness knows about how one turn started (the table above). */
export interface TurnStart {
  /** `ownerRequest` said yes for the request whose message starts this turn.
   * Absent when no request is known: that is not proof. */
  byOwner?: boolean;
  /** The words are another bot's. */
  peerAsk?: unknown;
  /** An outside service relayed the words for someone. */
  relayed?: boolean;
  /** A routine run or a webhook. */
  automationSource?: unknown;
  unattended?: boolean;
  commsDepth?: number;
  /** A turn resumed after a card, a compaction or a hand-off: whoever caused it is not recorded. */
  cardContinuation?: boolean;
}

/** Whether a turn is proven to have been started by the owner: their own
 * request, saying their own words, with nobody and nothing in between. */
export function ownerStartsTurn(start: TurnStart): boolean {
  return start.byOwner === true && !start.peerAsk && !start.relayed && start.automationSource === undefined &&
    !start.unattended && !start.commsDepth && !start.cardContinuation;
}

/** Whether a turn that continues an earlier request (the same starting
 * message on another surface or a backup engine) keeps that request's
 * proof. It never gains one. */
export function ownerContinuesTurn(previous: { messageId?: string; ownerProven?: boolean; stopped?: boolean } | undefined, messageId: string | undefined, start: TurnStart): boolean {
  if (!previous?.ownerProven || previous.stopped || !messageId || previous.messageId !== messageId) return false;
  return !start.peerAsk && !start.relayed && start.automationSource === undefined && !start.unattended && !start.commsDepth && !start.cardContinuation;
}

/** A line a person wrote, for "is every line here the owner's": any user
 * line that is not another bot's words. A routine's prompt and a relayed
 * line count: someone wrote them, and nothing proves it was the owner. */
export function personWrittenLine(line: { role?: string; peerAsk?: unknown }): boolean {
  return line.role === "user" && !line.peerAsk;
}
