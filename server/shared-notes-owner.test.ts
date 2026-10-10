// Whose the shared notes are: the owner's requests and the owner's lines,
// and nobody else's, on every kind of installation.
import { describe, expect, it } from "vitest";

import { cardProofId, hasSingleOwner, ownerContinuesTurn, ownerLine, ownerProofIds, ownerRequest, ownerStartsTurn, personAnsweredCard, personWrittenLine, type OwnerFacts } from "./shared-notes-owner.ts";

const DESKTOP: OwnerFacts = { hosted: false, loopbackIsOwner: true, admins: [] };
const FAMILY: OwnerFacts = { hosted: false, loopbackIsOwner: true, admins: ["owner@example.test"] };
const TWO_ADMINS: OwnerFacts = { hosted: false, loopbackIsOwner: true, admins: ["owner@example.test", "second@example.test"] };
const DOMAIN_ADMINS: OwnerFacts = { hosted: false, loopbackIsOwner: true, admins: ["@example.test"] };
const HOSTED: OwnerFacts = { hosted: true, loopbackIsOwner: false, admins: [] };
const CLOUD_HOME: OwnerFacts = { hosted: false, loopbackIsOwner: false, admins: [] };

const local = { kind: "loopback" as const, scopes: ["admin", "client"] as const };
const service = { kind: "loopback" as const, scopes: ["client"] as const, trust: "service" as const };
const admin = { kind: "session" as const, scopes: ["admin", "client"] as const };
const chatOnly = { kind: "session" as const, scopes: ["client"] as const };

describe("one owner or several", () => {
  it("is one owner unless the installation is hosted or more than one address may sign in as admin", () => {
    expect([DESKTOP, FAMILY, CLOUD_HOME].map(hasSingleOwner)).toEqual([true, true, true]);
    expect([TWO_ADMINS, DOMAIN_ADMINS, HOSTED].map(hasSingleOwner)).toEqual([false, false, false]);
  });
});

describe("the owner's requests", () => {
  it("are those made on this computer, and those of a device with admin access where there is one owner", () => {
    expect(ownerRequest(local, DESKTOP)).toBe(true);
    expect(ownerRequest(admin, DESKTOP)).toBe(true);
    expect(ownerRequest(admin, FAMILY)).toBe(true);
    expect(ownerRequest(admin, CLOUD_HOME)).toBe(true);
  });

  it("are never a chat-only device's, a local service's, a second admin's or anyone's on a hosted installation", () => {
    for (const facts of [DESKTOP, FAMILY, TWO_ADMINS, HOSTED, CLOUD_HOME]) expect(ownerRequest(chatOnly, facts)).toBe(false);
    expect(ownerRequest(service, HOSTED)).toBe(false);
    expect(ownerRequest(service, DESKTOP)).toBe(false);
    expect(ownerRequest(local, CLOUD_HOME)).toBe(false);
    expect(ownerRequest(admin, TWO_ADMINS)).toBe(false);
    expect(ownerRequest(admin, DOMAIN_ADMINS)).toBe(false);
    expect(ownerRequest(admin, HOSTED)).toBe(false);
    // with several admins the owner is still the owner at the computer itself
    expect(ownerRequest(local, TWO_ADMINS)).toBe(true);
  });
});

describe("the owner's lines", () => {
  const adminDevice = (person: string) => person === "p_owner_laptop";
  const facts = (base: OwnerFacts) => ({ ...base, adminDevice });
  const typedHere = { role: "user" };
  const fromLaptop = { role: "user", sender: { id: "p_owner_laptop" } };
  const fromGuest = { role: "user", sender: { id: "p_guest_phone" } };

  it("are lines typed on this computer, and lines from the owner's own signed-in devices", () => {
    expect(ownerLine(typedHere, facts(DESKTOP))).toBe(true);
    expect(ownerLine(fromLaptop, facts(DESKTOP))).toBe(true);
    expect(ownerLine(fromLaptop, facts(FAMILY))).toBe(true);
    expect(ownerLine(fromLaptop, facts(CLOUD_HOME))).toBe(true);
    expect(ownerLine(typedHere, facts(TWO_ADMINS))).toBe(true);
  });

  it("are never a guest's, a member's, a second admin's, a relayed or a bot's line", () => {
    for (const base of [DESKTOP, FAMILY, TWO_ADMINS, HOSTED, CLOUD_HOME]) expect(ownerLine(fromGuest, facts(base))).toBe(false);
    // several admins, or hosted: a signed-in admin is not "the" owner
    expect(ownerLine(fromLaptop, facts(TWO_ADMINS))).toBe(false);
    expect(ownerLine(fromLaptop, facts(DOMAIN_ADMINS))).toBe(false);
    expect(ownerLine(fromLaptop, facts(HOSTED))).toBe(false);
    // where a local request is only a service, a line with no sender is nobody's
    expect(ownerLine(typedHere, facts(HOSTED))).toBe(false);
    expect(ownerLine(typedHere, facts(CLOUD_HOME))).toBe(false);
    // a Slack relay sends as this computer, for someone else
    expect(ownerLine({ role: "user", relayed: true }, facts(DESKTOP))).toBe(false);
    expect(ownerLine({ role: "user", peerAsk: { botId: "b2" } }, facts(DESKTOP))).toBe(false);
    expect(ownerLine({ role: "bot" }, facts(DESKTOP))).toBe(false);
    expect(ownerLine({ role: "user", sender: {} }, facts(DESKTOP))).toBe(false);
    expect(ownerLine(undefined, facts(DESKTOP))).toBe(false);
  });
});

