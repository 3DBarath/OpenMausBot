// Adopting older conversations: the one owner-only action that records the
// lines of a conversation from before this version as the owner's. Which
// conversations it takes and which it leaves, each for its own reason; that
// it never takes one twice, never takes back, and never takes a line or an
// answer written since proof began that nobody vouched for; nor a
// conversation that came from a backup, nor anything from before the record
// of whose lines are whose was lost. And that it does not hold the server up.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adoptConversations, adoptionPlan, type AdoptableConversation, type AdoptionFacts } from "./shared-notes-adopt.ts";
import { cardProofId, ownerProofIds } from "./shared-notes-owner.ts";
import { OwnerThreads } from "./shared-notes-threads.ts";

const SINCE = 1_000_000;
const OLD = SINCE - 5_000;
const NEW = SINCE + 5_000;
const facts: AdoptionFacts = { since: SINCE, loopbackIsOwner: true, singleOwner: true, ownerDevice: (person) => person === "p_owner_laptop" };

type Line = AdoptableConversation["lines"][number];
const mine = (id: string, at = OLD, over: Partial<Line> = {}): Line => ({ id, at, role: "user", ...over });
const bot = (id: string, at = OLD, over: Partial<Line> = {}): Line => ({ id, at, role: "bot", ...over });
const conversation = (lines: Line[], over: Partial<AdoptableConversation> = {}): AdoptableConversation => ({ threadId: "t1", room: false, routine: false, lines, ...over });

