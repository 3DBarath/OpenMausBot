// Whose the shared notes are: the owner's requests and the owner's lines,
// and nobody else's, on every kind of installation.
import { describe, expect, it } from "vitest";

import { hasSingleOwner, ownerLine, ownerRequest, type OwnerFacts } from "./shared-notes-owner.ts";

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
