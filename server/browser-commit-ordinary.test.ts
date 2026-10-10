// @vitest-environment happy-dom
//
// Ordinary browsing, and the outcome each operation must have. The hold is a
// guard against a bot over-acting on ordinary pages: it has to ask where
// something is sent or paid for, and it has to stay out of the way of the
// links, filters, sign-ins and notes that make up most of what a bot does.
//
// Every row runs through the real page reader and the real gate. The page is
// happy-dom's, the engine is a stand-in that measures an element and runs the
// read's own scripts in that page. A click goes by a ref, the way a bot
// clicks: the gate also judges the name the snapshot gave it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BrowserCommitGate } from "./browser-commit-gate.ts";
import { browserPageReader, type EngineQuery } from "./browser-commit-page.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import { OutboundCounts } from "./outbound-counts.ts";
import { OutboundRequestService } from "./outbound-requests.ts";
import { removeTempDir } from "./testing/cleanup.ts";

import type { OptionCardData } from "../shared/wire.ts";

/** The server's types carry no DOM. This is all of happy-dom the table touches. */
interface El { focus(): void; getAttribute(name: string): string | null; textContent: string | null; tagName: string; value?: string }
const page = (globalThis as unknown as { document: { body: { innerHTML: string }; querySelector(selector: string): El | null } }).document;

/** happy-dom lays nothing out: each element the engine "measures" gets a box
 * of its own, which the read then finds it by. */
const boxes = new WeakMap<object, { x: number; y: number; width: number; height: number }>();
let measured = 0;
const boxFor = (el: object) => {
  if (!boxes.has(el)) { measured += 1; boxes.set(el, { x: 10 + measured * 3, y: 20 + measured * 37, width: 100 + measured, height: 24 }); }
  return boxes.get(el)!;
};
const layout = (globalThis as unknown as { Element: { prototype: { getBoundingClientRect(): unknown } } }).Element.prototype;
const measure = layout.getBoundingClientRect;
beforeAll(() => { layout.getBoundingClientRect = function (this: object) { return boxes.get(this) ?? measure.call(this); }; });
afterAll(() => { layout.getBoundingClientRect = measure; });

