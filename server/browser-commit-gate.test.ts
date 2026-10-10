import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserCommitGate, browserCallTimeoutMs, cardWithoutPicture, type CommitCall } from "./browser-commit-gate.ts";
import { BrowserRuntime, type BrowserRef } from "./browser-runtime.ts";
import { OutboundCounts } from "./outbound-counts.ts";
import { OutboundRequestService } from "./outbound-requests.ts";
import { removeTempDir } from "./testing/cleanup.ts";

import type { OutboundPolicy } from "../shared/outbound.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { PageBlind, PageTarget } from "./browser-commit-page.ts";
import type { DecisionRow } from "./decision-log.ts";

const scratch: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const element = (extra: Partial<PageTarget> = {}): PageTarget => ({
  label: "Show details", role: "button", box: null, submits: false, search: false, card: false, multiline: false, fields: [], identity: "", context: "", secrets: false, ...extra,
});
const SEND = element({ label: "Send", submits: true, multiline: true, fields: [{ name: "Message", type: "textarea", value: "Hello there" }] });
const PAY = element({ label: "Continue", submits: true, card: true, fields: [{ name: "Card number", type: "card", length: 16 }] });
const CLICKED = { content: [{ type: "text", text: "clicked" }] };
const click = (selector = "@e4") => ({ name: "agent_browser_click", arguments: { selector } });

/** A gate over a real runtime gate, request service and daily counter, with a
 * scripted page and an in-memory thread. `answer` is the respond route. */
