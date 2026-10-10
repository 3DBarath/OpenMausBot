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
//
// What is stored cannot tell a line typed at the computer from a line a
// device edited before this version (an edit recorded no sender), or from
// the prompt of a routine run that is no longer in the run history and whose
// conversation was later carried on by hand. That is why this is the owner
// saying so, and why the button says to use it only if nobody else has
// written in these conversations.
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
}

/** What adopting one conversation would record, or why it is left alone:
 * the ids of its older lines and answered cards, and of the ones since. */
export function adoptionPlan(conversation: AdoptableConversation, facts: AdoptionFacts): { skip: Exclude<AdoptionSkipReason, "later"> } | { older: string[]; later: string[] } {
  if (conversation.room) return { skip: "room" };
  if (conversation.routine) return { skip: "routine" };
  const older: string[] = [];
  const later: string[] = [];
  for (const line of conversation.lines) {
    if (personWrittenLine(line)) {
      if (line.relayed) return { skip: "relayed" };
      // a recorded sender must be the owner's own device, now; no sender means typed at this computer, where that is the owner
      const owners = line.sender ? facts.singleOwner && typeof line.sender.id === "string" && facts.ownerDevice(line.sender.id) : facts.loopbackIsOwner;
      if (!owners) return { skip: "sender" };
      (line.at < facts.since ? older : later).push(line.id);
    }
    if (personAnsweredCard(line)) {
      const id = cardProofId(line.card!.requestId!);
      if (line.at >= facts.since) later.push(id);
      // an older answer is the owner's only when it was given at this computer
      else if (line.card!.answeredBy?.kind === "loopback" && facts.loopbackIsOwner) older.push(id);
      else return { skip: "card" };
    }
  }
  return { older, later };
}

/** Adopt every conversation that can be, and count the rest by reason. */
export function adoptConversations(conversations: readonly AdoptableConversation[], facts: AdoptionFacts, threads: Pick<OwnerThreads, "adopt" | "writeNow">): AdoptionResult {
  const result: AdoptionResult = { adopted: 0, already: 0, empty: 0, skipped: { room: 0, routine: 0, relayed: 0, sender: 0, card: 0, later: 0 } };
  for (const conversation of conversations) {
    const plan = adoptionPlan(conversation, facts);
    if ("skip" in plan) {
      result.skipped[plan.skip] += 1;
      continue;
    }
    const outcome = threads.adopt(conversation.threadId, plan.older, plan.later);
    if (outcome === "later") result.skipped.later += 1;
    else result[outcome] += 1;
  }
  // one write for all of them, before the owner is told the counts
  if (result.adopted) threads.writeNow();
  return result;
}