describe("which conversations can be adopted", () => {
  it("takes a conversation whose every line was typed at the computer or sent from the owner's own full-access device", () => {
    expect(adoptionPlan(conversation([mine("m1"), bot("b1"), mine("m2", OLD, { sender: { id: "p_owner_laptop" } }), mine("m3", NEW)]), facts))
      .toEqual({ older: ["m1", "m2"], later: ["m3"] });
    // another bot's words are not a person's, and a card answered at the computer is the owner's
    expect(adoptionPlan(conversation([mine("m1"), mine("p1", OLD, { peerAsk: { botId: "b2" } }), bot("c1", OLD, { card: { requestId: "r1", answeredBy: { kind: "loopback" } } })]), facts))
      .toEqual({ older: ["m1", cardProofId("r1")], later: [] });
    // nothing a person wrote: nothing to adopt, and nothing against it
    expect(adoptionPlan(conversation([bot("b1"), mine("p1", OLD, { peerAsk: { botId: "b2" } })]), facts)).toEqual({ older: [], later: [] });
  });

  it("leaves a conversation alone for each reason, and says which", () => {
    const skip = (lines: Line[], over: Partial<AdoptableConversation> = {}, with_: Partial<AdoptionFacts> = {}) => adoptionPlan(conversation(lines, over), { ...facts, ...with_ });
    // a group conversation or a room
    expect(skip([mine("m1")], { room: true })).toEqual({ skip: "room" });
    // a routine's or a webhook's run
    expect(skip([mine("m1")], { routine: true })).toEqual({ skip: "routine" });
    // a line relayed from Slack or any other relay
    expect(skip([mine("m1"), mine("m2", OLD, { relayed: true })])).toEqual({ skip: "relayed" });
    expect(skip([mine("m2", OLD, { relayed: true, sender: { id: "p_owner_laptop" } })])).toEqual({ skip: "relayed" });
    // a line whose recorded sender is not a live full-access device of the owner
    expect(skip([mine("m1"), mine("m2", OLD, { sender: { id: "p_guest_phone" } })])).toEqual({ skip: "sender" });
    expect(skip([mine("m2", OLD, { sender: {} })])).toEqual({ skip: "sender" });
    expect(skip([mine("m2", NEW, { sender: { id: "p_guest_phone" } })])).toEqual({ skip: "sender" });
    // …on an installation with more than one admin, no device is "the" owner's
    expect(skip([mine("m2", OLD, { sender: { id: "p_owner_laptop" } })], {}, { singleOwner: false })).toEqual({ skip: "sender" });
    // …and where a local request is only a service, a line with no sender is nobody's
    expect(skip([mine("m1")], {}, { loopbackIsOwner: false })).toEqual({ skip: "sender" });
    // a card answered from a signed-in device, or by a local service: whose it was is not recorded
    expect(skip([mine("m1"), bot("c1", OLD, { card: { requestId: "r1", answeredBy: { kind: "session" } } })])).toEqual({ skip: "card" });
    expect(skip([mine("m1"), bot("c1", OLD, { card: { requestId: "r1", answeredBy: { kind: "worker" } } })])).toEqual({ skip: "card" });
    // the first reason found is the one given: a room is a room whatever is in it
    expect(skip([mine("m2", OLD, { relayed: true })], { room: true })).toEqual({ skip: "room" });
  });

  it("holds back a conversation that came from a backup, whatever its lines say", () => {
    // brought in by an import: its lines carry no sender and look typed at the computer
    expect(adoptionPlan(conversation([mine("m1"), mine("m2", NEW)], { restored: true }), facts)).toEqual({ older: ["m1"], later: ["m2"], held: "restored" });
    expect(adoptionPlan(conversation([bot("b1")], { restored: true }), facts)).toEqual({ older: [], later: [], held: "restored" });
    // the whole installation was put back from an archive: everything with a line from before that moment
    const restored = { ...facts, restoredBefore: SINCE + 1_000 };
    expect(adoptionPlan(conversation([mine("m1"), bot("b1", NEW)]), restored)).toEqual({ older: ["m1"], later: [], held: "restored" });
    expect(adoptionPlan(conversation([mine("m1", SINCE + 500)]), restored)).toEqual({ older: [], later: ["m1"], held: "restored" });
    expect(adoptionPlan(conversation([bot("c1", OLD, { card: { requestId: "r1", answeredBy: { kind: "loopback" } } })]), restored)).toEqual({ older: [cardProofId("r1")], later: [], held: "restored" });
    // a conversation written here since is not held, and one with nothing a person wrote has nothing to hold
    expect(adoptionPlan(conversation([mine("m1", NEW)]), restored)).toEqual({ older: [], later: ["m1"] });
    expect(adoptionPlan(conversation([bot("b1")]), restored)).toEqual({ older: [], later: [] });
    // what the lines themselves say comes first
    expect(adoptionPlan(conversation([mine("m1", OLD, { sender: { id: "p_guest_phone" } })], { restored: true }), restored)).toEqual({ skip: "sender" });
  });

  it("holds back everything from before the record of whose lines are whose was lost", () => {
    const lost = { ...facts, lostBefore: SINCE + 1_000 };
    // an older line, and a line since proof began: after the loss nobody can say which later lines were vouched for
    expect(adoptionPlan(conversation([mine("m1")]), lost)).toEqual({ older: ["m1"], later: [], held: "lost" });
    expect(adoptionPlan(conversation([mine("m1", SINCE + 500)]), lost)).toEqual({ older: [], later: ["m1"], held: "lost" });
    expect(adoptionPlan(conversation([mine("m1", NEW), mine("m0")]), lost)).toEqual({ older: ["m0"], later: ["m1"], held: "lost" });
    // written since the loss: the new record decides
    expect(adoptionPlan(conversation([mine("m1", NEW)]), lost)).toEqual({ older: [], later: ["m1"] });
    // a backup is the stronger reason
    expect(adoptionPlan(conversation([mine("m1")]), { ...lost, restoredBefore: SINCE })).toEqual({ older: ["m1"], later: [], held: "restored" });
    expect(adoptionPlan(conversation([mine("m1")], { restored: true }), lost)).toEqual({ older: ["m1"], later: [], held: "restored" });
  });
});

