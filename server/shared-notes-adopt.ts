// Adopting older conversations (server/shared-notes-threads.ts keeps the
// record; server/shared-notes-owner.ts says who the owner is). A shared note
// is recalled only where every line a person wrote is proven the owner's,
// and a line written before this version has no proof: nothing recorded
// whose it was. Nothing adopts such a conversation by itself. The owner can
// vouch for them, once, with one action only the proven owner can take: it
// records the older lines of each conversation as the owner's.
//
// A conversation is offered for adoption unless what is stored says someone
// else had a hand in it:
//
//   room      a group conversation or a room
//   routine   a conversation a routine's or a webhook's run executed in,
//             where that can be told (the caller says how)
//   relayed   it holds a line an outside service relayed (Slack, a worker)
//   sender    it holds a line whose recorded sender is not a live
//             full-access device of the owner; or a line with no sender on
//             an installation where a local request is not the owner's
//   card      it holds a card answered from a signed-in device or by a local
//             service: whose device that was is not recorded
//   later     it holds a line or an answer written since proof began that
//             is not on record (decided by the record, not here)
//   restored  it came from a backup: an import brought it in beside the
//             others, or the whole installation was put back from an
//             archive after its lines were written. No request of a person
//             here wrote those lines, and a backup can hold anyone's
//   lost      it holds something from before the record of whose lines are
//             whose was last lost. Without that record an older line cannot
//             be told from a later one nobody vouched for
//
// The last two give way to one thing: a conversation the record already
// proves the owner's alone (or that was adopted before) is left exactly as
// it is and counted as theirs already.
//
// What is stored cannot tell a line typed at the computer from a line a
// device edited before this version (an edit recorded no sender then), or
// from the prompt of a routine run that is no longer in the run history and
// whose conversation was later carried on by hand. That is why this is the
// owner saying so, and why the button says to use it only if nobody else has
// written in these conversations.
//
// Conversations are read one at a time and not kept, and the rest of the
// server gets a turn between batches: an installation can hold thousands.
//
// Pure, but for the record it is given.
import { cardProofId, personAnsweredCard, personWrittenLine } from "./shared-notes-owner.ts";
import type { OwnerThreads } from "./shared-notes-threads.ts";
import type { AdoptionResult, AdoptionSkipReason } from "../shared/shared-notes.ts";

export interface AdoptableConversation {
  threadId: string;
  /** A group conversation or a room. */
  room: boolean;
  /** A routine's or a webhook's run executed here, as far as what is stored says. */
  routine: boolean;
  /** An import from a backup brought this conversation in: it says so on
   * its own record (TaskRecord.fromBackup), or the owner record names it
   * (OwnerThreads.imported). */
  restored?: boolean;
  lines: ReadonlyArray<{
    id: string;
    at: number;
    role?: string;
    peerAsk?: unknown;
    relayed?: boolean;
    sender?: { id?: string };
    card?: { requestId?: string; answeredBy?: { kind?: string } };
  }>;
}

export interface AdoptionFacts {
  /** When proof began on this installation (OwnerThreads.since). */
  since: number;
  /** A request from this computer without a session is its owner's. */
  loopbackIsOwner: boolean;
  /** One person owns this installation (hasSingleOwner). */
  singleOwner: boolean;
  /** Whether a person key is a live device with full access. */
  ownerDevice: (person: string) => boolean;
  /** Everything from before this moment came from a backup (OwnerThreads.restoredAt). */
  restoredBefore?: number | null;
  /** The record of whose lines are whose was lost at this moment (OwnerThreads.lostAt). */
  lostBefore?: number | null;
}

/** Why a conversation is not adopted although its own lines give no reason. */
export type AdoptionHold = Extract<AdoptionSkipReason, "restored" | "lost">;

/** How many lines are read before the rest of the server gets a turn. */
const BATCH_LINES = 2_000;

/** What adopting one conversation would record, or why it is left alone:
 * the ids of its older lines and answered cards, and of the ones since, and
 * whether something outside its lines holds it back. */
export function adoptionPlan(conversation: AdoptableConversation, facts: AdoptionFacts): { skip: Exclude<AdoptionSkipReason, "later" | AdoptionHold> } | { older: string[]; later: string[]; held?: AdoptionHold } {
  if (conversation.room) return { skip: "room" };
  if (conversation.routine) return { skip: "routine" };
  const older: string[] = [];
  const later: string[] = [];
  /** The earliest thing a person wrote or answered here. */
  let earliest = Number.POSITIVE_INFINITY;
  for (const line of conversation.lines) {
    if (personWrittenLine(line)) {
      if (line.relayed) return { skip: "relayed" };
      // a recorded sender must be the owner's own device, now; no sender means typed at this computer, where that is the owner
      const owners = line.sender ? facts.singleOwner && typeof line.sender.id === "string" && facts.ownerDevice(line.sender.id) : facts.loopbackIsOwner;
      if (!owners) return { skip: "sender" };
      (line.at < facts.since ? older : later).push(line.id);
      earliest = Math.min(earliest, line.at);
    }
    if (personAnsweredCard(line)) {
      const id = cardProofId(line.card!.requestId!);
      if (line.at >= facts.since) later.push(id);
      // an older answer is the owner's only when it was given at this computer
      else if (line.card!.answeredBy?.kind === "loopback" && facts.loopbackIsOwner) older.push(id);
      else return { skip: "card" };
      earliest = Math.min(earliest, line.at);
    }
  }
  const before = (moment: number | null | undefined): boolean => typeof moment === "number" && earliest < moment;
  if (conversation.restored || before(facts.restoredBefore)) return { older, later, held: "restored" };
  if (before(facts.lostBefore)) return { older, later, held: "lost" };
  return { older, later };
}

/** Adopt every conversation that can be, and count the rest by reason. Each
 * conversation is taken from `conversations` when its turn comes and let go
 * at once (hand over a generator that reads them), and the event loop gets a
 * turn every `BATCH_LINES` lines. */
export async function adoptConversations(conversations: Iterable<AdoptableConversation>, facts: AdoptionFacts, threads: Pick<OwnerThreads, "adopt" | "writeNow">): Promise<AdoptionResult> {
  const result: AdoptionResult = { adopted: 0, already: 0, empty: 0, skipped: { room: 0, routine: 0, relayed: 0, sender: 0, card: 0, later: 0, restored: 0, lost: 0 } };
  let read = 0;
  for (const conversation of conversations) {
    const plan = adoptionPlan(conversation, facts);
    if ("skip" in plan) result.skipped[plan.skip] += 1;
    else {
      const outcome = threads.adopt(conversation.threadId, plan.older, plan.later, plan.held);
      if (outcome === "adopted" || outcome === "already" || outcome === "empty") result[outcome] += 1;
      else result.skipped[outcome] += 1;
    }
    read += conversation.lines.length + 1;
    if (read >= BATCH_LINES) {
      read = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  // one write for all of them, before the owner is told the counts
  if (result.adopted) threads.writeNow();
  return result;
}