function fixture(options: { policy?: OutboundPolicy; holdMs?: number; handBackMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-commit-gate-"));
  scratch.push(dir);
  mkdirSync(dir, { recursive: true });
  const runtime = new BrowserRuntime({ takeoverTimeoutMs: 200 });
  runtimes.push(runtime);
  const requests = new OutboundRequestService();
  const counts = new OutboundCounts(join(dir, "outbound-counts.json"));
  const cards = new Map<string, OptionCardData>();
  const rows: Array<Omit<DecisionRow, "at">> = [];
  const refs = new Map<string, BrowserRef>();
  const state = {
    target: SEND as PageTarget | PageBlind,
    url: "https://mail.example.com/compose?draft=1#body" as string | null,
    policy: options.policy as OutboundPolicy | undefined,
    active: true,
    reads: [] as Array<{ selector: string | null; enter: boolean }>,
    /** Runs as each read of the page starts, with how many there have been. */
    onRead: undefined as ((count: number) => void) | undefined,
    dispatched: [] as unknown[],
    /** What the engine answers, when not the usual result. */
    result: undefined as unknown,
    dropped: [] as string[],
    shots: 0,
    resumed: 0,
  };
  const gate = new BrowserCommitGate({
    runtime: {
      hold: runtime.hold.bind(runtime), releaseHold: runtime.releaseHold.bind(runtime), personReleased: runtime.personReleased.bind(runtime),
      withAgentAction: runtime.withAgentAction.bind(runtime), ref: (_session, ref) => refs.get(ref),
    },
    requests, counts, holdMs: options.holdMs ?? 5_000, handBackMs: options.handBackMs ?? 1_000,
    policy: () => state.policy ?? null,
    post: ({ card }) => { const id = `card-${cards.size + 1}`; cards.set(id, card); return id; },
    patch: (_threadId, id, change) => { const card = cards.get(id); if (card) cards.set(id, change(card)); },
    resume: () => { state.resumed += 1; },
    log: (row) => { rows.push(row); },
    dropShot: (path) => { state.dropped.push(path); },
  });
  const abort = new AbortController();
  const call = (params: unknown, extra: Partial<CommitCall> = {}) => gate.guard({
    botId: "bot-1", botName: "Pepper", threadId: "thread-1", session: "s", params,
    page: {
      url: async () => state.url,
      target: async (selector, enter) => { state.reads.push({ selector, enter }); state.onRead?.(state.reads.length); return state.target; },
    },
    shot: async () => { state.shots += 1; return "/data/attachments/shot.jpg"; },
    admit: () => {},
    active: () => state.active,
    signal: abort.signal,
    dispatch: async (sent) => { state.dispatched.push(sent); return state.result ?? CLICKED; },
    ...extra,
  });
  /** The newest open card, once it is in the thread. */
  const pending = async () => {
    let card: OptionCardData | undefined;
    await vi.waitFor(() => {
      card = [...cards.values()].findLast((candidate) => !candidate.answered);
      expect(card).toBeDefined();
    });
    return card!;
  };
  /** What POST /respond does for an outbound card (resolveAndSendTrust). */
  const answer = async (behavior: "allow" | "deny") => {
    const card = await pending();
    const result = requests.resolve({ threadId: "thread-1", requestId: card.requestId!, behavior });
    if (result.claimed && result.state !== "already_settled") {
      for (const [id, candidate] of cards) if (candidate.requestId === card.requestId) cards.set(id, { ...candidate, answered: result.state === "allowed" ? "allow" : "deny" });
    }
    return result;
  };
  return { gate, runtime, requests, counts, cards, rows, refs, state, abort, call, pending, answer };
}
const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("what the gate looks at", () => {
  it("lets tools that cannot commit straight through, without reading the page", async () => {
    const f = fixture();
    for (const params of [
      { name: "agent_browser_fill", arguments: { selector: "@e3", text: "Hello\nthere" } },
      { name: "agent_browser_type", arguments: { selector: "@e3", text: "Hello" } },
      { name: "agent_browser_press", arguments: { key: "Tab" } },
      { name: "agent_browser_scroll", arguments: { direction: "down" } },
      { name: "agent_browser_open", arguments: { url: "https://example.com" } },
      { name: "agent_browser_snapshot", arguments: {} },
      { name: "agent_browser_click", arguments: {} },
      { name: "restart_browser" },
    ]) await expect(f.call(params)).resolves.toBe(CLICKED);
    expect(f.state.reads).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("reads an ordinary click once and lets it through", async () => {
    const f = fixture();
    f.state.target = element();
    await expect(f.call(click("#details"))).resolves.toBe(CLICKED);
    expect(f.state.reads).toEqual([{ selector: "#details", enter: false }]);
    expect(f.state.dispatched).toEqual([click("#details")]);
    expect(f.cards.size).toBe(0);
    expect(f.rows).toEqual([]);
  });

  it("leaves a selector the engine cannot find to the engine", async () => {
    const f = fixture();
    f.state.target = "missing";
    await expect(f.call(click("@e99"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });

  it("clicks nothing when the page could not be read: not knowing is not permission", async () => {
    const f = fixture();
    f.state.target = "unreadable";
    const result = await f.call(click()) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/could not read the page to check it first/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("refuses the call before any read when the route does not admit it", async () => {
    const f = fixture();
    await expect(f.call(click(), { admit: () => { throw new Error("another thread is using this browser"); } })).rejects.toThrow(/another thread/);
    expect(f.state.reads).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
  });

  it("says what the runtime says while a person has the browser", async () => {
    const f = fixture();
    await f.runtime.take("s", "person");
    await expect(f.call(click())).rejects.toThrow(/person controls this browser/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });
});

describe("policy", () => {
  it("asks by default: a send waits on a card that carries the send marker and the evidence", async () => {
    const f = fixture();
    const held = f.call(click());
    const card = await f.pending();
    expect(card).toMatchObject({
      title: "Send on your behalf?",
      subtitle: "mail.example.com · Send\nMessage: Hello there",
      options: ["Allow", "Deny"],
      tool: "agent_browser_click",
      heldCode: "approval.held.outbound",
      outboundRequest: { tool: "agent_browser_click", app: "mail.example.com", calls: [{ app: "mail.example.com", label: "Send" }] },
      browserCommit: { class: "send", host: "mail.example.com", label: "Send", fields: [{ name: "Message", type: "textarea", value: "Hello there" }], shot: "/data/attachments/shot.jpg" },
    });
    expect(f.runtime.ownerKind("s")).toBe("hold");
    expect(f.state.dispatched).toEqual([]);
    expect(f.rows).toEqual([expect.objectContaining({
      threadId: "thread-1", botId: "bot-1", botName: "Pepper", requestId: card.requestId, tool: "agent_browser_click",
      summary: "mail.example.com · Send\nMessage: Hello there", decision: "card-shown", source: "outbound", rule: "browser-commit:send",
    })]);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toEqual([click()]);
    expect(f.runtime.ownerKind("s")).toBeNull();
    // The screenshot was for the decision only.
    expect(f.state.dropped).toEqual(["/data/attachments/shot.jpg"]);
    expect([...f.cards.values()][0]!.browserCommit).not.toHaveProperty("shot");
    expect([...f.cards.values()][0]!.answered).toBe("allow");
    expect(f.state.resumed).toBe(1);
  });

  it("spends a daily allowance without a card, then asks once it is used up", async () => {
    const f = fixture({ policy: { policy: "allow", dailyCap: 2 } });
    await expect(f.call(click())).resolves.toBe(CLICKED);
    await expect(f.call(click())).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    expect(f.counts.today("bot-1")).toBe(2);
    expect(f.rows.map((row) => [row.decision, row.rule])).toEqual([
      ["auto-approved", "browser-commit:send:daily-allowance:1/2"],
      ["auto-approved", "browser-commit:send:daily-allowance:2/2"],
    ]);
    const third = f.call(click());
    expect((await f.pending()).title).toBe("Send on your behalf?");
    await f.answer("allow");
    await expect(third).resolves.toBe(CLICKED);
    // An approved send is the person's, not the allowance's.
    expect(f.counts.today("bot-1")).toBe(2);
    expect(f.state.dispatched).toHaveLength(3);
  });

  it("shares the counter with connected-app sends", async () => {
    const f = fixture({ policy: { policy: "allow", dailyCap: 1 } });
    f.counts.record("bot-1");
    const held = f.call(click());
    await f.pending();
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("always asks before money, whatever the allowance", async () => {
    const f = fixture({ policy: { policy: "allow", dailyCap: 100 } });
    f.state.target = PAY;
    f.state.url = "https://shop.example.com/checkout";
    const held = f.call(click());
    expect(await f.pending()).toMatchObject({
      title: "Spend money?",
      subtitle: "shop.example.com · Continue\nCard number: 16 characters, not shown",
      heldCode: "approval.held.money",
      browserCommit: { class: "money", fields: [{ name: "Card number", type: "card", length: 16 }] },
    });
    expect(f.counts.today("bot-1")).toBe(0);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.counts.today("bot-1")).toBe(0);
    expect(f.rows[0]).toMatchObject({ decision: "card-shown", rule: "browser-commit:money" });
  });

  it("sends nothing when the allowance cannot be saved", async () => {
    const f = fixture({ policy: { policy: "allow", dailyCap: 5 } });
    vi.spyOn(f.counts, "reserve").mockImplementation(() => { throw new Error("EACCES"); });
    expect(text(await f.call(click()))).toMatch(/daily allowance could not be saved/);
    expect(f.state.dispatched).toEqual([]);
  });
});

describe("the answer", () => {
  it("deny tells the bot not to retry", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    await f.answer("deny");
    const result = await held as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/the user declined\. Do not retry it; ask the user/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.runtime.ownerKind("s")).toBeNull();
    expect(f.state.dropped).toHaveLength(1);
  });

  it("times out: the card closes and the bot hears nobody answered", async () => {
    const f = fixture({ holdMs: 40 });
    const result = await f.call(click());
    expect(text(result)).toMatch(/nobody answered the approval in time/);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.state.dispatched).toEqual([]);
    expect(f.runtime.ownerKind("s")).toBeNull();
    expect(f.rows.at(-1)).toMatchObject({ decision: "auto-denied", rule: "browser-commit:send:unanswered" });
    // A late tap finds nothing to answer.
    expect(f.requests.resolve({ threadId: "thread-1", requestId: [...f.cards.values()][0]!.requestId!, behavior: "allow" })).toEqual({ claimed: false });
  });

  it("approve with an unchanged page dispatches the original call", async () => {
    const f = fixture();
    const held = f.call(click("@e4"));
    await f.pending();
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    // Read once to decide, once more to check the approval still fits.
    expect(f.state.reads).toHaveLength(2);
    expect(f.state.dispatched).toEqual([click("@e4")]);
  });

  it("approve after the page changed is void: the card says so and a new one is raised", async () => {
    const f = fixture();
    const held = f.call(click());
    const first = await f.pending();
    f.state.target = { ...SEND, fields: [{ name: "Message", type: "textarea", value: "Something else entirely" }] };
    await f.answer("allow");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.subtitle).toContain("Something else entirely");
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true, browserCommit: { pageChanged: true } });
    expect(f.rows.map((row) => row.rule)).toEqual(["browser-commit:send", "browser-commit:send:page-changed", "browser-commit:send"]);
    expect(f.runtime.ownerKind("s")).toBe("hold");
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toHaveLength(1);
  });

  it.each([
    ["the address", (f: ReturnType<typeof fixture>) => { f.state.url = "https://mail.example.com/compose?draft=2"; }],
    ["the label", (f: ReturnType<typeof fixture>) => { f.state.target = { ...SEND, label: "Send to all" }; }],
    ["a password's length", (f: ReturnType<typeof fixture>) => { f.state.target = { ...SEND, fields: [...SEND.fields, { name: "Password", type: "password", length: 9 }] }; }],
  ])("re-asks when %s changed", async (_what, change) => {
    const f = fixture();
    const held = f.call(click());
    const first = await f.pending();
    change(f);
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("does not re-ask for a new fragment alone", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.url = "https://mail.example.com/compose?draft=1#sent";
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(1);
  });

  it.each([["gone", "missing" as const], ["no longer a commitment", element()]])("approve after the target is %s clicks nothing", async (_what, target) => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.target = target;
    await f.answer("allow");
    expect(text(await held)).toMatch(/the page changed while it waited for approval/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(1);
    expect(f.runtime.ownerKind("s")).toBeNull();
  });
});

describe("what an approval is bound to", () => {
  const BUY = element({ label: "Buy now", identity: "html:0/body:1/ul:0/li:0/button:0#aaaaaaaaaaaaaaaa", context: "Sticker $1 Buy now" });

  // A snapshot taken while the card is open can give the same ref to
  // another element (measured: "Buy now" on a $1 item, then on an $18,000 one).
  it("is void when the selector now resolves to another element with the same label", async () => {
    const f = fixture();
    f.state.target = BUY;
    f.state.url = "https://shop.example.com/cart";
    const held = f.call(click("@e1"));
    const first = await f.pending();
    expect(first).toMatchObject({ title: "Spend money?", subtitle: "shop.example.com · Buy now\nWhere: Sticker $1 Buy now", browserCommit: { context: "Sticker $1 Buy now" } });
    f.state.target = { ...BUY, identity: "html:0/body:1/ul:0/li:1/button:0#aaaaaaaaaaaaaaaa", context: "Laptop $18,000 Buy now" };
    await f.answer("allow");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.subtitle).toBe("shop.example.com · Buy now\nWhere: Laptop $18,000 Buy now");
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", browserCommit: { pageChanged: true } });
    await f.answer("deny");
    await held;
  });

  it.each([
    ["the element's own markup", { identity: "html:0/body:1/ul:0/li:0/button:0#bbbbbbbbbbbbbbbb" }],
    ["the text around it", { context: "Sticker $1,000 Buy now" }],
  ])("is void when %s changed", async (_what, change) => {
    const f = fixture();
    f.state.target = BUY;
    const held = f.call(click("#buy"));
    const first = await f.pending();
    f.state.target = { ...BUY, ...change };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("masks a credential in the text around the button, on the card and in the log", async () => {
    const f = fixture();
    f.state.target = { ...BUY, context: "Use token=abcd1234efgh5678 to finish Buy now" };
    const held = f.call(click("#buy"));
    const card = await f.pending();
    expect(card.subtitle).toContain("Where: Use token=«redacted 16 chars» to finish Buy now");
    expect(JSON.stringify([card, f.rows])).not.toContain("abcd1234efgh5678");
    await f.answer("deny");
    await held;
  });

  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ name: `Field ${index + 1}`, type: "text", value: `value ${index + 1}` }));

  it("covers every field, and the card says how many it does not show", async () => {
    const f = fixture();
    f.state.target = { ...SEND, fields: many(35) };
    const held = f.call(click());
    const first = await f.pending();
    expect(first.browserCommit!.fields).toHaveLength(12);
    expect(first.browserCommit).toMatchObject({ more: 23 });
    expect(first.subtitle.split("\n").at(-1)).toBe("and 23 more fields, not shown here");
    expect(first.subtitle.split("\n")).toHaveLength(14);
    // The 33rd field is not on the card. It is in the approval all the same.
    f.state.target = { ...SEND, fields: many(35).map((field, index) => (index === 32 ? { ...field, value: "changed" } : field)) };
    await f.answer("allow");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(f.state.dispatched).toEqual([]);
    await f.answer("deny");
    await held;
  });

  it("says one more field in the singular, and nothing when all are shown", async () => {
    const f = fixture();
    f.state.target = { ...SEND, fields: many(13) };
    const held = f.call(click());
    expect((await f.pending()).subtitle.split("\n").at(-1)).toBe("and 1 more field, not shown here");
    await f.answer("deny");
    await held;
    f.state.target = { ...SEND, fields: many(12) };
    const all = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).not.toContain("more field");
    expect(card.browserCommit).not.toHaveProperty("more");
    await f.answer("deny");
    await all;
  });

  it("covers a long value to its last character, and the card says it was shortened", async () => {
    const f = fixture();
    const essay = "long ".repeat(600);
    f.state.target = { ...SEND, fields: [{ name: "Essay", type: "textarea", value: essay }] };
    const held = f.call(click());
    const first = await f.pending();
    expect(first.browserCommit!.fields).toEqual([{ name: "Essay", type: "textarea", value: `${essay.trim().slice(0, 200)}…`, length: 3_000 }]);
    expect(first.subtitle.split("\n")[1]).toBe(`Essay: ${essay.trim().slice(0, 200)}… (3,000 characters in all)`);
    f.state.target = { ...SEND, fields: [{ name: "Essay", type: "textarea", value: `${essay.slice(0, 2_990)}WIRE $9,000` }] };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    expect(f.state.dispatched).toEqual([]);
    await f.answer("deny");
    await held;
  });

  it("keeps the whole subtitle inside its limit by showing fewer fields, never by cutting the count off", async () => {
    const f = fixture();
    f.state.target = { ...SEND, fields: Array.from({ length: 12 }, (_, index) => ({ name: `Paragraph ${index + 1}`, type: "textarea", value: "wordy ".repeat(100) })) };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle.length).toBeLessThanOrEqual(1_500);
    const shown = card.browserCommit!.fields.length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(12);
    expect(card.subtitle.split("\n").at(-1)).toBe(`and ${12 - shown} more fields, not shown here`);
    expect(card.browserCommit).toMatchObject({ more: 12 - shown });
    await f.answer("deny");
    await held;
  });
});

describe("the bot's request closes after the answer", () => {
  it.each([
    ["its request closed", (f: ReturnType<typeof fixture>) => { f.abort.abort(); }],
    ["its turn ended", (f: ReturnType<typeof fixture>) => { f.state.active = false; }],
  ])("clicks nothing when %s while the approved page was read again, and closes the card", async (_what, end) => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    // The second read is the check after Allow: the request goes away during it.
    f.state.onRead = (count) => { if (count === 2) end(f); };
    await f.answer("allow");
    expect(text(await held)).toMatch(/nobody answered the approval in time/);
    expect(f.state.reads).toHaveLength(2);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.rows.at(-1)).toMatchObject({ decision: "auto-denied", rule: "browser-commit:send:gone" });
    expect(f.runtime.ownerKind("s")).toBeNull();
  });

  it("clicks nothing when it closed while the person still had the browser", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    await f.runtime.take("s", "person");
    await f.answer("allow");
    f.abort.abort();
    f.runtime.release("s", "person");
    expect(text(await held)).toMatch(/nobody answered the approval in time/);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
  });
});