describe("adopting", () => {
  let dir: string;
  let threads: OwnerThreads;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-adopt-"));
    threads = new OwnerThreads(join(dir, "shared-notes-threads.json"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (conversations: Iterable<AdoptableConversation>, with_: Partial<AdoptionFacts> = {}) => adoptConversations(conversations, { ...facts, since: SINCE, ...with_ }, threads);
  const standing = (one: AdoptableConversation) => threads.ownerOnly(one.threadId, ownerProofIds(one.lines));

  it("adopts what it can, counts what it leaves by reason, and the adopted conversation is then the owner's alone", async () => {
    const older = conversation([mine("m1"), bot("b1"), mine("m2")], { threadId: "older" });
    const guest = conversation([mine("m1"), mine("g1", OLD, { sender: { id: "p_guest_phone" } })], { threadId: "guest" });
    const empty = conversation([bot("b1")], { threadId: "empty" });
    const all = [
      older, guest, empty,
      conversation([mine("m1")], { threadId: "room", room: true }),
      conversation([mine("m1")], { threadId: "routine", routine: true }),
      conversation([mine("m1", OLD, { relayed: true })], { threadId: "relayed" }),
      conversation([bot("c1", OLD, { card: { requestId: "r1", answeredBy: { kind: "session" } } })], { threadId: "card" }),
    ];
    expect(standing(older)).toBe(false);
    expect(await run(all)).toEqual({ adopted: 1, already: 0, empty: 1, skipped: { room: 1, routine: 1, relayed: 1, sender: 1, card: 1, later: 0, restored: 0, lost: 0 } });
    expect(standing(older)).toBe(true);
    expect(standing(guest)).toBe(false);
    // it is kept across a restart
    expect(new OwnerThreads(join(dir, "shared-notes-threads.json")).ownerOnly("older", ["m1", "m2"])).toBe(true);
    // run again: what was adopted is left alone, and nothing else changed its mind
    expect(await run(all)).toEqual({ adopted: 0, already: 1, empty: 1, skipped: { room: 1, routine: 1, relayed: 1, sender: 1, card: 1, later: 0, restored: 0, lost: 0 } });
  });

  it("adopts the older lines of a conversation the owner has gone on writing in", async () => {
    // two lines from before, then one since, which was proven when it was written
    threads.prove("main", "m3");
    const main = conversation([mine("m1"), mine("m2"), mine("m3", NEW)], { threadId: "main" });
    expect(standing(main)).toBe(false);
    expect(await run([main])).toMatchObject({ adopted: 1 });
    expect(standing(main)).toBe(true);
    // a conversation started since, every line proven: nothing to do
    threads.prove("fresh", "n1");
    expect(await run([conversation([mine("n1", NEW)], { threadId: "fresh" })])).toMatchObject({ adopted: 0, already: 1 });
  });

  it("never adopts a line or an answer written since proof began that nobody vouched for", async () => {
    // a line with no sender written since: a chat-only device's edit looks exactly like this
    const edited = conversation([mine("m1"), mine("x1", NEW)], { threadId: "edited" });
    expect(await run([edited])).toMatchObject({ adopted: 0, skipped: { later: 1 } });
    expect(standing(edited)).toBe(false);
    // the owner's later line is proven, a stranger's is not
    threads.prove("mixed", "m2");
    expect(await run([conversation([mine("m1"), mine("m2", NEW), mine("x1", NEW)], { threadId: "mixed" })])).toMatchObject({ adopted: 0, skipped: { later: 1 } });
  });

  it("never adopts a conversation twice: one that lost its standing after it was adopted stays as it is", async () => {
    const main = conversation([mine("m1")], { threadId: "main" });
    expect(await run([main])).toMatchObject({ adopted: 1 });
    // someone else then writes in it
    const after = conversation([mine("m1"), mine("x1", NEW)], { threadId: "main" });
    expect(standing(after)).toBe(false);
    expect(await run([after])).toMatchObject({ adopted: 0, already: 1 });
    expect(standing(after)).toBe(false);
    // even written to look older than it is
    expect(await run([conversation([mine("m1"), mine("x1", OLD)], { threadId: "main" })])).toMatchObject({ adopted: 0, already: 1 });
    expect(threads.ownerOnly("main", ["m1", "x1"])).toBe(false);
  });

  it("never adopts a conversation that came from a backup, and counts it", async () => {
    // one an import brought in, one the owner wrote here, and one written before a restore of everything
    const imported = conversation([mine("m1"), mine("m2")], { threadId: "imported", restored: true });
    const own = conversation([mine("m1", SINCE - 100)], { threadId: "own" });
    const archive = conversation([mine("m1", SINCE - 4_000)], { threadId: "archive" });
    expect(await run([imported, own, archive], { restoredBefore: SINCE - 1_000 })).toMatchObject({ adopted: 1, skipped: { restored: 2, lost: 0, later: 0 } });
    expect(standing(imported)).toBe(false);
    expect(standing(archive)).toBe(false);
    expect(standing(own)).toBe(true);
    // not on a second click either
    expect(await run([imported, archive], { restoredBefore: SINCE - 1_000 })).toMatchObject({ adopted: 0, skipped: { restored: 2 } });
    // a conversation from the archive that the archive's own record proves keeps its standing, and is counted as the owner's already
    threads.prove("proven", "p1");
    expect(await run([conversation([mine("p1", OLD)], { threadId: "proven" })], { restoredBefore: SINCE })).toMatchObject({ adopted: 0, already: 1, skipped: { restored: 0 } });
  });

  it("adopts nothing from before the record was lost, and says how many it could not", async () => {
    const lostBefore = SINCE + 1_000;
    const all = [
      // an older conversation; one a guest edited since proof began (the edit carries no sender); one written since the loss
      conversation([mine("m1")], { threadId: "older" }),
      conversation([mine("m1"), mine("x1", SINCE + 500)], { threadId: "edited" }),
      conversation([mine("n1", NEW)], { threadId: "fresh" }),
      conversation([mine("m1")], { threadId: "room", room: true }),
    ];
    threads.prove("fresh", "n1");
    expect(await run(all, { lostBefore })).toEqual({ adopted: 0, already: 1, empty: 0, skipped: { room: 1, routine: 0, relayed: 0, sender: 0, card: 0, later: 0, restored: 0, lost: 2 } });
    expect(standing(all[0]!)).toBe(false);
    expect(standing(all[1]!)).toBe(false);
  });

  it("does not hold the server up or keep what it read: it gives way between batches of conversations", async () => {
    // 3,000 conversations of 120 lines, handed over one at a time and never kept
    const LINES = 120;
    let turns = 0;
    let readThisTurn = 0;
    let mostReadInOneTurn = 0;
    let worstStall = 0;
    let last = performance.now();
    let watching = true;
    const tick = (): void => {
      const now = performance.now();
      worstStall = Math.max(worstStall, now - last);
      last = now;
      turns += 1;
      readThisTurn = 0;
      if (watching) setImmediate(tick);
    };
    function* offered(): Generator<AdoptableConversation> {
      for (let index = 0; index < 3_000; index += 1) {
        readThisTurn += LINES;
        mostReadInOneTurn = Math.max(mostReadInOneTurn, readThisTurn);
        yield conversation(Array.from({ length: LINES }, (_, line) => (line % 2 ? bot(`b${index}-${line}`) : mine(`m${index}-${line}`))), { threadId: `thread-${index}` });
      }
    }
    setImmediate(tick);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = turns;
    last = performance.now();
    worstStall = 0;
    const result = await run(offered());
    watching = false;
    expect(result.adopted).toBe(3_000);
    // the rest of the server got a turn at least every 2,000 lines or so, whatever the machine's speed
    expect(turns - before).toBeGreaterThan(150);
    expect(mostReadInOneTurn).toBeLessThanOrEqual(2_000 + LINES);
    // and no stall came anywhere near the 1.25 s this took in one go
    expect(worstStall).toBeLessThan(250);
  });
});