const scratch: string[] = [];
const runtimes: BrowserRuntime[] = [];
afterEach(async () => {
  page.body.innerHTML = "";
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

type Outcome = "passes" | "held as Send" | "held as Money" | "refused";
interface Op {
  what: string;
  html: string;
  /** A click on this element, by a ref the snapshot named as the element is. */
  click?: string;
  /** A key press, with the focus on `focus` when given. */
  press?: string;
  focus?: string;
  /** Text typed at this selector. */
  type?: [selector: string, text: string];
  /** Another tool on the element: check, select. */
  tool?: [name: string, selector: string];
  want: Outcome;
}

/** The role and name a snapshot gives an element, near enough. */
function snapshotOf(el: El): { role: string; name: string } {
  const tag = el.tagName;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  const role = el.getAttribute("role")
    ?? (tag === "A" ? "link" : tag === "BUTTON" || ["submit", "button", "image", "reset"].includes(type) ? "button" : tag === "TEXTAREA" ? "textbox"
      : tag === "SELECT" ? "combobox" : tag === "INPUT" ? (type === "checkbox" || type === "radio" ? type : type === "search" ? "searchbox" : "textbox") : "generic");
  const name = el.getAttribute("aria-label") ?? (tag === "INPUT" && role === "button" ? el.value ?? "" : (el.textContent ?? "").replace(/\s+/g, " ").trim());
  return { role, name };
}

async function outcomeOf(op: Op): Promise<Outcome> {
  page.body.innerHTML = op.html;
  if (op.focus) page.querySelector(op.focus)!.focus();
  const refs = new Map<string, El>();
  const selector = op.click ?? op.tool?.[1];
  if (selector) refs.set("e1", page.querySelector(selector)!);
  const params = op.click ? { name: "agent_browser_click", arguments: { selector: "@e1" } }
    : op.tool ? { name: op.tool[0], arguments: { selector: "@e1", value: "b" } }
    : op.type ? { name: "agent_browser_type", arguments: { selector: op.type[0], text: op.type[1] } }
    : { name: "agent_browser_press", arguments: { key: op.press } };
  const engine: EngineQuery = async (args) => {
    if (args[0] === "get" && args[1] === "box") {
      const asked = args[2]!;
      let el: El | null = null;
      // A ref is the engine's own; anything else here is a CSS selector, and
      // what is not one (`text=…`) the engine cannot measure either.
      try { el = asked.startsWith("@") ? refs.get(asked.slice(1)) ?? null : page.querySelector(asked); } catch { el = null; }
      return el ? { ok: true, data: boxFor(el) } : { ok: false, error: `Element not found: ${asked}` };
    }
    if (args[0] === "get") return { ok: true, data: { url: "https://app.example.com/page" } };
    return { ok: true, data: { result: new Function(`return ${Buffer.from(args[2]!, "base64").toString()}`)() as Record<string, unknown> } };
  };
  const dir = mkdtempSync(join(tmpdir(), "omb-ordinary-"));
  scratch.push(dir);
  const runtime = new BrowserRuntime({ takeoverTimeoutMs: 200 });
  runtimes.push(runtime);
  const requests = new OutboundRequestService();
  let raise: (card: OptionCardData) => void = () => {};
  const raised = new Promise<OptionCardData>((resolve) => { raise = resolve; });
  const gate = new BrowserCommitGate({
    runtime: {
      hold: runtime.hold.bind(runtime), releaseHold: runtime.releaseHold.bind(runtime), personReleased: runtime.personReleased.bind(runtime),
      withAgentAction: runtime.withAgentAction.bind(runtime),
      ref: (_session, ref) => { const el = refs.get(ref); return el ? snapshotOf(el) : undefined; },
    },
    requests, counts: new OutboundCounts(join(dir, "outbound-counts.json")), holdMs: 5_000, handBackMs: 1_000,
    policy: () => null,
    post: ({ card }) => { raise(card); return "card-1"; },
    patch: () => {}, resume: () => {}, log: () => {}, dropShot: () => {},
  });
  let dispatched = 0;
  const result = gate.guard({
    botId: "bot-1", botName: "Pepper", threadId: "thread-1", session: "s", params,
    page: browserPageReader(engine),
    shot: async () => "/data/attachments/shot.jpg",
    admit: () => {}, active: () => true, signal: new AbortController().signal,
    dispatch: async () => { dispatched += 1; return { content: [{ type: "text", text: "done" }] }; },
  });
  const first = await Promise.race([result.then(() => null), raised]);
  if (first) {
    requests.resolve({ threadId: "thread-1", requestId: first.requestId!, behavior: "deny" });
    await result;
    expect(dispatched).toBe(0);
    return first.browserCommit!.class === "money" ? "held as Money" : "held as Send";
  }
  if ((await result as { isError?: boolean }).isError) return "refused";
  expect(dispatched).toBe(1);
  return "passes";
}

// ── The pages ──
const link = (text: string, want: Outcome = "passes"): Op => ({ what: `a link that says "${text}"`, html: `<ul><li><a href="/elsewhere">Home</a></li><li><a id="t" href="/next-page">${text}</a></li></ul>`, click: "#t", want });
/** A form with a multi-line box, and a button that says `label`. */
const boxForm = (label: string, want: Outcome): Op => ({
  what: `"${label}" on a form with a box of many lines`, want, click: "#t",
  html: `<form><input aria-label="Title" value="Notes for Tuesday"><textarea aria-label="About you">I write software.</textarea><button id="t">${label}</button></form>`,
});
/** A button with no form, labelled `label`. */
const button = (label: string, want: Outcome): Op => ({ what: `a button that says "${label}"`, html: `<main><h1>Account</h1><button id="t" type="button">${label}</button></main>`, click: "#t", want });
const CARD = `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="Expiry" autocomplete="cc-exp"><input aria-label="CVC" autocomplete="cc-csc">`;
const SIGN_IN = (label: string) => `<form><input aria-label="Email" value="ada@example.com"><input id="pw" type="password" aria-label="Password" value="correct-horse"><button id="t">${label}</button></form>`;
const CHAT = `<header><input type="search" aria-label="Search"></header><main><div role="log">Ada: are you there?</div>
  <div role="region" aria-label="Composer"><div id="box" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Message #general">On my way</div><button id="send" type="button" aria-label="Send"></button></div></main>`;
const NOTES = `<form><input aria-label="Title" value="Tuesday"><textarea id="box" aria-label="Notes">Bring the charger</textarea><button id="t">Save</button></form>`;
const FILTERS = (label: string) => `<form><select aria-label="Sort by"><option>Newest</option></select><label><input type="checkbox" checked> In stock</label><input aria-label="Max price" value="50"><button id="t">${label}</button></form>`;
const FRAME = `<section><input id="first" aria-label="Name" value="Ada"></section><section><object id="frame" tabindex="0" title="Secure payment"></object></section>`;

const OPS: Op[] = [
  // Forty links whose text has a word from the lists. A link that loads
  // another page is never a commitment by what it says.
  ...["Blog post", "Post archive", "Share prices", "Message board", "Comment policy", "Reply guidelines", "Submit a pull request", "How to apply",
    "Apply for a job", "Invite friends", "Send feedback", "Book reviews", "Book a demo", "Order history", "Pay rates", "Buy tickets", "Subscribe", "Donate",
    "Transfer students", "Reserve list", "Bid history", "Purchase history", "Place order help", "Publish your app", "Share on X", "Checkout our guide",
    "Upgrade guide", "Renew your passport", "Sell with us", "Trade agreements", "Deposit rates", "Withdraw consent", "Forward thinking", "Notify me",
    "Tweet archive", "Top up options", "Get tickets", "Start free trial", "Send", "Buy now"].map((text) => link(text)),

  // A link that acts as a button is judged as a button.
  { what: 'a "#" link that says Send', html: `<p><a id="t" href="#">Send</a></p>`, click: "#t", want: "held as Send" },
  { what: 'a "javascript:" link that says Pay now', html: `<p><a id="t" href="javascript:void(0)">Pay now</a></p>`, click: "#t", want: "held as Money" },
  { what: "a link with a button role that says Post", html: `<p><a id="t" href="/post" role="button">Post</a></p>`, click: "#t", want: "held as Send" },
  { what: "a link with a click handler that says Share", html: `<p><a id="t" href="/share" onclick="share(); return false">Share</a></p>`, click: "#t", want: "held as Send" },
  { what: 'a "#" link that says Next', html: `<p><a id="t" href="#">Next</a></p>`, click: "#t", want: "passes" },
  { what: "a link to the terms inside a card form", html: `<form>${CARD}<a id="t" href="/terms">Terms</a><button>Pay</button></form>`, click: "#t", want: "held as Money" },

  // Forms with a box of many lines: a harmless label is not a send.
  { ...boxForm("Save changes", "passes"), what: 'a profile form with an "About you" box and "Save changes"' },
  ...["Save", "Update", "Next", "Continue", "Back", "Cancel", "Close", "Done", "OK", "Reset", "Clear", "Add", "Edit", "Preview", "Upload", "Sign up", "Create account", "Register"].map((label) => boxForm(label, "passes")),
  boxForm("Go", "held as Send"),
  boxForm("Enviar", "held as Send"),
  boxForm("Send", "held as Send"),
  { what: '"Send" in a mail compose form', html: `<form><input aria-label="To" value="ada@example.com"><input aria-label="Subject" value="Lunch"><textarea aria-label="Body">At one?</textarea><button id="t">Send</button></form>`, click: "#t", want: "held as Send" },
  { what: 'a "Comment" button on a form with one field', html: `<form><textarea aria-label="Add a comment">Looks good</textarea><button id="t">Comment</button></form>`, click: "#t", want: "held as Send" },

  // Apply.
  { what: 'filters with "Apply"', html: FILTERS("Apply"), click: "#t", want: "passes" },
  { what: 'filters with "Apply filters"', html: FILTERS("Apply filters"), click: "#t", want: "passes" },
  { what: 'a coupon box with "Apply"', html: `<form><input aria-label="Promo code" value="SAVE10"><button id="t">Apply</button></form>`, click: "#t", want: "passes" },
  { what: '"Apply" in a settings dialog with no form', html: `<div role="dialog"><label><input type="checkbox"> Dark mode</label><button id="t" type="button">Apply</button></div>`, click: "#t", want: "passes" },
  { what: '"Apply" on a job form with a file to attach', html: `<form><input aria-label="Name" value="Ada"><input type="file" aria-label="CV"><button id="t">Apply</button></form>`, click: "#t", want: "held as Send" },
  { what: '"Apply" on a job form with a cover letter', html: `<form><input aria-label="Name" value="Ada"><textarea aria-label="Cover letter">Dear team</textarea><button id="t">Apply</button></form>`, click: "#t", want: "held as Send" },
  button("Apply now", "held as Send"),
  button("Easy Apply", "held as Send"),
  button("Submit application", "held as Send"),

  // Signing in is never a send.
  { what: 'a log-in with "Submit"', html: SIGN_IN("Submit"), click: "#t", want: "passes" },
  { what: 'a log-in with "Sign in"', html: SIGN_IN("Sign in"), click: "#t", want: "passes" },
  { what: 'a log-in with "Log in"', html: SIGN_IN("Log in"), click: "#t", want: "passes" },
  { what: "Enter in a log-in's password field", html: SIGN_IN("Submit"), focus: "#pw", press: "Enter", want: "passes" },
  { what: '"Continue" in a sign-up form', html: `<form><input aria-label="Email"><input type="password" aria-label="Choose a password"><button id="t">Continue</button></form>`, click: "#t", want: "passes" },
  { what: "a line break typed into a log-in's password field", html: SIGN_IN("Log in"), type: ["#pw", "correct-horse\n"], want: "passes" },

  // Money: what the label says, and anything in a card region.
  { what: '"Pay now" on a cart', html: `<form><input aria-label="Email" value="ada@example.com"><button id="t">Pay now</button></form>`, click: "#t", want: "held as Money" },
  ...["Place bet", "Deposit", "Withdraw", "Top up", "Add funds", "Upgrade", "Start free trial", "Renew", "Get tickets", "Sell", "Trade", "Sign transaction", "Charge", "Buy now", "Place order", "Subscribe", "Donate"].map((label) => button(label, "held as Money")),
  { what: '"Continue" in a card region', html: `<form>${CARD}<button id="t" type="button">Continue</button></form>`, click: "#t", want: "held as Money" },
  { what: '"Complete" in a card region', html: `<form>${CARD}<button id="t">Complete</button></form>`, click: "#t", want: "held as Money" },
  { what: "Enter in a card field", html: `<form><input id="num" aria-label="Card number" autocomplete="cc-number"><button>Continue</button></form>`, focus: "#num", press: "Enter", want: "held as Money" },
  ...["Confirm", "Continue", "Complete", "Approve", "Authorize", "Agree & Continue"].map((label) => button(label, "passes")),

  // Sends by label.
  ...["Send", "Reply", "Post", "Publish", "Share", "Invite", "Forward", "Tweet", "Notify", "Accept invitation", "Send message"].map((label) => button(label, "held as Send")),

  // Enter in a box of many lines: a new line, unless the box is a composer.
  { what: "Enter in a notes box", html: NOTES, focus: "#box", press: "Enter", want: "passes" },
  { what: "Enter in a description box of a product form", html: `<form><input aria-label="Name" value="Lamp"><input aria-label="Price" value="20"><textarea id="box" aria-label="Description">Warm light</textarea><button>Save</button></form>`, focus: "#box", press: "Enter", want: "passes" },
  { what: "Enter in a chat composer", html: CHAT, focus: "#box", press: "Enter", want: "held as Send" },
  { what: "Shift+Enter in a chat composer", html: CHAT, focus: "#box", press: "Shift+Enter", want: "passes" },
  { what: 'Enter in a box whose keyboard says "send"', html: `<form><input aria-label="Title"><textarea id="box" aria-label="Text" enterkeyhint="send">Hello</textarea><button>Go</button></form>`, focus: "#box", press: "Enter", want: "held as Send" },
  { what: "Enter in a lone reply box", html: `<article><p>Great write-up.</p><div><textarea id="box" placeholder="Write a reply">Thanks</textarea></div></article>`, focus: "#box", press: "Enter", want: "held as Send" },
  { what: "Enter in a comment form with one field", html: `<form><textarea id="box" aria-label="Your thoughts">Nice</textarea><button>Comment</button></form>`, focus: "#box", press: "Enter", want: "held as Send" },
  { what: "Control+Enter in a notes box", html: NOTES, focus: "#box", press: "Control+Enter", want: "held as Send" },
  { what: "Enter in a title field of a notes form", html: `<form><input id="title" aria-label="Title" value="Tuesday"><textarea aria-label="Notes">Bring the charger</textarea><button>Save</button></form>`, focus: "#title", press: "Enter", want: "passes" },
  { what: "Enter in a search box", html: `<form role="search"><input id="q" type="search" aria-label="Search" value="lamps"><button>Search</button></form>`, focus: "#q", press: "Enter", want: "passes" },

  // Typed text.
  { what: "several lines typed into a notes box", html: NOTES, type: ["#box", "Bring the charger\nand the cable\n"], want: "passes" },
  { what: "a line break typed into a chat composer", html: CHAT, type: ["#box", "On my way\n"], want: "refused" },
  { what: "a line break typed at a paragraph", html: `<p id="para">Read this first</p>${NOTES}`, type: ["#para", "x\n"], want: "refused" },
  { what: "a tab and a line break typed into a notes box", html: NOTES, type: ["#box", "a\tb\n"], want: "refused" },
  { what: "a line break typed at a selector the engine cannot resolve", html: NOTES, type: ["text=Notes", "x\n"], want: "refused" },

  // Space.
  { what: "Space on a focused Save button", html: NOTES, focus: "#t", press: "Space", want: "passes" },
  { what: "Space on a focused Send button", html: CHAT, focus: "#send", press: "Space", want: "held as Send" },
  { what: "Space in a notes box", html: NOTES, focus: "#box", press: "Space", want: "passes" },

  // Where the read cannot look.
  { what: "Enter with the focus inside a payment frame", html: FRAME, focus: "#frame", press: "Enter", want: "refused" },
  { what: "Space with the focus inside a payment frame", html: FRAME, focus: "#frame", press: "Space", want: "refused" },
  { what: "a click on a frame itself", html: FRAME, click: "#frame", want: "refused" },

  // The rest of a bot's day.
  ...["Show details", "Add to cart", "Like", "Follow", "Download", "Delete", "Load more", "Copy link", "Log out", "Accept all cookies", "Sort", "Filter", "Search"].map((label) => button(label, "passes")),
  { what: "a click into a text box", html: NOTES, click: "#box", want: "passes" },
  { what: "ticking a newsletter box", html: `<form><label><input id="t" type="checkbox"> Subscribe to the newsletter</label><button>Save</button></form>`, tool: ["agent_browser_check", "#t"], want: "passes" },
  { what: "choosing from a sort list", html: `<select id="t" aria-label="Sort by"><option value="a">Newest</option><option value="b">Price</option></select>`, tool: ["agent_browser_select", "#t"], want: "passes" },
  { what: "a search form's button", html: `<form role="search"><input type="search" aria-label="Search" value="lamps"><button id="t">Search</button></form>`, click: "#t", want: "passes" },
  { what: 'a "Messages" tab', html: `<div role="tablist"><div id="t" role="tab" tabindex="0">Messages</div></div>`, click: "#t", want: "passes" },
  { what: "the Tab key", html: NOTES, focus: "#box", press: "Tab", want: "passes" },
];

describe("ordinary operations", () => {
  it("covers at least seventy of them, with each outcome present", () => {
    expect(OPS.length).toBeGreaterThanOrEqual(70);
    expect(OPS.filter((op) => op.what.startsWith("a link that says") && op.want === "passes")).toHaveLength(40);
    expect(new Set(OPS.map((op) => op.want))).toEqual(new Set(["passes", "held as Send", "held as Money", "refused"]));
    expect(new Set(OPS.map((op) => op.what)).size).toBe(OPS.length);
  });

  it.each(OPS.map((op) => [op.want, op.what, op] as const))("%s: %s", async (want, _what, op) => {
    expect(await outcomeOf(op)).toBe(want);
  });
});