describe("an approval the page can no longer back", () => {
  it("clicks nothing when the page cannot be read again, and closes the card without blaming the page", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.target = "unreadable";
    await f.answer("allow");
    expect(text(await held)).toMatch(/could not read the page to check it first/);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect([...f.cards.values()][0]!.browserCommit).not.toHaveProperty("pageChanged");
    expect(f.rows.at(-1)).toMatchObject({ decision: "auto-denied", rule: "browser-commit:send:unreadable" });
    expect(f.runtime.ownerKind("s")).toBeNull();
  });
});

describe("a person at the browser during a hold", () => {
  it("can take it; the hold stays, and the approved call waits for the hand-back", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    await expect(f.runtime.take("s", "person")).resolves.toBe(false);
    expect(f.runtime.ownerKind("s")).toBe("person");
    await f.answer("allow");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.state.dispatched).toEqual([]);
    f.runtime.release("s", "person");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toEqual([click()]);
  });

  it("is caught by the digest when they changed what would be sent", async () => {
    const f = fixture();
    const held = f.call(click());
    const first = await f.pending();
    await f.runtime.take("s", "person");
    f.state.target = { ...SEND, fields: [{ name: "Message", type: "textarea", value: "Edited by hand" }] };
    await f.answer("allow");
    f.runtime.release("s", "person");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.subtitle).toContain("Edited by hand");
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("clicks nothing when they still have the browser after the wait", async () => {
    const f = fixture({ handBackMs: 30 });
    const held = f.call(click());
    await f.pending();
    await f.runtime.take("s", "person");
    await f.answer("allow");
    expect(text(await held)).toMatch(/approved it but is still using the browser/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.runtime.ownerKind("s")).toBe("person");
    f.runtime.release("s", "person");
    expect(f.runtime.ownerKind("s")).toBeNull();
  });
});

