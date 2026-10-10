import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserCommitGate, browserCallTimeoutMs, type CommitCall } from "./browser-commit-gate.ts";
import { BrowserRuntime, type BrowserRef } from "./browser-runtime.ts";
import { OutboundCounts } from "./outbound-counts.ts";
import { OutboundRequestService } from "./outbound-requests.ts";
import { removeTempDir } from "./testing/cleanup.ts";

import type { OutboundPolicy } from "../shared/outbound.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { PageTarget } from "./browser-commit-page.ts";
import type { DecisionRow } from "./decision-log.ts";

const scratch: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

const element = (extra: Partial<PageTarget> = {}): PageTarget => ({
  label: "Show details", role: "button", box: null, submits: false, search: false, card: false, multiline: false, fields: [], ...extra,
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
    target: SEND as PageTarget | "missing" | "hidden" | "unreadable",
    url: "https://mail.example.com/compose?draft=1#body" as string | null,
    policy: options.policy as OutboundPolicy | undefined,
    active: true,
    reads: [] as Array<{ selector: string | null; enter: boolean }>,
    dispatched: [] as unknown[],
    dropped: [] as string[],
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
      target: async (selector, enter) => { state.reads.push({ selector, enter }); return state.target; },
    },
    shot: async () => "/data/attachments/shot.jpg",
    admit: () => {},
    active: () => state.active,
    signal: abort.signal,
    dispatch: async () => { state.dispatched.push(params); return CLICKED; },
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
    await expect(f.call(click("@e31"))).resolves.toBe(CLICKED);
    await expect(f.call(click("#pay-in-frame"))).resolves.toBe(CLICKED);
    expect(f.cards.size).toBe(0);
    const held = f.call(click("@e27"));
    expect(await f.pending()).toMatchObject({ title: "Spend money?", subtitle: "mail.example.com · Pay", browserCommit: { class: "money", label: "Pay", fields: [] } });
    await f.answer("deny");
    await held;
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