describe("who started a turn", () => {
  const member = { kind: "session" as const, scopes: ["client"] as const };
  const secondAdmin = { kind: "session" as const, scopes: ["admin", "client"] as const };
  /** What the route hands the turn for a send, an edit, a regenerate or a late answer: the request's own authentication. */
  const started = (auth: Parameters<typeof ownerRequest>[0], facts: OwnerFacts) => ownerStartsTurn({ byOwner: ownerRequest(auth, facts) });

  it("is the owner only when the request that started it was the owner's", () => {
    expect(started(local, DESKTOP)).toBe(true);
    expect(started(admin, DESKTOP)).toBe(true);
    expect(started(admin, FAMILY)).toBe(true);
    expect(started(admin, CLOUD_HOME)).toBe(true);
    // a chat-only device, on every kind of installation
    for (const facts of [DESKTOP, FAMILY, TWO_ADMINS, HOSTED, CLOUD_HOME]) expect(started(chatOnly, facts)).toBe(false);
    // a member who signs in by email has chat-only access
    expect(started(member, FAMILY)).toBe(false);
    expect(started(member, TWO_ADMINS)).toBe(false);
    // a second admin: admin access, but not "the" owner
    expect(started(secondAdmin, TWO_ADMINS)).toBe(false);
    expect(started(secondAdmin, DOMAIN_ADMINS)).toBe(false);
    expect(started(secondAdmin, HOSTED)).toBe(false);
    // a local process where local is only a service
    expect(started(service, HOSTED)).toBe(false);
    expect(started(local, CLOUD_HOME)).toBe(false);
  });

  it("is never the owner when the starter is unknown: a missing sender is not proof", () => {
    expect(ownerStartsTurn({})).toBe(false);
    expect(ownerStartsTurn({ byOwner: undefined })).toBe(false);
    expect(ownerStartsTurn({ byOwner: false })).toBe(false);
  });

  it("is never the owner for a bot's words, a relay, a routine, a webhook or a resumed turn, whatever else is claimed", () => {
    expect(ownerStartsTurn({ byOwner: true })).toBe(true);
    for (const start of [
      { peerAsk: { botId: "b2" } }, { relayed: true }, { automationSource: "schedule" }, { automationSource: "webhook" }, { automationSource: "manual" },
      { unattended: true }, { commsDepth: 1 }, { cardContinuation: true },
    ]) expect(ownerStartsTurn({ byOwner: true, ...start }), JSON.stringify(start)).toBe(false);
  });

  it("keeps the proof only for the same request continued, and never makes one", () => {
    const proven = { messageId: "m1", ownerProven: true };
    expect(ownerContinuesTurn(proven, "m1", {})).toBe(true);
    // another message, a stopped request, an unproven one, or none at all
    expect(ownerContinuesTurn(proven, "m2", {})).toBe(false);
    expect(ownerContinuesTurn(proven, undefined, {})).toBe(false);
    expect(ownerContinuesTurn({ ...proven, stopped: true }, "m1", {})).toBe(false);
    expect(ownerContinuesTurn({ messageId: "m1" }, "m1", {})).toBe(false);
    expect(ownerContinuesTurn({ messageId: "m1", ownerProven: false }, "m1", {})).toBe(false);
    expect(ownerContinuesTurn(undefined, "m1", {})).toBe(false);
    // a card answered by nobody we can name, a bot's words, a routine
    for (const start of [{ cardContinuation: true }, { peerAsk: {} }, { automationSource: "schedule" }, { commsDepth: 2 }, { unattended: true }, { relayed: true }]) {
      expect(ownerContinuesTurn(proven, "m1", start), JSON.stringify(start)).toBe(false);
    }
  });

  it("counts every line a person wrote, with or without a sender, and not a bot's", () => {
    expect(personWrittenLine({ role: "user" })).toBe(true);
    expect(personWrittenLine({ role: "user", peerAsk: { botId: "b2" } })).toBe(false);
    expect(personWrittenLine({ role: "bot" })).toBe(false);
  });

  it("counts every card a person answered, and none the harness settled", () => {
    expect(personAnsweredCard({ card: { requestId: "r1", answeredBy: { kind: "session" } } })).toBe(true);
    expect(personAnsweredCard({ card: { requestId: "r1", answeredBy: { kind: "loopback" } } })).toBe(true);
    // open, or closed by the harness itself: nobody's words
    expect(personAnsweredCard({ card: { requestId: "r1" } })).toBe(false);
    expect(personAnsweredCard({ card: { answeredBy: { kind: "session" } } })).toBe(false);
    expect(personAnsweredCard({})).toBe(false);
    expect(ownerProofIds([
      { id: "m1", role: "user" },
      { id: "b1", role: "bot", card: { requestId: "r1", answeredBy: { kind: "session" } } },
      { id: "m2", role: "user", peerAsk: { botId: "b2" } },
      { id: "b2", role: "bot", card: { requestId: "r2" } },
      { id: "m3", role: "user" },
    ])).toEqual(["m1", cardProofId("r1"), "m3"]);
    expect(cardProofId("r1")).not.toBe("r1");
  });
});