describe("one hold per browser, and none without a bot waiting", () => {
  it("refuses a second commitment while one is waiting", async () => {
    const f = fixture();
    const first = f.call(click());
    await f.pending();
    expect(text(await f.call(click("@e7")))).toMatch(/another approval is already waiting/);
    expect(f.cards.size).toBe(1);
    await f.answer("deny");
    await first;
  });

  it.each([
    ["its turn ended", (f: ReturnType<typeof fixture>) => { f.state.active = false; }],
    ["its request closed", (f: ReturnType<typeof fixture>) => { f.abort.abort(); }],
  ])("closes the card and frees the browser when %s", async (_what, end) => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    end(f);
    await held;
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect([...f.cards.values()][0]!.browserCommit).not.toHaveProperty("shot");
    expect(f.runtime.ownerKind("s")).toBeNull();
    expect(f.requests.pending("thread-1")).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
  }, 5_000);

  it("posts the card without a picture when the screenshot fails", async () => {
    const f = fixture();
    const held = f.call(click(), { shot: async () => { throw new Error("no open page"); } });
    expect((await f.pending()).browserCommit).not.toHaveProperty("shot");
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dropped).toEqual([]);
  });
});

describe("Enter", () => {
  const press = (key: string) => ({ name: "agent_browser_press", arguments: { key } });
  const BOX = element({ label: "Write a message", role: "textbox", box: "multiline", multiline: true, fields: [{ name: "Write a message", type: "contenteditable", value: "On my way" }] });

  it("in a message box is a send, shown with what the box holds", async () => {
    const f = fixture();
    f.state.target = BOX;
    const held = f.call(press("Enter"));
    expect(await f.pending()).toMatchObject({
      subtitle: "mail.example.com · Enter in Write a message\nWrite a message: On my way",
      tool: "agent_browser_press",
      outboundRequest: { calls: [{ app: "mail.example.com", label: "Enter in Write a message" }] },
    });
    expect(f.state.reads).toEqual([{ selector: null, enter: true }]);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
  });

  it("with Shift is a new line there, and other keys are never read", async () => {
    const f = fixture();
    f.state.target = BOX;
    await expect(f.call(press("Shift+Enter"))).resolves.toBe(CLICKED);
    await expect(f.call(press("a"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    expect(f.state.reads).toHaveLength(1);
  });

  it("typed as a line break is refused where it would commit, and typed where it would not", async () => {
    const f = fixture();
    const typed = { name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way\n" } };
    f.state.target = BOX;
    const refused = await f.call(typed) as { isError: boolean };
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/agent_browser_fill, then press Enter or click the button/);
    expect(f.state.reads).toEqual([{ selector: "#composer", enter: true }]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
    f.state.target = element({ label: "Log in", box: "single", submits: true });
    await expect(f.call(typed)).resolves.toBe(CLICKED);
  });
});

describe("what the page read cannot see", () => {
  it("judges a click inside a frame by the snapshot's own name for the ref", async () => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e27", { role: "button", name: "Pay" });
    f.refs.set("e28", { role: "textbox", name: "Message" });
    await expect(f.call(click("@e28"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    const held = f.call(click("@e27"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", subtitle: "mail.example.com · Pay", browserCommit: { class: "money", label: "Pay", fields: [] } });
    await f.answer("deny");
    await held;
  });

  // The engine found something there. With no description and no name for
  // it, nothing says the click is harmless.
  it.each(["@e31", "#pay-in-frame"])("clicks nothing at %s when the read cannot describe it and the snapshot never named it", async (selector) => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e27", { role: "button", name: "Pay" });
    const result = await f.call(click(selector)) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/could not check what this would act on/);
    expect(text(result)).toMatch(/@ref from a new snapshot/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("refuses text typed with a line break into an element it cannot describe", async () => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e28", { role: "textbox", name: "Message" });
    const result = await f.call({ name: "agent_browser_type", arguments: { selector: "@e28", text: "On my way\n" } }) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([]);
  });

  it("refuses a selector the read will not hand to the engine, and says what to use instead", async () => {
    const f = fixture();
    f.state.target = "unusable";
    const result = await f.call(click(`#send${",#nope".repeat(400)}`)) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/@ref from a snapshot, or a shorter selector/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("holds when the snapshot names a commitment the page's own text does not", async () => {
    const f = fixture();
    f.state.target = element({ label: "➤" });
    f.refs.set("e4", { role: "button", name: "Send message" });
    const held = f.call(click("ref=e4"));
    expect((await f.pending()).browserCommit).toMatchObject({ class: "send", label: "Send message" });
    await f.answer("deny");
    await held;
  });

  it("names a control with no label by its role, and a page with no address plainly", async () => {
    const f = fixture();
    f.state.target = element({ label: "", submits: true, multiline: true });
    f.state.url = null;
    const held = f.call(click());
    expect((await f.pending()).subtitle).toBe("this page · unlabelled button");
    await f.answer("deny");
    await held;
  });
});

describe("the calls that are judged", () => {
  // The engine's check and uncheck make a real click on any element, a Send
  // button included (agent-browser 0.37.0).
  it.each(["agent_browser_check", "agent_browser_uncheck", "agent_browser_select"])("judges %s like a click", async (name) => {
    const f = fixture();
    const params = { name, arguments: { selector: "@e4", ...(name === "agent_browser_select" ? { values: ["now"] } : {}) } };
    const held = f.call(params);
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", tool: name, outboundRequest: { tool: name } });
    expect(f.state.reads).toEqual([{ selector: "@e4", enter: false }]);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toEqual([params]);
    f.state.target = element({ label: "Remember me", role: "checkbox" });
    await expect(f.call(params)).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(1);
  });

  it("holds when any element in the box is a commitment, and shows the most serious one", async () => {
    const f = fixture();
    f.state.target = { ...element({ label: "Cancel" }), also: [element({ label: "Next" }), SEND, PAY] };
    const held = f.call(click("#cell"));
    expect(await f.pending()).toMatchObject({
      title: "Spend money?", subtitle: "mail.example.com · Continue\nCard number: 16 characters, not shown", browserCommit: { class: "money", label: "Continue" },
    });
    await f.answer("deny");
    await held;
    f.state.target = { ...element({ label: "Cancel" }), also: [SEND] };
    const sending = f.call(click("#cell"));
    expect((await f.pending()).browserCommit).toMatchObject({ class: "send", label: "Send" });
    await f.answer("deny");
    await sending;
    f.state.target = { ...element({ label: "Cancel" }), also: [element({ label: "Next" })] };
    await expect(f.call(click("#cell"))).resolves.toBe(CLICKED);
  });

  it("voids an approval when another element joins the box", async () => {
    const f = fixture();
    const held = f.call(click("#cell"));
    const first = await f.pending();
    f.state.target = { ...SEND, also: [PAY] };
    await f.answer("allow");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.title).toBe("Spend money?");
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  // The engine trims a selector; "@e4 " is ref e4 to it (agent-browser 0.37.0).
  it.each(["@e4 ", " @e4", "@e4\n", "\t@e4\u00a0", "@e4\u0085", "\ufeffref=e4"])("reads %j as the ref it is, and sends on what it read", async (selector) => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e4", { role: "button", name: "Pay" });
    const held = f.call(click(selector));
    expect((await f.pending()).browserCommit).toMatchObject({ class: "money", label: "Pay" });
    const tidy = selector.includes("ref=") ? "ref=e4" : "@e4";
    expect(f.state.reads).toEqual([{ selector: tidy, enter: false }]);
    await f.answer("allow");
    await held;
    expect(f.state.dispatched).toEqual([click(tidy)]);
  });

  it("sends a call it did not have to tidy exactly as the bot wrote it", async () => {
    const f = fixture();
    f.state.target = element();
    const params = { name: "agent_browser_click", arguments: { selector: "#details", newTab: false } };
    await f.call(params);
    expect(f.state.dispatched[0]).toBe(params);
  });

  // agent_browser_type presses Tab for "\t" too: the focus moves, and the
  // Enter that follows lands on whatever is next (measured: a Log in button).
  it("refuses text typed with a tab before a line break, whatever the field is", async () => {
    const f = fixture();
    f.state.target = element({ label: "Log in", box: "single", submits: true });
    const result = await f.call({ name: "agent_browser_type", arguments: { selector: "#user", text: "ada\t\n" } }) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([]);
    await expect(f.call({ name: "agent_browser_type", arguments: { selector: "#user", text: "ada\tlovelace" } })).resolves.toBe(CLICKED);
  });
});

describe("reload after a commitment", () => {
  const reload = { name: "agent_browser_reload", arguments: {} };
  const open = (url: string) => ({ name: "agent_browser_open", arguments: { url } });
  const sent = async (f: ReturnType<typeof fixture>) => {
    const held = f.call(click());
    await f.pending();
    await f.answer("allow");
    await held;
  };

  it("passes a reload when nothing was sent from this browser", async () => {
    const f = fixture();
    await expect(f.call(reload)).resolves.toBe(CLICKED);
    expect(f.state.reads).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  // Reloading the page a form posted to posts it again (agent-browser 0.37.0).
  it("holds a reload after an approved commitment, with that commitment's class and what it sent", async () => {
    const f = fixture();
    f.state.target = PAY;
    f.state.url = "https://shop.example.com/checkout";
    await sent(f);
    f.state.url = "https://shop.example.com/receipt";
    const held = f.call(reload);
    const card = await f.pending();
    expect(card).toMatchObject({
      title: "Spend money?", tool: "agent_browser_reload",
      subtitle: "shop.example.com · Reload, which can repeat “Continue”\nCard number: 16 characters, not shown",
      browserCommit: { class: "money", host: "shop.example.com", label: "Reload, which can repeat “Continue”" },
    });
    expect(card.browserCommit).not.toHaveProperty("shot");
    await f.answer("deny");
    expect(text(await held)).toMatch(/the user declined/);
    expect(f.state.dispatched).toEqual([click()]);
    // Still held the next time, and Allow reloads.
    const again = f.call(reload);
    await f.pending();
    await f.answer("allow");
    await expect(again).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toEqual([click(), reload]);
  });

  it("holds it after a send the daily allowance let through, and spends from the allowance for the reload too", async () => {
    const f = fixture({ policy: { policy: "allow", dailyCap: 2 } });
    await expect(f.call(click())).resolves.toBe(CLICKED);
    await expect(f.call(reload)).resolves.toBe(CLICKED);
    expect(f.counts.today("bot-1")).toBe(2);
    const held = f.call(reload);
    expect((await f.pending()).title).toBe("Send on your behalf?");
    await f.answer("deny");
    await held;
    expect(f.rows.map((row) => row.rule)).toEqual([
      "browser-commit:send:daily-allowance:1/2", "browser-commit:send:daily-allowance:2/2", "browser-commit:send",
    ]);
  });

  it("stops holding once the bot has opened another address", async () => {
    const f = fixture();
    await sent(f);
    await expect(f.call(open("https://mail.example.com/inbox"))).resolves.toBe(CLICKED);
    await expect(f.call(reload)).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(1);
  });

  it.each([
    ["the same address", "https://mail.example.com/compose?draft=1"],
    ["the same address with another fragment", "https://mail.example.com/compose?draft=1#sent"],
    ["nothing it can read as an address", "::not a url::"],
  ])("goes on holding after an open to %s", async (_what, url) => {
    const f = fixture();
    await sent(f);
    await f.call(open(url));
    const held = f.call(reload);
    await f.pending();
    await f.answer("deny");
    await held;
  });

  it("goes on holding when the open failed, or the address could not be read", async () => {
    const f = fixture();
    await sent(f);
    f.state.result = { isError: true, content: [{ type: "text", text: "net::ERR_NAME_NOT_RESOLVED" }] };
    await f.call(open("https://nowhere.example/"));
    f.state.result = undefined;
    f.state.url = null;
    await f.call(open("https://mail.example.com/inbox"));
    const held = f.call(reload);
    await f.pending();
    await f.answer("deny");
    await held;
  });

  // Back returns to the page the form posted to, and a reload there posts again.
  it.each(["agent_browser_back", "agent_browser_forward", "agent_browser_tab_switch", "agent_browser_tab_close"])("holds again after %s", async (name) => {
    const f = fixture();
    await sent(f);
    await f.call(open("https://mail.example.com/inbox"));
    await f.call({ name, arguments: {} });
    const held = f.call(reload);
    await f.pending();
    await f.answer("deny");
    await held;
  });

  it.each(["agent_browser_close", "restart_browser"])("forgets the commitment when the browser is closed with %s", async (name) => {
    const f = fixture();
    await sent(f);
    await f.call({ name, arguments: {} });
    await expect(f.call(reload)).resolves.toBe(CLICKED);
  });

  it("keeps money as the class when a send follows a payment", async () => {
    const f = fixture();
    f.state.target = PAY;
    await sent(f);
    f.state.target = SEND;
    await sent(f);
    const held = f.call(reload);
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { label: "Reload, which can repeat “Send”" } });
    await f.answer("deny");
    await held;
  });

  it("voids the approval when the address changed while the reload waited", async () => {
    const f = fixture();
    await sent(f);
    const held = f.call(reload);
    const first = await f.pending();
    f.state.url = "https://mail.example.com/elsewhere";
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([click()]);
  });
});

describe("the picture on the card", () => {
  it("is not taken when the page shows a field the card masks, and the card says so", async () => {
    const f = fixture();
    f.state.target = { ...SEND, secrets: true };
    const held = f.call(click());
    const card = await f.pending();
    expect(f.state.shots).toBe(0);
    expect(card.browserCommit).not.toHaveProperty("shot");
    expect(card.browserCommit).toMatchObject({ noShot: true });
    await f.answer("allow");
    await held;
    expect(f.state.dropped).toEqual([]);
  });

  it("is not taken of a page the read could not look at: a frame may hold a card form", async () => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e4", { role: "button", name: "Pay" });
    const held = f.call(click("@e4"));
    const card = await f.pending();
    expect(f.state.shots).toBe(0);
    expect(card.browserCommit).toMatchObject({ noShot: true });
    await f.answer("deny");
    await held;
  });

  it("is not taken when any element sharing the box is on a page with one", async () => {
    const f = fixture();
    f.state.target = { ...element({ label: "Cancel", secrets: true }), also: [SEND] };
    const held = f.call(click());
    expect((await f.pending()).browserCommit).toMatchObject({ noShot: true });
    expect(f.state.shots).toBe(0);
    await f.answer("deny");
    await held;
  });

  it("is taken otherwise, and the card carries no note", async () => {
    const f = fixture();
    const held = f.call(click());
    const card = await f.pending();
    expect(f.state.shots).toBe(1);
    expect(card.browserCommit).toMatchObject({ shot: "/data/attachments/shot.jpg" });
    expect(card.browserCommit).not.toHaveProperty("noShot");
    await f.answer("deny");
    await held;
  });

  it("masks a card number written inside other text, on the card and in the log", async () => {
    const f = fixture();
    f.state.target = { ...SEND, context: "Paying with 4242 4242 4242 4242 Send", fields: [
      { name: "Message", type: "textarea", value: "Charge my card 5555-5555-5555-4444 please, order 1234567890123456" },
    ] };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).toBe("mail.example.com · Send\nWhere: Paying with «card number» Send\nMessage: Charge my card «card number» please, order 1234567890123456");
    expect(JSON.stringify([card, f.rows])).not.toMatch(/4242 4242|5555-5555/);
    await f.answer("deny");
    await held;
  });
});

describe("a card nobody can answer any more", () => {
  // After a restart the picture a card pointed at has been deleted.
  it("loses its picture and its no-picture note, and nothing else", () => {
    const card: OptionCardData = {
      title: "Send on your behalf?", subtitle: "mail.example.com · Send", options: ["Allow", "Deny"], requestId: "r",
      browserCommit: { class: "send", host: "mail.example.com", label: "Send", fields: [], more: 2, shot: "/data/attachments/shot.jpg", noShot: true },
    };
    expect(cardWithoutPicture(card)).toEqual({ ...card, browserCommit: { class: "send", host: "mail.example.com", label: "Send", fields: [], more: 2 } });
    const plain: OptionCardData = { title: "Approval needed", subtitle: "git push", options: ["Allow", "Deny"] };
    expect(cardWithoutPicture(plain)).toBe(plain);
  });
});

describe("what is shown and kept", () => {
  it("redacts secrets, flattens line breaks and bounds long text on the card and in the log", async () => {
    const f = fixture();
    f.state.target = { ...SEND, fields: [
      { name: "Message", type: "textarea", value: "line one\n\nline two token=abcd1234efgh5678" },
      { name: "Notes", type: "textarea", value: "x".repeat(900) },
      { name: "Password", type: "password", length: 14 },
    ] };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).toContain("Message: line one line two token=«redacted 16 chars»");
    expect(card.subtitle).not.toContain("abcd1234efgh5678");
    expect(card.subtitle).toContain("Password: 14 characters, not shown");
    expect(card.subtitle.split("\n")).toHaveLength(4);
    expect(card.browserCommit!.fields[1]!.value).toHaveLength(201);
    expect(card.browserCommit!.fields[1]!.length).toBe(900);
    expect(card.subtitle).toContain("… (900 characters in all)");
    expect(JSON.stringify(f.rows)).not.toContain("abcd1234efgh5678");
    await f.answer("deny");
    await held;
  });
});

describe("scripts", () => {
  const evaluate = (script: unknown) => ({ name: "agent_browser_eval", arguments: { script } });

  it("refuses a script that would act, and says which tools to use instead", async () => {
    const f = fixture();
    for (const [script, why] of [
      ["document.querySelector('#send').click()", "clicks or submits"],
      ["fetch('/api/send', { method: 'POST' })", "sends a network request"],
      ["document.querySelector('textarea').value = 'hi'", "writes into the page"],
      ["el.dispatchEvent(new Event('input'))", "dispatches an event"],
      ["location.href = '/checkout'", "navigates"],
    ] as const) {
      const result = await f.call(evaluate(script)) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(why);
      expect(text(result)).toContain("agent_browser_click");
    }
    expect(f.state.dispatched).toEqual([]);
    expect(f.state.reads).toEqual([]);
  });

  it("runs a script that only reads, and leaves a malformed call to the engine", async () => {
    const f = fixture();
    await expect(f.call(evaluate("document.title"))).resolves.toBe(CLICKED);
    await expect(f.call(evaluate(42))).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toHaveLength(2);
  });
});

describe("browserCallTimeoutMs", () => {
  it("covers the hold and a margin, inside the configured MCP call timeout, never below the old limit", () => {
    expect(browserCallTimeoutMs(9 * 60_000, 10 * 60_000)).toBe(570_000);
    expect(browserCallTimeoutMs(9 * 60_000, 5 * 60_000)).toBe(300_000);
    expect(browserCallTimeoutMs(9 * 60_000, 60_000)).toBe(130_000);
    expect(browserCallTimeoutMs(9 * 60_000, 60 * 60_000)).toBe(570_000);
  });
});
