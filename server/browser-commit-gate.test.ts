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
import type { PageBlind, PageDetail, PageEvidence, PageTarget } from "./browser-commit-page.ts";
import type { DecisionRow } from "./decision-log.ts";

const scratch: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

/** One scripted element: what the first read says of it, and what the
 * second would. The fixture answers each read with its own half. */
type Scripted = Omit<PageTarget, "also"> & Partial<PageEvidence> & { secrets?: boolean; also?: Scripted[] };
const element = (extra: Partial<Scripted> = {}): Scripted => ({
  label: "Show details", role: "button", box: null, submits: false, search: false, card: false, multiline: false,
  button: true, changes: false, typable: true, field: true, reach: true, link: false, signin: false, carries: false, lang: "", frames: false, payFrame: false, inPay: false, ...extra,
});
const evidenceOf = (target: Scripted): PageEvidence => ({
  opaque: target.opaque ?? false, fields: target.fields ?? [], others: target.others ?? 0, bound: target.bound ?? "", identity: target.identity ?? "", context: target.context ?? "", around: target.around ?? "",
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
    target: SEND as Scripted | PageBlind,
    url: "https://mail.example.com/compose?draft=1#body" as string | null,
    policy: options.policy as OutboundPolicy | undefined,
    active: true,
    reads: [] as Array<{ selector: string | null; enter: boolean }>,
    /** The second reads: the evidence for a card. */
    details: [] as Array<{ selector: string | null; enter: boolean }>,
    /** What the second read answers, when not what the first one saw. */
    evidence: undefined as PageDetail | PageBlind | undefined,
    /** The address the engine gives for a ref's own element, and each time it was asked. */
    href: null as string | null,
    hrefs: [] as string[],
    /** Throws to make one of the gate's own writes fail: "post", "patch", "log:card-shown"… */
    fail: undefined as ((step: string) => void) | undefined,
    /** Runs as each read of the page starts, with how many there have been. */
    onRead: undefined as ((count: number) => void) | undefined,
    dispatched: [] as unknown[],
    /** What the engine answers, when not the usual result. */
    result: undefined as unknown,
    /** Runs as each call reaches the engine: what the call does to the page. */
    onDispatch: undefined as ((sent: unknown) => void) | undefined,
    dropped: [] as string[],
    shots: 0,
    resumed: 0,
    /** How often the gate asked whether an earlier call of this browser is lost. */
    recovers: 0,
    /** A call was lost since the bot's last snapshot: the engine's refs may not be the ones it saw. */
    refsStale: false,
  };
  const gate = new BrowserCommitGate({
    runtime: {
      hold: runtime.hold.bind(runtime), releaseHold: runtime.releaseHold.bind(runtime), personReleased: runtime.personReleased.bind(runtime),
      withAgentAction: runtime.withAgentAction.bind(runtime), ref: (_session, ref) => refs.get(ref), refsStale: () => state.refsStale,
      interrupted: runtime.interrupted.bind(runtime),
    },
    requests, counts, holdMs: options.holdMs ?? 5_000, handBackMs: options.handBackMs ?? 1_000,
    policy: () => state.policy ?? null,
    post: ({ card }) => { state.fail?.("post"); const id = `card-${cards.size + 1}`; cards.set(id, card); return id; },
    patch: (_threadId, id, change) => { state.fail?.("patch"); const card = cards.get(id); if (card) cards.set(id, change(card)); },
    resume: () => { state.fail?.("resume"); state.resumed += 1; },
    log: (row) => { state.fail?.(`log:${row.decision}`); rows.push(row); },
    dropShot: (path) => { state.dropped.push(path); },
  });
  const abort = new AbortController();
  const call = (params: unknown, extra: Partial<CommitCall> = {}) => gate.guard({
    botId: "bot-1", botName: "Pepper", threadId: "thread-1", session: "s", params,
    page: {
      url: async () => state.url,
      target: async (selector, enter) => { state.reads.push({ selector, enter }); state.onRead?.(state.reads.length); return state.target as PageTarget | PageBlind; },
      href: async (selector) => { state.hrefs.push(selector); return state.href; },
      evidence: async (selector, enter) => {
        state.details.push({ selector, enter });
        if (state.evidence) return state.evidence;
        const target = state.target;
        return typeof target === "string" ? target : { parts: [target, ...(target.also ?? [])].map(evidenceOf), secrets: [target, ...(target.also ?? [])].some((each) => each.secrets === true) };
      },
    },
    shot: async () => { state.shots += 1; return "/data/attachments/shot.jpg"; },
    admit: () => {},
    recover: async () => { state.recovers += 1; return null; },
    active: () => state.active,
    signal: abort.signal,
    dispatch: async (sent) => { state.dispatched.push(sent); state.onDispatch?.(sent); return state.result ?? CLICKED; },
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
  it.each(["click", "typed"])("keeps the approved %s exclusive until dispatch settles", async (mode) => {
    const f = fixture();
    let finish!: () => void;
    const dispatching = new Promise<void>((resolve) => { finish = resolve; });
    let entered = false;
    let token: string | undefined;
    const params = mode === "click" ? click() : { name: "agent_browser_type", arguments: { selector: "#message", text: "Hello\n" } };
    const held = f.call(params, { dispatch: async (sent, holdId?: string) => {
      if ((sent as { name: string }).name === "agent_browser_type") return CLICKED;
      token = holdId;
      entered = true;
      await dispatching;
      return CLICKED;
    } });
    try {
      await f.answer("allow");
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(f.runtime.ownerKind("s")).toBe("hold");
      expect(token).toBeTruthy();
      await expect(f.runtime.withAgentAction("s", async () => "parallel fill")).rejects.toThrow(/approval/);
      await expect(f.runtime.withAgentAction("s", async () => "snapshot", "read")).resolves.toBe("snapshot");
    } finally {
      finish();
      await held;
    }
    expect(f.runtime.ownerKind("s")).toBeNull();
  });

  it("releases the approved hold when dispatch throws", async () => {
    const f = fixture();
    const held = f.call(click(), { dispatch: async (_sent, holdId?: string) => {
      expect(f.runtime.ownerKind("s")).toBe("hold");
      expect(holdId).toBeTruthy();
      throw new Error("engine refused the action");
    } });
    const observed = expect(held).rejects.toThrow("engine refused the action");
    await f.answer("allow");
    await observed;
    expect(f.runtime.ownerKind("s")).toBeNull();
  });

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
    ["a password's length", (f: ReturnType<typeof fixture>) => { f.state.target = { ...SEND, fields: [...SEND.fields!, { name: "Password", type: "password", length: 9 }] }; }],
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

  // The text around the button goes by the rules a value does. It cannot be
  // shown in part, so when anything in it would be masked it is left off the
  // card, and the page, which shows it, is not pictured.
  it("leaves the text around the button off the card and the log when it holds a credential, and takes no picture", async () => {
    const f = fixture();
    f.state.target = { ...BUY, context: "Use token=abcd1234efgh5678 to finish Buy now" };
    const held = f.call(click("#buy"));
    const card = await f.pending();
    expect(card.subtitle).toBe("mail.example.com · Buy now");
    expect(card.browserCommit).toMatchObject({ noShot: true });
    expect(card.browserCommit).not.toHaveProperty("context");
    expect(f.state.shots).toBe(0);
    expect(JSON.stringify([card, f.rows])).not.toMatch(/abcd1234efgh5678|token=/);
    // It is still part of what was approved.
    f.state.target = { ...BUY, context: "Use token=zzzz9999yyyy8888 to finish Buy now" };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(card.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
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

describe("a hold that fails part-way", () => {
  /** Whatever happened, the browser is free again and nothing is left waiting. */
  const free = (f: ReturnType<typeof fixture>) => {
    expect(f.runtime.ownerKind("s")).toBeNull();
    expect(f.requests.pending("thread-1")).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.state.dropped).toEqual(["/data/attachments/shot.jpg"]);
  };
  const broken = (step: string, times = 1) => {
    let left = times;
    return (at: string) => { if (at === step && left > 0) { left -= 1; throw new Error(`disk full at ${step}`); } };
  };

  // A hold that is never released refuses every action in that browser
  // until the server restarts.
  it("frees the browser when the card could not be posted", async () => {
    const f = fixture();
    f.state.fail = broken("post");
    await expect(f.call(click())).rejects.toThrow(/disk full at post/);
    free(f);
    expect(f.cards.size).toBe(0);
  });

  it("frees the browser and closes the card when the decision could not be logged", async () => {
    const f = fixture();
    f.state.fail = broken("log:card-shown");
    await expect(f.call(click())).rejects.toThrow(/disk full at log:card-shown/);
    free(f);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect([...f.cards.values()][0]!.browserCommit).not.toHaveProperty("shot");
    // The next call is not locked out.
    f.state.fail = undefined;
    f.state.target = element();
    await expect(f.call(click("#details"))).resolves.toBe(CLICKED);
  });

  it("frees the browser and closes the card when the bot could not be set working again after the answer", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.fail = broken("resume");
    await f.answer("allow");
    await expect(held).rejects.toThrow(/disk full at resume/);
    free(f);
    // Allow was given, nothing was sent: the card must not go on saying "Allowed".
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
  });

  it("frees the browser when the card could not be written back after the answer", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.fail = broken("patch", 5);
    await f.answer("deny");
    await expect(held).rejects.toThrow(/disk full at patch/);
    free(f);
  });

  it("frees the browser when the page read throws after Allow", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    f.state.fail = broken("log:auto-denied");
    f.state.target = "unreadable";
    await f.answer("allow");
    await expect(held).rejects.toThrow(/disk full at log:auto-denied/);
    free(f);
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

  // The text is typed without its line break, and the Enter is judged and
  // pressed as a step of its own (round five; it used to be refused).
  it("typed as a line break is held where it would commit, after the text is typed, and typed as it is where it would not", async () => {
    const f = fixture();
    const typed = { name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way\n" } };
    f.state.target = BOX;
    const held = f.call(typed);
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Enter in Write a message" } });
    expect(f.state.dispatched).toEqual([{ name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way" } }]);
    await f.answer("deny");
    expect(text(await held)).toMatch(/typed the text and did not press Enter/);
    expect(f.state.dispatched).toHaveLength(1);
    // Where it would not, the text and the Enter still go as two calls (round six), never as the one the bot wrote.
    f.state.target = element({ label: "Log in", box: "single", submits: true });
    expect((await f.call(typed) as { isError?: boolean }).isError).not.toBe(true);
    expect(f.state.dispatched.slice(1)).toEqual([{ name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way" } }, { name: "agent_browser_press", arguments: { key: "Enter" } }]);
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

describe("a frame the read cannot look into", () => {
  const press = (key: string) => ({ name: "agent_browser_press", arguments: { key } });

  // Enter in a payment frame's card field pays. The read cannot say what
  // Enter would do in there, so the press is refused; the page's button,
  // clicked by its ref, is judged.
  it.each(["Enter", "Return", "Control+Enter", "Enter+Shift", "Shift+Enter", "Enter+Meta"])("refuses %s while the focus is inside one, and says to click the button instead", async (key) => {
    const f = fixture();
    f.state.target = "framed";
    const result = await f.call(press(key)) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not press Enter: the focus is inside a frame it cannot read/);
    expect(text(result)).toMatch(/Click the button for this step instead, by its @ref/);
    expect(f.state.reads).toEqual([{ selector: null, enter: true }]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("refuses text typed with a line break when its selector is the frame itself", async () => {
    const f = fixture();
    f.state.target = "framed";
    const result = await f.call({ name: "agent_browser_type", arguments: { selector: "#pay-frame", text: "4242\n" } }) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(text(result)).toMatch(/click the button/i);
    expect(f.state.dispatched).toEqual([]);
  });

  it.each(["agent_browser_click", "agent_browser_check", "agent_browser_select"])("refuses %s aimed at the frame itself: it would land on something inside", async (name) => {
    const f = fixture();
    f.state.target = "framed";
    f.refs.set("e2", { role: "Iframe", name: "Secure payment" });
    for (const selector of ["#pay-frame", "@e2"]) {
      const result = await f.call({ name, arguments: { selector } }) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/would land inside a frame it cannot read/);
      expect(text(result)).toMatch(/@ref of the element inside the frame/);
    }
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  it("voids an approval when the focus has moved into one by the time of the answer", async () => {
    const f = fixture();
    f.state.target = element({ label: "Write a message", role: "textbox", box: "multiline", multiline: true });
    const held = f.call(press("Enter"));
    await f.pending();
    f.state.target = "framed";
    await f.answer("allow");
    expect(text(await held)).toMatch(/the focus is inside a frame it cannot read/);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
  });
});

describe("a ref the read may have matched to the wrong element", () => {
  // The engine measures an element inside a frame from the frame's own
  // corner, so its box can be the box of something else on the page outside
  // (measured: a card field in a frame and an Email field, both at 8,8).
  const EMAIL = element({ label: "Email", role: "textbox", box: "single", frames: true });

  it("holds a click the snapshot names a commitment, whatever the element read in that box is", async () => {
    const f = fixture();
    f.state.target = EMAIL;
    f.refs.set("e6", { role: "button", name: "Pay" });
    const held = f.call(click("@e6"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { class: "money", label: "Pay" } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("still lets a click through when neither the element read nor the snapshot's name is a commitment", async () => {
    const f = fixture();
    f.state.target = EMAIL;
    f.refs.set("e4", { role: "textbox", name: "Card number" });
    f.refs.set("e7", { role: "tab", name: "Send money" });
    await expect(f.call(click("@e4"))).resolves.toBe(CLICKED);
    await expect(f.call(click("@e7"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });

  const typed = (selector: string) => ({ name: "agent_browser_type", arguments: { selector, text: "4242\n" } });

  it("refuses text typed with a line break when the page has a frame and the snapshot's name is not the element's", async () => {
    const f = fixture();
    f.state.target = EMAIL;
    f.refs.set("e4", { role: "textbox", name: "Card number" });
    const result = await f.call(typed("@e4")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([]);
    // A ref the last snapshot never listed cannot be checked at all.
    expect((await f.call(typed("@e99")) as { isError: boolean }).isError).toBe(true);
    expect(f.state.dispatched).toEqual([]);
  });

  it("types it when the name is the element's own, or the page has no frame, or the selector is no ref", async () => {
    const f = fixture();
    f.state.target = EMAIL;
    f.refs.set("e1", { role: "textbox", name: " email " });
    const ran = async (selector: string) => {
      f.state.dispatched.length = 0;
      expect((await f.call(typed(selector)) as { isError?: boolean }).isError, selector).not.toBe(true);
      // The text, then the Enter as a call of its own.
      expect(f.state.dispatched).toEqual([{ name: "agent_browser_type", arguments: { selector, text: "4242" } }, { name: "agent_browser_press", arguments: { key: "Enter" } }]);
    };
    await ran("@e1");
    await ran("#before");
    f.state.target = { ...EMAIL, frames: false };
    f.refs.set("e4", { role: "textbox", name: "Card number" });
    await ran("@e4");
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
    // The site and the class, and nothing of what was sent: on a shared
    // browser the bot reloading may not be the bot that sent it.
    expect(card).toMatchObject({
      title: "Spend money?", tool: "agent_browser_reload",
      subtitle: "shop.example.com · Reload, which can repeat an earlier payment",
      browserCommit: { class: "money", host: "shop.example.com", label: "Reload, which can repeat an earlier payment", fields: [] },
    });
    expect(card.browserCommit).not.toHaveProperty("shot");
    expect(card.browserCommit).not.toHaveProperty("more");
    expect(JSON.stringify(card)).not.toContain("Card number");
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

  // The page's own "back" link, or its script, can bring the posted page to
  // the front again after the bot opened another address (measured: a second
  // order). Nothing the gate sees says a reload is safe again.
  it("goes on holding after the bot has opened another address, and never reads the page for it", async () => {
    const f = fixture();
    await sent(f);
    const reads = f.state.reads.length;
    await expect(f.call(open("https://mail.example.com/inbox"))).resolves.toBe(CLICKED);
    f.state.url = "https://mail.example.com/inbox";
    const held = f.call(reload);
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", subtitle: "mail.example.com · Reload, which can repeat an earlier send" });
    await f.answer("deny");
    await held;
    expect(f.state.reads).toHaveLength(reads);
    expect(f.state.dispatched).toEqual([click(), open("https://mail.example.com/inbox")]);
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
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { label: "Reload, which can repeat an earlier payment", fields: [] } });
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

  it("masks a card number written inside a value, and leaves text around the button that holds one off the card with no picture", async () => {
    const f = fixture();
    f.state.target = { ...SEND, context: "Paying with 4242 4242 4242 4242 Send", fields: [
      { name: "Message", type: "textarea", value: "Charge my card 5555-5555-5555-4444 please, order 1234567890123456" },
    ] };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).toBe("mail.example.com · Send\nMessage: Charge my card «card number» please, order 1234567890123456");
    expect(card.browserCommit).toMatchObject({ noShot: true });
    expect(f.state.shots).toBe(0);
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

describe("round three: text typed with a line break", () => {
  const typed = (selector: string, value = "On my way\n") => ({ name: "agent_browser_type", arguments: { selector, text: value } });
  const NOTE = element({ label: "Quick note", role: "textbox", box: "single" });

  // The engine types at whatever has the focus when its selector's element
  // cannot take it (agent-browser 0.37.0: typed at a paragraph or an image,
  // the Enter submitted the form the focus was in).
  it.each([
    ["a paragraph", element({ label: "Read this first", role: "generic", button: false, typable: false, field: false, reach: false })],
    ["a button", element({ label: "Help", typable: false, field: false, reach: false })],
    ["a field that cannot take the focus", { ...NOTE, typable: false, reach: false }],
    ["two elements in one box, one of them no text field", { ...NOTE, also: [element({ label: "Wrapper", role: "generic", button: false, typable: false, field: false, reach: false })] }],
  ])("refuses it at %s, whatever that would otherwise be", async (_what, target) => {
    const f = fixture();
    f.state.target = target;
    const result = await f.call(typed("#target")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill, then press Enter or click the button/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });

  // A selector the engine cannot resolve is typed at the focus all the same.
  it.each(["text=Send", "placeholder=Search", "label=Message", "role=textbox", "@e99", "#nothing-here"])("refuses it at %s when the read finds no such element", async (selector) => {
    const f = fixture();
    f.state.target = "missing";
    const result = await f.call(typed(selector)) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([]);
  });

  it("types it into a text field that will itself take it, when Enter there is no commitment", async () => {
    const f = fixture();
    f.state.target = NOTE;
    expect((await f.call(typed("#note")) as { isError?: boolean }).isError).not.toBe(true);
    expect(f.state.dispatched).toEqual([typed("#note", "On my way"), { name: "agent_browser_press", arguments: { key: "Enter" } }]);
    const reads = f.state.reads.length;
    // The same call with no line break is never read at all.
    f.state.target = "missing";
    await expect(f.call(typed("text=Send", "On my way"))).resolves.toBe(CLICKED);
    expect(f.state.reads).toHaveLength(reads);
  });

  // Round five: the text is typed without its line break, and the Enter is
  // then judged and pressed as a step of its own. It used to be refused.
  it("types the text where Enter would commit, and holds the Enter on a card", async () => {
    const f = fixture();
    f.state.target = element({ label: "Write a message", role: "textbox", box: "multiline", multiline: true });
    const held = f.call(typed("#composer"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Enter in Write a message" } });
    expect(f.state.dispatched).toEqual([typed("#composer", "On my way")]);
    await f.answer("deny");
    await held;
  });
});

describe("round three: a card region", () => {
  const press = (key: string) => ({ name: "agent_browser_press", arguments: { key } });
  const CONTINUE = element({ label: "Continue", card: true, fields: [{ name: "Card number", type: "card", length: 16 }] });

  it("holds a button there as money whatever it says and whatever it submits", async () => {
    const f = fixture();
    f.state.target = CONTINUE;
    const held = f.call(click("#next"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { class: "money", label: "Continue" } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it.each(["Enter", "Space", " ", "Shift+Space"])("holds %s on a focused button there as money", async (key) => {
    const f = fixture();
    f.state.target = CONTINUE;
    const held = f.call(press(key));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { class: "money" } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("holds a list or a tick box with a change handler there, and lets one with none through", async () => {
    const f = fixture();
    const select = { name: "agent_browser_select", arguments: { selector: "#plan", value: "yearly" } };
    f.state.target = element({ label: "Plan", role: "combobox", button: false, card: true, changes: true });
    const held = f.call(select);
    expect(await f.pending()).toMatchObject({ title: "Spend money?" });
    await f.answer("deny");
    await held;
    f.state.target = element({ label: "Plan", role: "combobox", button: false, card: true });
    await expect(f.call(select)).resolves.toBe(CLICKED);
  });

  it("lets a click on something there that is no control through", async () => {
    const f = fixture();
    f.state.target = element({ label: "Your card is charged when the order ships.", role: "generic", button: false, card: true });
    await expect(f.call(click("#note"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });
});

describe("round three: Space", () => {
  const press = (key: string) => ({ name: "agent_browser_press", arguments: { key } });

  // Space on a focused button clicks it (agent-browser 0.37.0, under each of these names).
  it.each(["Space", "space", "SPACE", " ", "Shift+Space", "Space+Shift", "Control+ ", "Alt+Space"])("judges %j as an activation of the focused element", async (key) => {
    const f = fixture();
    const held = f.call(press(key));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", tool: "agent_browser_press", browserCommit: { class: "send", label: "Send" } });
    // The focus is read as a click there is, not as Enter.
    expect(f.state.reads).toEqual([{ selector: null, enter: false }]);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toEqual([press(key)]);
  });

  it("lets it through where it activates nothing that commits", async () => {
    const f = fixture();
    f.state.target = element();
    await expect(f.call(press("Space"))).resolves.toBe(CLICKED);
    // In a message box it is a character.
    f.state.target = element({ label: "Write a message", role: "textbox", box: "multiline", multiline: true, button: false });
    await expect(f.call(press("Space"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });

  it.each([
    ["a frame it cannot read", "framed" as const, /did not press Space: the focus is inside a frame it cannot read/],
    ["a closed part of the page", "sealed" as const, /did not press Space: the focus is inside a closed part of the page it cannot read/],
  ])("refuses it with the focus inside %s", async (_what, blind, message) => {
    const f = fixture();
    f.state.target = blind;
    const result = await f.call(press("Space")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(text(result)).toMatch(/Click the button for this step instead, by its @ref/);
    expect(f.state.dispatched).toEqual([]);
  });

  it("voids the approval when the focus has moved by the time of the answer", async () => {
    const f = fixture();
    const held = f.call(press("Space"));
    const first = await f.pending();
    f.state.target = { ...SEND, identity: "html:0/body:1/form:0/button:1#cccccccccccccccc" };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });
});

describe("round three: a closed part of the page", () => {
  it.each(["Enter", "Return", "Shift+Enter", "Control+Enter"])("refuses %s with the focus inside it, and says to click the button instead", async (key) => {
    const f = fixture();
    f.state.target = "sealed";
    const result = await f.call({ name: "agent_browser_press", arguments: { key } }) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not press Enter: the focus is inside a closed part of the page it cannot read/);
    expect(text(result)).toMatch(/Click the button for this step instead, by its @ref/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });
});

describe("round three: a click inside a payment frame the read cannot look into", () => {
  it("holds a button there as money, whatever the snapshot calls it", async () => {
    const f = fixture();
    f.state.target = "hidden-pay";
    f.refs.set("e9", { role: "button", name: "Continue" });
    const held = f.call(click("@e9"));
    const card = await f.pending();
    expect(card).toMatchObject({ title: "Spend money?", browserCommit: { class: "money", label: "Continue", noShot: true } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("lets a click into a field there through, and refuses one the snapshot never named", async () => {
    const f = fixture();
    f.state.target = "hidden-pay";
    f.refs.set("e4", { role: "textbox", name: "Card number" });
    await expect(f.call(click("@e4"))).resolves.toBe(CLICKED);
    const result = await f.call(click("@e31")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(f.state.dispatched).toHaveLength(1);
  });

  it("judges a button in a frame that is no payment frame by its name, as before", async () => {
    const f = fixture();
    f.state.target = "hidden";
    f.refs.set("e9", { role: "button", name: "Continue" });
    await expect(f.call(click("@e9"))).resolves.toBe(CLICKED);
  });

  // The engine measures an element inside a frame from the frame's own
  // corner, so the element read in its box may be another one, out here.
  it("holds a button the read matched to something else on a page with a payment frame", async () => {
    const f = fixture();
    const EMAIL = element({ label: "Email", role: "textbox", box: "single", button: false, frames: true, payFrame: true, inPay: true });
    f.state.target = EMAIL;
    f.refs.set("e9", { role: "button", name: "Continue" });
    const held = f.call(click("@e9"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { label: "Continue" } });
    await f.answer("deny");
    await held;
    // When the names agree the element read is the one, and it is judged as it was read.
    f.state.target = element({ label: "Continue", frames: true, payFrame: true, inPay: true });
    await expect(f.call(click("@e9"))).resolves.toBe(CLICKED);
    // On a page with no payment frame a name that differs says nothing by itself.
    f.state.target = { ...EMAIL, payFrame: false, inPay: false };
    await expect(f.call(click("@e9"))).resolves.toBe(CLICKED);
  });

  // Round four. A shop page with a payment brand's message in a frame is
  // still a shop page: the box is nowhere near the frame's own size, so
  // the ref cannot be inside it, and a name that differs says nothing.
  it("judges a button by its name when its box could not be inside the payment frame", async () => {
    const f = fixture();
    f.state.target = element({ label: "", role: "button", frames: true, payFrame: true, inPay: false });
    f.refs.set("e9", { role: "button", name: "Add to cart" });
    await expect(f.call(click("@e9"))).resolves.toBe(CLICKED);
    f.refs.set("e10", { role: "button", name: "Pay now" });
    const held = f.call(click("@e10"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", browserCommit: { label: "Pay now" } });
    await f.answer("deny");
    await held;
  });
});

describe("round three: what is read, and when", () => {
  it("reads nothing more of the page for a click that is no commitment", async () => {
    const f = fixture();
    f.state.target = element();
    await expect(f.call(click("#details"))).resolves.toBe(CLICKED);
    expect(f.state.reads).toHaveLength(1);
    expect(f.state.details).toEqual([]);
  });

  it("reads the evidence once for the card and once more after the answer", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    expect(f.state.details).toEqual([{ selector: "@e4", enter: false }]);
    await f.answer("allow");
    await held;
    expect(f.state.details).toHaveLength(2);
    expect(f.state.reads).toHaveLength(2);
  });

  it("clicks nothing when the evidence cannot be read, or is not about the elements that were judged", async () => {
    for (const evidence of ["unreadable" as const, { parts: [], secrets: false }]) {
      const f = fixture();
      f.state.evidence = evidence;
      const result = await f.call(click()) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/could not read the page to check it first/);
      expect(f.state.dispatched).toEqual([]);
      expect(f.cards.size).toBe(0);
    }
  });
});

describe("round three: what the approval covers beyond what the card lists", () => {
  it.each([
    ["a control the card does not list", { bound: "bbbbbbbbbbbbbbbb" }],
    ["the text around the button, when the card could not carry it", { around: "cccccccccccccccc" }],
    ["how many other filled fields the page has", { others: 4 }],
  ])("is void when %s changed", async (_what, change) => {
    const f = fixture();
    f.state.target = { ...SEND, bound: "aaaaaaaaaaaaaaaa", around: "aaaaaaaaaaaaaaaa", others: 3 };
    const held = f.call(click());
    const first = await f.pending();
    f.state.target = { ...f.state.target, ...change };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("says how many filled fields elsewhere on the page it covers, and lists none of them", async () => {
    const f = fixture();
    f.state.target = { ...SEND, fields: [], others: 3 };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).toBe("mail.example.com · Send\n3 other filled fields on this page are covered by this approval, not listed");
    expect(card.browserCommit).toMatchObject({ fields: [], others: 3 });
    await f.answer("deny");
    await held;
    const one = fixture();
    one.state.target = { ...SEND, others: 1 };
    const waiting = one.call(click());
    expect((await one.pending()).subtitle).toBe("mail.example.com · Send\nMessage: Hello there\n1 other filled field on this page is covered by this approval, not listed");
    await one.answer("deny");
    await waiting;
  });

  it("does not void an approval because a relative time or a clock around the button moved on", async () => {
    const f = fixture();
    f.state.target = { ...SEND, context: "Invoice 7 · updated 3s ago · 12:04 Send" };
    const held = f.call(click());
    await f.pending();
    f.state.target = { ...SEND, context: "Invoice 7 · updated 1m ago · 12:05 Send" };
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
  });

  it("still voids it when a number that is no time changed: a price is part of what was approved", async () => {
    const f = fixture();
    f.state.target = { ...SEND, context: "Laptop $10.00 Send" };
    const held = f.call(click());
    const first = await f.pending();
    f.state.target = { ...SEND, context: "Laptop $99.00 Send" };
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(first.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });
});

describe("round three: a page that keeps changing under an approval", () => {
  const AT = "html:0/body:1/div:0/button:0";
  const shifting = (turn: number, extra: Partial<Parameters<typeof element>[0]> = {}) => ({
    ...SEND, identity: `${AT}#${String(turn).padStart(16, "0")}`, context: `Row ${["alpha", "bravo", "charlie", "delta", "echo"][turn]} Send`, around: `around-${turn}`, ...extra,
  });

  it("says so on the third card, and binds that one to the element's place, its label and the fields only", async () => {
    const f = fixture();
    f.state.target = shifting(0);
    const held = f.call(click());
    const first = await f.pending();
    expect(first.browserCommit).not.toHaveProperty("changing");
    f.state.target = shifting(1);
    await f.answer("allow");
    const second = await f.pending();
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.browserCommit).not.toHaveProperty("changing");
    f.state.target = shifting(2);
    await f.answer("allow");
    const third = await f.pending();
    expect(third.requestId).not.toBe(second.requestId);
    expect(third.browserCommit).toMatchObject({ changing: true });
    expect(third.subtitle).toMatch(/keeps changing/);
    expect(f.state.dispatched).toEqual([]);
    // The page changes again in the same way: this approval holds.
    f.state.target = shifting(3);
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toHaveLength(1);
    expect([...f.cards.values()].map((card) => card.answered)).toEqual(["unavailable", "unavailable", "allow"]);
  });

  it.each([
    ["a field", { fields: [{ name: "Message", type: "textarea", value: "Something else" }] }],
    ["a control the card does not list", { bound: "bbbbbbbbbbbbbbbb" }],
    ["the label", { label: "Send to all" }],
    ["how many filled fields the page has", { others: 2 }],
  ])("still voids that third approval when %s changed", async (_what, change) => {
    const f = fixture();
    f.state.target = shifting(0);
    const held = f.call(click());
    await f.pending();
    f.state.target = shifting(1);
    await f.answer("allow");
    await vi.waitFor(() => expect(f.cards.size).toBe(2));
    f.state.target = shifting(2);
    await f.answer("allow");
    await vi.waitFor(() => expect(f.cards.size).toBe(3));
    const third = await f.pending();
    f.state.target = shifting(3, change);
    await f.answer("allow");
    expect((await f.pending()).requestId).not.toBe(third.requestId);
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });
});

describe("tuning: ordinary browsing", () => {
  const press = (key: string) => ({ name: "agent_browser_press", arguments: { key } });
  const typed = (selector: string, value: string) => ({ name: "agent_browser_type", arguments: { selector, text: value } });
  const LINK = element({ label: "Share prices", role: "link", link: true });
  const NOTES = element({ label: "Notes", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: false, says: "Notes", near: [] });
  const COMPOSER = element({ label: "Message #general", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: true, says: "Message #general", near: ["Send"] });

  it("lets a plain link through whatever it says, by ref: the snapshot names the same element", async () => {
    const f = fixture();
    f.state.target = LINK;
    f.refs.set("e5", { role: "link", name: "Share prices" });
    await expect(f.call(click("@e5"))).resolves.toBe(CLICKED);
    // The browser's name for it need not be the one this read gives. On a
    // page with no frame, one element in that box is the element.
    f.refs.set("e6", { role: "link", name: "Share prices, opens in a new tab" });
    await expect(f.call(click("@e6"))).resolves.toBe(CLICKED);
    await expect(f.call(click("#by-css"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    expect(f.state.details).toEqual([]);
  });

  it.each([
    ["the snapshot calls the ref a button", LINK, { role: "button", name: "Share" }],
    ["the page has a frame the ref could be in, and the snapshot names something else", { ...LINK, label: "Home", frames: true }, { role: "link", name: "Send" }],
    ["two elements share the box, and the snapshot names neither", { ...LINK, label: "Home", also: [element({ label: "Wrapper", role: "generic", button: false })] }, { role: "link", name: "Send" }],
  ])("still holds a click by ref when %s", async (_what, target, ref) => {
    const f = fixture();
    f.state.target = target;
    f.refs.set("e7", ref);
    const held = f.call(click("@e7"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("holds a link inside a card region as money, plain or not", async () => {
    const f = fixture();
    f.state.target = { ...LINK, label: "Terms", card: true };
    f.refs.set("e5", { role: "link", name: "Terms" });
    const held = f.call(click("@e5"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?" });
    await f.answer("deny");
    await held;
  });

  it("lets a sign-in's button through by ref, whatever it says", async () => {
    const f = fixture();
    f.state.target = element({ label: "Submit", submits: true, signin: true });
    f.refs.set("e3", { role: "button", name: "Submit" });
    await expect(f.call(click("@e3"))).resolves.toBe(CLICKED);
    await expect(f.call(press("Enter"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });

  it("lets Apply through on a filter, and holds it where something is attached", async () => {
    const f = fixture();
    f.state.target = element({ label: "Apply", submits: true });
    f.refs.set("e3", { role: "button", name: "Apply" });
    await expect(f.call(click("@e3"))).resolves.toBe(CLICKED);
    f.state.target = element({ label: "Apply", submits: true, carries: true });
    const held = f.call(click("@e3"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Apply" } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toHaveLength(1);
  });

  it("lets a harmless label through on a form with a multi-line field, by ref", async () => {
    const f = fixture();
    f.state.target = element({ label: "Save changes", submits: true, multiline: true, carries: true });
    f.refs.set("e3", { role: "button", name: "Save changes" });
    await expect(f.call(click("@e3"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
  });

  it("presses Enter in a notes box, and holds it in a composer", async () => {
    const f = fixture();
    f.state.target = NOTES;
    await expect(f.call(press("Enter"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    f.state.target = COMPOSER;
    const held = f.call(press("Enter"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Enter in Message #general" } });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([press("Enter")]);
  });

  it.each(["Control+Enter", "Enter+Meta", "Alt+Enter"])("holds %s in a notes box: with another key held it is never a new line", async (key) => {
    const f = fixture();
    f.state.target = NOTES;
    const held = f.call(press(key));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("types text with line breaks into a notes box, however many", async () => {
    const f = fixture();
    f.state.target = NOTES;
    const ENTER = { name: "agent_browser_press", arguments: { key: "Enter" } };
    // Each line as text, each line break as an Enter of its own (round six): never text and Enter in one call.
    for (const [value, steps] of [
      ["Bring the charger\n", [typed("#notes", "Bring the charger"), ENTER]],
      ["Bring the charger\nand the cable", [typed("#notes", "Bring the charger"), ENTER, typed("#notes", "and the cable")]],
      ["one\ntwo\nthree\n", [typed("#notes", "one"), ENTER, typed("#notes", "two"), ENTER, typed("#notes", "three"), ENTER]],
      // A carriage return with a line feed is one line break; two line breaks running are two.
      ["one\r\ntwo", [typed("#notes", "one"), ENTER, typed("#notes", "two")]],
      ["one\n\ntwo\r", [typed("#notes", "one"), ENTER, ENTER, typed("#notes", "two"), ENTER]],
    ] as const) {
      f.state.dispatched.length = 0;
      expect((await f.call(typed("#notes", value)) as { isError?: boolean }).isError, value).not.toBe(true);
      expect(f.state.dispatched, value).toEqual(steps);
    }
    expect(f.cards.size).toBe(0);
  });

  it.each([
    ["a composer", COMPOSER, "On my way\nsee you\n", /agent_browser_fill, then press Enter or click the button/],
    ["a one-line field, where the first Enter may move on", element({ label: "Log in", box: "single", submits: true }), "ada\nlovelace\n", /agent_browser_fill/],
    ["a notes box, after a tab", NOTES, "one\ttwo\nthree", /agent_browser_fill/],
    ["a notes box the read could not match to the selector", { ...NOTES, typable: false }, "one\ntwo", /agent_browser_fill/],
  ])("refuses several lines typed into %s", async (_what, target, value, message) => {
    const f = fixture();
    f.state.target = target;
    const result = await f.call(typed("#box", value)) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(message);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
  });
});

describe("round four: what the third card is bound to", () => {
  // A list that keeps gaining rows above the button moves it down the page
  // every time: its place is never the same twice, and nothing else changes.
  const AT = (row: number) => `html:0/body:1/ul:0/li:${row}/button:0#aaaaaaaaaaaaaaaa`;

  it("is not the element's place: a list that gains rows above the button can be approved", async () => {
    const f = fixture();
    f.state.target = { ...SEND, identity: AT(0) };
    const held = f.call(click());
    await f.pending();
    f.state.target = { ...SEND, identity: AT(1) };
    await f.answer("allow");
    await vi.waitFor(() => expect(f.cards.size).toBe(2));
    f.state.target = { ...SEND, identity: AT(2) };
    await f.answer("allow");
    await vi.waitFor(() => expect(f.cards.size).toBe(3));
    expect((await f.pending()).browserCommit).toMatchObject({ changing: true });
    f.state.target = { ...SEND, identity: AT(3) };
    await f.answer("allow");
    await expect(held).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toHaveLength(1);
  });
});

describe("round five: text ending in a line break, typed at a field that was not clicked first", () => {
  const typed = (selector: string, value: string) => ({ name: "agent_browser_type", arguments: { selector, text: value } });
  const ENTER = { name: "agent_browser_press", arguments: { key: "Enter" } };
  const SEARCH = element({ label: "Search", role: "searchbox", box: "search", search: true, button: false, typable: false });
  const COMPOSER = element({ label: "Message #general", role: "textbox", box: "multiline", multiline: true, button: false, typable: false, hint: false, only: true, says: "Message #general", near: ["Send"] });
  /** The engine gives a field the focus as it types there. */
  const takesFocus = (f: ReturnType<typeof fixture>) => {
    f.state.onDispatch = (sent) => {
      if ((sent as { name: string }).name === "agent_browser_type" && typeof f.state.target !== "string") f.state.target = { ...f.state.target, typable: true };
    };
  };

  it("types the text without the line break, sees the field took the focus, and presses Enter as a step of its own", async () => {
    const f = fixture();
    f.state.target = SEARCH;
    takesFocus(f);
    const result = await f.call(typed("#q", "lamps\n")) as { isError?: boolean };
    expect(result.isError).not.toBe(true);
    // The text once, without its line break, then the key. Never the call as the bot wrote it.
    expect(f.state.dispatched).toEqual([typed("#q", "lamps"), ENTER]);
    expect(f.cards.size).toBe(0);
    // Read as typed text first, then where the focus is, then as an Enter press at the focus.
    expect(f.state.reads).toEqual([{ selector: "#q", enter: true }, { selector: "#q", enter: true }, { selector: null, enter: true }]);
  });

  it("holds the Enter on a card where it would send: the text is typed once, and nothing is pressed before the answer", async () => {
    const f = fixture();
    f.state.target = { ...COMPOSER, fields: [{ name: "Message #general", type: "contenteditable", value: "On my way" }] };
    takesFocus(f);
    const held = f.call(typed("#chat", "On my way\n"));
    const card = await f.pending();
    expect(card).toMatchObject({ title: "Send on your behalf?", subtitle: "mail.example.com · Enter in Message #general\nMessage #general: On my way" });
    expect(f.state.dispatched).toEqual([typed("#chat", "On my way")]);
    await f.answer("allow");
    await held;
    expect(f.state.dispatched).toEqual([typed("#chat", "On my way"), ENTER]);
  });

  it("tells the bot the text is in the field when the Enter is declined", async () => {
    const f = fixture();
    f.state.target = COMPOSER;
    takesFocus(f);
    const held = f.call(typed("#chat", "On my way\n"));
    await f.pending();
    await f.answer("deny");
    const result = await held as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^OpenMausBot typed the text and did not press Enter/);
    expect(text(result)).toMatch(/the user declined/);
    expect(f.state.dispatched).toEqual([typed("#chat", "On my way")]);
  });

  it("does not press Enter when the field did not take the focus, and says the text was typed", async () => {
    const f = fixture();
    f.state.target = SEARCH;
    const result = await f.call(typed("#q", "lamps\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/typed the text, but the field did not take the focus/);
    expect(text(result)).toMatch(/did not press Enter/);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps")]);
    expect(f.cards.size).toBe(0);
  });

  it.each([
    ["the selector no longer resolves", "missing" as const],
    ["the page cannot be read", "unreadable" as const],
    ["another element now shares its box", { ...SEARCH, typable: true, also: [element()] }],
  ])("does not press Enter when, after the text, %s", async (_what, after) => {
    const f = fixture();
    f.state.target = SEARCH;
    f.state.onDispatch = () => { f.state.target = after; };
    const result = await f.call(typed("#q", "lamps\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not press Enter/);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps")]);
  });

  // Measured: text typed at a field in a disabled group, under an inert
  // parent, hidden, or behind a modal goes into whatever field has the focus.
  it("types nothing at a field the read says cannot take the focus", async () => {
    const f = fixture();
    f.state.target = { ...SEARCH, reach: false };
    const result = await f.call(typed("#q", "lamps\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/cannot take the focus/);
    expect(text(result)).toMatch(/Nothing was typed/);
    expect(f.state.dispatched).toEqual([]);
  });

  it("types nothing when the text step itself fails, and passes the engine's answer on", async () => {
    const f = fixture();
    f.state.target = SEARCH;
    f.state.result = { isError: true, content: [{ type: "text", text: "Element is not editable" }] };
    const result = await f.call(typed("#q", "lamps\n"));
    expect(text(result)).toBe("Element is not editable");
    expect(f.state.dispatched).toEqual([typed("#q", "lamps")]);
  });

  it("still refuses what it refused before: no text field, a line break alone, several lines, a tab", async () => {
    const f = fixture();
    for (const [target, value, message] of [
      [element({ label: "Help", typable: false, field: false, reach: false }), "x\n", /Click the field first and then type/],
      ["missing" as const, "x\n", /Click the field first and then type/],
      [SEARCH, "\n", /Click the field first and then type/],
      [{ ...COMPOSER, only: false }, "one\ntwo\n", /Click the field first and then type/],
      [SEARCH, "a\tb\n", /a tab moves the focus/],
    ] as const) {
      f.state.target = target;
      const result = await f.call(typed("#q", value)) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(message);
    }
    expect(f.state.dispatched).toEqual([]);
  });

  // Round six. What Enter does at a field can change once the text is in:
  // a "Pay now" button that is disabled until its field has text. So the
  // text and its Enter never go to the engine in one call, focus or not.
  it("types the text and presses Enter as two calls when the field already has the focus and Enter there commits nothing", async () => {
    const f = fixture();
    f.state.target = { ...SEARCH, typable: true };
    expect((await f.call(typed("#q", "lamps\n")) as { isError?: boolean }).isError).not.toBe(true);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps"), ENTER]);
  });

  it.each([
    ["money", "Spend money?", element({ label: "Pay now", box: "single", submits: true })],
    ["a send", "Send on your behalf?", element({ label: "Send", box: "single", submits: true })],
  ])("judges the Enter after the text is in: a focused field whose button is disabled until then is held as %s", async (_what, title, after) => {
    const f = fixture();
    // Before the text: a field whose form has no button that works, so Enter there commits nothing.
    f.state.target = element({ label: "Amount", role: "textbox", box: "single", submits: true, button: false });
    f.state.onDispatch = (sent) => { if ((sent as { name: string }).name === "agent_browser_type") f.state.target = after; };
    const held = f.call(typed("#amount", "hello\n"));
    expect(await f.pending()).toMatchObject({ title });
    expect(f.state.dispatched).toEqual([typed("#amount", "hello")]);
    await f.answer("allow");
    await held;
    expect(f.state.dispatched).toEqual([typed("#amount", "hello"), ENTER]);
  });

  it.each(["lamps\r", "lamps\r\n"])("takes %j for the text and one line break", async (value) => {
    const f = fixture();
    f.state.target = { ...SEARCH, typable: true };
    expect((await f.call(typed("#q", value)) as { isError?: boolean }).isError).not.toBe(true);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps"), ENTER]);
  });

  it("stops several lines at the first Enter that would commit, and says how far it got", async () => {
    const f = fixture();
    const NOTES = element({ label: "Notes", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: false, says: "Notes", near: [] });
    f.state.target = NOTES;
    // Once the first line is in, the page shows its Send button: the box is a composer after all.
    f.state.onDispatch = (sent) => { if ((sent as { name: string }).name === "agent_browser_type") f.state.target = { ...NOTES, only: true, near: ["Send"] }; };
    const result = await f.call(typed("#notes", "one\ntwo\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/typed the text up to a line break and stopped/);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([typed("#notes", "one")]);
    expect(f.cards.size).toBe(0);
  });

  it("stops several lines when the field loses the focus part-way", async () => {
    const f = fixture();
    const NOTES = element({ label: "Notes", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: false, says: "Notes", near: [] });
    f.state.target = NOTES;
    let typedCalls = 0;
    f.state.onDispatch = (sent) => { if ((sent as { name: string }).name === "agent_browser_type" && (typedCalls += 1) === 2) f.state.target = { ...NOTES, typable: false }; };
    const result = await f.call(typed("#notes", "one\ntwo\nthree")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/did not press Enter/);
    expect(f.state.dispatched).toEqual([typed("#notes", "one"), ENTER, typed("#notes", "two")]);
  });

  // Round seven: a refusal that says what is the matter. This field has the focus.
  it("says several lines do not go into a one-line field, not that the field lacks the focus", async () => {
    const f = fixture();
    f.state.target = { ...SEARCH, typable: true };
    const result = await f.call(typed("#q", "lamps\nand shades\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/several line breaks/);
    expect(text(result)).toMatch(/one-line field/);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(text(result)).not.toMatch(/does not have the focus/);
    expect(f.state.dispatched).toEqual([]);
    // A field that does not have it is still told so.
    f.state.target = SEARCH;
    expect(text(await f.call(typed("#q", "lamps\nand shades\n")))).toMatch(/does not have the focus/);
  });

  it("refuses text with more line breaks than it will press one by one", async () => {
    const f = fixture();
    f.state.target = element({ label: "Notes", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: false, says: "Notes", near: [] });
    const result = await f.call(typed("#notes", "line\n".repeat(51))) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/more than 50 line breaks/);
    expect(text(result)).toMatch(/agent_browser_fill/);
    expect(f.state.dispatched).toEqual([]);
    expect(f.state.reads).toEqual([]);
    // Fifty is the most it does.
    expect((await f.call(typed("#notes", "line\n".repeat(50))) as { isError?: boolean }).isError).not.toBe(true);
    expect(f.state.dispatched).toHaveLength(100);
  });

  it("presses a line break alone as Enter, held, at a composer that already has the focus", async () => {
    const f = fixture();
    f.state.target = { ...COMPOSER, typable: true };
    const held = f.call(typed("#chat", "\n"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    expect(f.state.dispatched).toEqual([]);
    await f.answer("allow");
    await held;
    expect(f.state.dispatched).toEqual([ENTER]);
  });
});

describe("round four: a link by ref, on the engine's own word", () => {
  const HEADLINE = "How to share and post your first message with the new publishing tools";
  /** What the read found in the ref's box: a plain link, under a name that is not the snapshot's. */
  const LINK = element({ label: "Read more", role: "link", link: true, frames: true });

  it("passes a ref the snapshot calls a link when the engine says its address goes to another page", async () => {
    const f = fixture();
    f.state.target = LINK;
    f.state.href = "/story?id=7";
    f.refs.set("e5", { role: "link", name: HEADLINE });
    await expect(f.call(click("@e5"))).resolves.toBe(CLICKED);
    expect(f.state.hrefs).toEqual(["@e5"]);
    expect(f.cards.size).toBe(0);
  });

  it.each([
    ["a bare #", "#"],
    ["a place on the page, which only the page can vouch for", "#comments"],
    ["javascript:", "javascript:void(0)"],
    ["nothing", ""],
    ["no address at all", null],
  ])("still holds it when the engine says its address is %s", async (_what, href) => {
    const f = fixture();
    f.state.target = LINK;
    f.state.href = href;
    f.refs.set("e5", { role: "link", name: HEADLINE });
    const held = f.call(click("@e5"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    await f.answer("deny");
    await held;
    expect(f.state.dispatched).toEqual([]);
  });

  it("passes a #/ route on the engine's word too", async () => {
    const f = fixture();
    f.state.target = LINK;
    f.state.href = "#/share";
    f.refs.set("e5", { role: "link", name: "Share prices" });
    await expect(f.call(click("@e5"))).resolves.toBe(CLICKED);
  });

  it("does not ask the engine when the snapshot calls the ref anything but a link, or nothing would be held", async () => {
    const f = fixture();
    f.state.target = LINK;
    f.state.href = "/story";
    f.refs.set("e5", { role: "button", name: "Share" });
    const held = f.call(click("@e5"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    await f.answer("deny");
    await held;
    f.refs.set("e6", { role: "link", name: "Read the whole story" });
    await expect(f.call(click("@e6"))).resolves.toBe(CLICKED);
    expect(f.state.hrefs).toEqual([]);
  });

  it("still holds it as money when its box could be inside a payment frame: a link in there is a control like any other", async () => {
    const f = fixture();
    f.state.target = { ...LINK, payFrame: true, inPay: true };
    f.state.href = "/terms";
    f.refs.set("e5", { role: "link", name: "Learn more" });
    const held = f.call(click("@e5"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?" });
    await f.answer("deny");
    await held;
  });

  it("still holds what the read itself found to be a button, whatever the engine says of the ref", async () => {
    const f = fixture();
    f.state.target = element({ label: "Share", role: "link", link: false, frames: true });
    f.state.href = "/share";
    f.refs.set("e5", { role: "link", name: "Share this" });
    const held = f.call(click("@e5"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?" });
    await f.answer("deny");
    await held;
  });
});

describe("round four: part of a form the read cannot look into", () => {
  it("says so on the card, and is part of what the approval is bound to", async () => {
    const f = fixture();
    f.state.target = { ...SEND, opaque: true };
    const held = f.call(click());
    const card = await f.pending();
    expect(card.subtitle).toBe("mail.example.com · Send\nMessage: Hello there\nPart of this form could not be read: a component keeps its inside closed. This approval does not cover what is in there.");
    expect(card.browserCommit).toMatchObject({ partial: true });
    f.state.target = SEND;
    await f.answer("allow");
    const next = await f.pending();
    expect(next.requestId).not.toBe(card.requestId);
    expect(next.subtitle).toBe("mail.example.com · Send\nMessage: Hello there");
    expect(next.browserCommit).not.toHaveProperty("partial");
    await f.answer("deny");
    await held;
  });
});

describe("round four: the page's language reaches the rules", () => {
  const FORM = { label: "Save draft", submits: true, multiline: true, carries: true };

  it("passes an everyday label on an English page, and asks on a page in another language", async () => {
    const f = fixture();
    f.state.target = element({ ...FORM, lang: "en" });
    f.refs.set("e3", { role: "button", name: "Save draft" });
    await expect(f.call(click("@e3"))).resolves.toBe(CLICKED);
    f.state.target = element({ ...FORM, lang: "" });
    await expect(f.call(click("@e3"))).resolves.toBe(CLICKED);
    f.state.target = element({ ...FORM, label: "Speichern", lang: "de" });
    f.refs.set("e4", { role: "button", name: "Speichern" });
    const held = f.call(click("@e4"));
    expect(await f.pending()).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Speichern" } });
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

// The runtime lost an earlier call of this browser (it timed out in the
// engine) and waits for the engine to answer again. The runtime answers the
// bot's next call itself, and that call does not run.
describe("a call made while an earlier one is lost", () => {
  const RECOVERED = { content: [{ type: "text", text: "The browser answers again: the earlier agent_browser_click call that did not answer has ended, and it may have taken effect. This call did not run." }] };
  const judgedCalls = [
    click(),
    { name: "agent_browser_check", arguments: { selector: "@e4" } },
    { name: "agent_browser_press", arguments: { key: "Enter" } },
    { name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way\n" } },
  ];

  it("gives the bot the runtime's answer for a call it would judge, and reads, holds and sends nothing", async () => {
    const f = fixture();
    let asked = 0;
    for (const params of judgedCalls) {
      await expect(f.call(params, { recover: async () => { asked += 1; return RECOVERED; } })).resolves.toBe(RECOVERED);
    }
    expect(asked).toBe(judgedCalls.length);
    expect(f.state.reads).toEqual([]);
    expect(f.state.details).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.state.shots).toBe(0);
    expect(f.cards.size).toBe(0);
    expect(f.rows).toEqual([]);
    expect(f.runtime.ownerKind("s")).toBeNull();
  });

  it("gives the same answer when the earlier call is lost while this one is still being looked at", async () => {
    const f = fixture();
    const answers: unknown[] = [null, RECOVERED];
    // Nothing is lost when the call arrives. During its first read another
    // call of the bot's times out, and the browser becomes uncertain: the
    // read for the card's evidence is refused by the runtime.
    f.state.onRead = () => {
      f.runtime.take("s", "person").catch(() => {});
      f.runtime.abandonHumanInput("s", "person");
      f.runtime.release("s", "person");
    };
    await expect(f.call(click(), { recover: async () => answers.shift() })).resolves.toBe(RECOVERED);
    expect(answers).toEqual([]);
    expect(f.runtime.interrupted("s")).toBe(true);
    expect(f.state.reads).toHaveLength(1);
    expect(f.state.details).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
    // When the runtime has no answer either, the bot hears what the runtime said.
    f.state.onRead = undefined;
    await expect(f.call(click())).rejects.toThrow(/browser engine is stuck/);
    expect(f.state.dispatched).toEqual([]);
  });

  it("does the same for a reload it would hold", async () => {
    const f = fixture();
    const sent = f.call(click());
    await f.answer("allow");
    await sent;
    const cards = f.cards.size, reads = f.state.reads.length;
    await expect(f.call({ name: "agent_browser_reload", arguments: {} }, { recover: async () => RECOVERED })).resolves.toBe(RECOVERED);
    expect(f.cards.size).toBe(cards);
    expect(f.state.reads).toHaveLength(reads);
    expect(f.state.dispatched).toHaveLength(1);
  });

  it("asks once per judged call, after the route admitted it, and goes on as usual when nothing is lost", async () => {
    const f = fixture();
    await expect(f.call(click(), { admit: () => { throw new Error("another thread is using this browser"); } })).rejects.toThrow(/another thread/);
    expect(f.state.recovers).toBe(0);
    f.state.target = element();
    await expect(f.call(click())).resolves.toBe(CLICKED);
    expect(f.state.recovers).toBe(1);
    f.state.target = SEND;
    const held = f.call(click());
    await f.answer("deny");
    expect(text(await held)).toMatch(/the user declined/);
    expect(f.state.recovers).toBe(2);
  });

  it("leaves a call it does not judge, and a script it refuses, as they were: the runtime answers the first in its own place", async () => {
    const f = fixture();
    await expect(f.call({ name: "agent_browser_snapshot", arguments: {} })).resolves.toBe(CLICKED);
    await expect(f.call({ name: "agent_browser_fill", arguments: { selector: "@e3", text: "hello" } })).resolves.toBe(CLICKED);
    expect((await f.call({ name: "agent_browser_eval", arguments: { script: "document.forms[0].submit()" } }) as { isError: boolean }).isError).toBe(true);
    expect(f.state.recovers).toBe(0);
    expect(f.state.dispatched).toHaveLength(2);
  });

  // A snapshot may have been among what was lost, or queued behind it: the
  // engine numbers its refs anew with each one. Until the bot has seen a
  // snapshot again, a ref is not known to be the element its name was for.
  it("does not act on a ref from before the lost call until the bot has taken a snapshot again", async () => {
    const f = fixture();
    f.refs.set("e4", { role: "button", name: "Show details" });
    f.state.target = element();
    f.state.refsStale = true;
    for (const params of [click("@e4"), click("ref=e4"), { name: "agent_browser_check", arguments: { selector: "@e4" } }, { name: "agent_browser_type", arguments: { selector: "@e4", text: "hello\n" } }]) {
      const result = await f.call(params) as { isError: boolean };
      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/an earlier browser call was lost/);
      expect(text(result)).toMatch(/Take a new snapshot and use the @ref it gives/);
    }
    expect(f.state.reads).toEqual([]);
    expect(f.state.dispatched).toEqual([]);
    expect(f.cards.size).toBe(0);
    // A selector is no ref: it is read and judged as ever. So is an Enter press.
    await expect(f.call(click("#details"))).resolves.toBe(CLICKED);
    await expect(f.call({ name: "agent_browser_press", arguments: { key: "Enter" } })).resolves.toBe(CLICKED);
    // The snapshot is seen: the same ref is read and judged again.
    f.state.refsStale = false;
    await expect(f.call(click("@e4"))).resolves.toBe(CLICKED);
    expect(f.state.dispatched).toHaveLength(3);
  });

  it("does not send an approved click by ref when the refs came into doubt while the card waited", async () => {
    const f = fixture();
    f.refs.set("e4", { role: "button", name: "Send" });
    const held = f.call(click("@e4"));
    await f.pending();
    f.state.refsStale = true;
    await f.answer("allow");
    const result = await held as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/an earlier browser call was lost/);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.runtime.ownerKind("s")).toBeNull();
  });

  // The other way round: a call is lost while a card waits. The person's
  // Allow must not send into a browser nobody can read.
  it("sends nothing on an Allow given while the browser is uncertain, and closes the card", async () => {
    const f = fixture();
    const held = f.call(click());
    await f.pending();
    await f.runtime.take("s", "person");
    f.runtime.abandonHumanInput("s", "person"); // leaves the browser uncertain
    f.runtime.release("s", "person");
    expect(f.runtime.interrupted("s")).toBe(true);
    expect(f.runtime.ownerKind("s")).toBe("hold");
    await f.answer("allow");
    const result = await held as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/could not read the page to check it first/);
    expect(f.state.dispatched).toEqual([]);
    expect([...f.cards.values()][0]).toMatchObject({ answered: "unavailable", dismissed: true });
    expect(f.rows.at(-1)).toMatchObject({ decision: "auto-denied", rule: "browser-commit:send:unreadable" });
    // The hold is over; the uncertainty is the runtime's to clear, not the gate's.
    expect(f.runtime.ownerKind("s")).toBeNull();
    expect(f.runtime.interrupted("s")).toBe(true);
  });
});

// Typed text with a line break goes to the engine in steps. A step the
// engine lost may have happened: the bot must not be told it did not.
describe("a step of typed text that the engine lost", () => {
  const typed = (selector: string, value: string) => ({ name: "agent_browser_type", arguments: { selector, text: value } });
  const ENTER = { name: "agent_browser_press", arguments: { key: "Enter" } };
  const SEARCH = element({ label: "Search", role: "searchbox", box: "search", search: true, button: false, typable: false });
  const NOTES = element({ label: "Notes", role: "textbox", box: "multiline", multiline: true, button: false, hint: false, only: false, says: "Notes", near: [] });
  const COMPOSER = element({ label: "Message #general", role: "textbox", box: "multiline", multiline: true, button: false, typable: false, hint: false, only: true, says: "Message #general", near: ["Send"] });
  const lostCall = (name: string) => ({ isError: true, content: [{ type: "text", text: `The browser did not answer this ${name} call. It may still be running, or it may already have taken effect. Do not repeat it yet: your next browser call first waits for the browser, then tells you where the page is.` }] });
  /** The engine gives a field the focus as it types there, and loses the step that `loses` picks: as the runtime reports it, with the browser left uncertain. */
  const engine = (f: ReturnType<typeof fixture>, loses: (sent: { name: string; arguments: { text?: string } }) => boolean) => {
    f.state.onDispatch = (value) => {
      const sent = value as { name: string; arguments: { text?: string } };
      if (sent.name === "agent_browser_type" && typeof f.state.target !== "string") f.state.target = { ...f.state.target, typable: true };
      if (!loses(sent)) return;
      f.state.result = lostCall(sent.name);
      f.runtime.take("s", "person").catch(() => {});
      f.runtime.abandonHumanInput("s", "person");
      f.runtime.release("s", "person");
    };
  };
  const STEPS = /^OpenMausBot typed this in steps: the text, and each Enter as a key press of its own\. The steps before this one were made, and this one did not come back\. The browser did not answer this /;

  it("passes on what the runtime said of a lost Enter, and does not say Enter was not pressed", async () => {
    const f = fixture();
    f.state.target = SEARCH;
    engine(f, (sent) => sent.name === "agent_browser_press");
    const result = await f.call(typed("#q", "lamps\n")) as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(STEPS);
    expect(text(result)).toMatch(/did not answer this agent_browser_press call\. It may still be running, or it may already have taken effect/);
    expect(text(result)).not.toMatch(/did not press Enter|could not press Enter|was not typed/);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps"), ENTER]);
  });

  it("does the same for an Enter the person allowed", async () => {
    const f = fixture();
    f.state.target = COMPOSER;
    engine(f, (sent) => sent.name === "agent_browser_press");
    const held = f.call(typed("#chat", "On my way\n"));
    await f.pending();
    await f.answer("allow");
    const result = await held as { isError: boolean };
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(STEPS);
    expect(text(result)).toMatch(/agent_browser_press call\. It may still be running, or it may already have taken effect/);
    expect(text(result)).not.toMatch(/did not press Enter/);
    expect(f.state.dispatched).toEqual([typed("#chat", "On my way"), ENTER]);
    // The Enter may have sent the message: a reload is held from here on.
    expect([...f.cards.values()][0]).toMatchObject({ answered: "allow" });
  });

  it("does the same for a later line, and for the Enter between lines", async () => {
    for (const [loses, name] of [
      [(sent: { name: string; arguments: { text?: string } }) => sent.arguments.text === "second", "agent_browser_type"],
      [(sent: { name: string; arguments: { text?: string } }) => sent.name === "agent_browser_press", "agent_browser_press"],
    ] as const) {
      const f = fixture();
      f.state.target = NOTES;
      engine(f, loses);
      const result = await f.call(typed("#notes", "first\nsecond")) as { isError: boolean };
      expect(result.isError, name).toBe(true);
      expect(text(result), name).toMatch(STEPS);
      expect(text(result), name).toContain(`did not answer this ${name} call`);
      expect(text(result), name).not.toMatch(/could not press Enter there as a plain new line|The rest was not typed|did not press Enter/);
    }
  });

  it("gives the runtime's own answer when the very first step is lost, and nothing else was done", async () => {
    const f = fixture();
    f.state.target = SEARCH;
    engine(f, (sent) => sent.name === "agent_browser_type");
    const result = await f.call(typed("#q", "lamps\n"));
    expect(text(result)).toMatch(/^The browser did not answer this agent_browser_type call/);
    expect(f.state.dispatched).toEqual([typed("#q", "lamps")]);
  });

  it("still says Enter was not pressed when it was declined, refused, or failed with an answer", async () => {
    const f = fixture();
    f.state.target = COMPOSER;
    engine(f, () => false);
    const held = f.call(typed("#chat", "On my way\n"));
    await f.pending();
    await f.answer("deny");
    expect(text(await held)).toMatch(/^OpenMausBot typed the text and did not press Enter\. .*the user declined/);
    // A failure the engine answered is over: the Enter was tried and did nothing.
    const g = fixture();
    g.state.target = SEARCH;
    g.state.onDispatch = (value) => {
      const sent = value as { name: string };
      if (sent.name === "agent_browser_type" && typeof g.state.target !== "string") g.state.target = { ...g.state.target, typable: true };
      if (sent.name === "agent_browser_press") g.state.result = { isError: true, content: [{ type: "text", text: "Key press failed: no page" }] };
    };
    expect(text(await g.call(typed("#q", "lamps\n")))).toMatch(/^OpenMausBot typed the text and did not press Enter\. Key press failed: no page/);
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
