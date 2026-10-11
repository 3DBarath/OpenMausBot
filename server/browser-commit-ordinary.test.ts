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
interface El { focus(): void; getAttribute(name: string): string | null; hasAttribute(name: string): boolean; closest(selector: string): El | null; textContent: string | null; tagName: string; value?: string; attachShadow?(init: { mode: string }): { innerHTML: string; querySelector(selector: string): El | null } }
const page = (globalThis as unknown as { document: { body: { innerHTML: string }; documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }; querySelector(selector: string): El | null } }).document;

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
  /** The language the page declares. English when not given; "" for none. */
  lang?: string;
  /** What the snapshot calls the clicked element, when not what its text says. */
  named?: string;
  /** The role the snapshot gives it, when not the one its tag has. */
  role?: string;
  /** Runs once the page is in place: to give a component its shadow root. */
  setup?: () => void;
  /** The clicked element, when no selector reaches it (it is inside a shadow root). */
  pick?: () => El;
  /** What the page does once text has been typed into a field: its own
   * script, which a page set by innerHTML does not run. */
  reacts?: () => void;
  /** The click is on a ref inside a frame from another site: the engine
   * measures it from the frame's own corner, and nothing on the page has
   * that box. */
  inFrame?: { role: string; name: string; href?: string };
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

/** Where the engine says an element inside another site's frame is: a box no element of the page has. */
const FRAMED = { x: 6, y: 8, width: 83, height: 21 };

async function outcomeOf(op: Op): Promise<Outcome> {
  if (op.lang === "") page.documentElement.removeAttribute("lang");
  else page.documentElement.setAttribute("lang", op.lang ?? "en");
  page.body.innerHTML = op.html;
  op.setup?.();
  if (op.focus) page.querySelector(op.focus)!.focus();
  const refs = new Map<string, El>();
  const selector = op.click ?? op.tool?.[1];
  if (op.pick) refs.set("e1", op.pick());
  else if (selector) refs.set("e1", page.querySelector(selector)!);
  const clicks = Boolean(op.click || op.pick || op.inFrame);
  const params = clicks ? { name: "agent_browser_click", arguments: { selector: "@e1" } }
    : op.tool ? { name: op.tool[0], arguments: { selector: "@e1", value: "b" } }
    : op.type ? { name: "agent_browser_type", arguments: { selector: op.type[0], text: op.type[1] } }
    : { name: "agent_browser_press", arguments: { key: op.press } };
  const engine = async (args: string[], stdin?: string): ReturnType<EngineQuery> => {
    // A ref is the engine's own; anything else here is a CSS selector, and
    // what is not one (`text=…`) the engine cannot resolve either.
    const resolve = (asked: string): El | null => { try { return asked.startsWith("@") ? refs.get(asked.slice(1)) ?? null : page.querySelector(asked); } catch { return null; } };
    if (args[0] === "get" && args[1] === "box") {
      if (op.inFrame && args[2] === "@e1") return { ok: true, data: FRAMED };
      const el = resolve(args[2]!);
      return el ? { ok: true, data: boxFor(el) } : { ok: false, error: `Element not found: ${args[2]}` };
    }
    if (args[0] === "get" && args[1] === "attr") {
      if (op.inFrame && args[2] === "@e1") return { ok: true, data: { value: op.inFrame.href ?? null } };
      const el = resolve(args[2]!);
      return el ? { ok: true, data: { value: el.getAttribute(args[3]!) } } : { ok: false, error: `Element not found: ${args[2]}` };
    }
    if (args[0] === "get") return { ok: true, data: { url: "https://app.example.com/page" } };
    // The read's own script, which the engine is given on its input.
    return { ok: true, data: { result: new Function(`return ${stdin}`)() as Record<string, unknown> } };
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
      withAgentAction: runtime.withAgentAction.bind(runtime), refsStale: () => false, interrupted: () => false,
      ref: (_session, ref) => {
        if (op.inFrame) return ref === "e1" ? { role: op.inFrame.role, name: op.inFrame.name } : undefined;
        const el = refs.get(ref);
        return el ? { ...snapshotOf(el), ...(op.named === undefined ? {} : { name: op.named }), ...(op.role === undefined ? {} : { role: op.role }) } : undefined;
      },
    },
    requests, counts: new OutboundCounts(join(dir, "outbound-counts.json")), holdMs: 5_000, handBackMs: 1_000,
    policy: () => null,
    post: ({ card }) => { raise(card); return "card-1"; },
    patch: () => {}, resume: () => {}, log: () => {}, dropShot: () => {},
  });
  const dispatched: Array<{ name: string; arguments: { text?: string } }> = [];
  /** What the engine does with a call that goes through, as far as the next
   * read can tell: typing at a field gives it the focus, unless it cannot
   * take it (measured on agent-browser 0.37.0: a disabled group, an inert
   * parent, a hidden field, and then the keys go to whatever has the focus). */
  const engineDoes = (sent: unknown) => {
    const { name, arguments: given } = sent as { name: string; arguments: { selector?: string; text?: string } };
    if (name !== "agent_browser_type" || !given.selector) return;
    let el: El | null = null;
    try { el = given.selector.startsWith("@") ? refs.get(given.selector.slice(1)) ?? null : page.querySelector(given.selector); } catch { el = null; }
    if (el && !el.hasAttribute("disabled") && !el.closest("fieldset[disabled], [inert]") && !/visibility:\s*hidden|display:\s*none/.test(el.getAttribute("style") ?? "")) el.focus();
    if (given.text) op.reacts?.();
  };
  const result = gate.guard({
    botId: "bot-1", botName: "Pepper", threadId: "thread-1", session: "s", params,
    page: browserPageReader(engine),
    shot: async () => "/data/attachments/shot.jpg",
    admit: () => {}, recover: async () => null, active: () => true, signal: new AbortController().signal,
    dispatch: async (sent) => { dispatched.push(sent as (typeof dispatched)[number]); engineDoes(sent); return { content: [{ type: "text", text: "done" }] }; },
  });
  const first = await Promise.race([result.then(() => null), raised]);
  if (first) {
    requests.resolve({ threadId: "thread-1", requestId: first.requestId!, behavior: "deny" });
    await result;
    // Nothing went out while it was held. Text typed without its line break, ahead of an Enter that was held, is not "out".
    expect(dispatched.filter((sent) => sent.name !== "agent_browser_type" || /[\r\n]/.test(sent.arguments.text ?? ""))).toEqual([]);
    return first.browserCommit!.class === "money" ? "held as Money" : "held as Send";
  }
  if ((await result as { isError?: boolean }).isError) return "refused";
  // One call, or two when the gate typed the text and pressed Enter as steps of its own.
  expect(dispatched.length).toBeGreaterThanOrEqual(1);
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
  // A label on neither list: on an English page it passes; the rule that
  // holds it is for pages in another language.
  boxForm("Go", "passes"),
  { ...boxForm("Enviar", "held as Send"), what: '"Enviar" on a form with a box of many lines, on a page in Spanish', lang: "es" },
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
  { what: "a line break typed into a log-in's password field, which has the focus", html: SIGN_IN("Log in"), focus: "#pw", type: ["#pw", "correct-horse\n"], want: "passes" },

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
  { what: "several lines typed into a notes box, which has the focus", html: NOTES, focus: "#box", type: ["#box", "Bring the charger\nand the cable\n"], want: "passes" },
  // (Round five: the text is typed, and the Enter is held on a card. It used to be refused.)
  { what: "a line break typed into a chat composer", html: CHAT, focus: "#box", type: ["#box", "On my way\n"], want: "held as Send" },
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

// ── What the first table missed ──
// The table above was built beside the rules it tests. These are the groups
// a reviewer found outside it: links that stay on the page, shop pages with
// a payment brand's frame on them, text-area forms with everyday labels,
// and links whose snapshot name is not their text.
const contents = (text: string, id: string): Op => ({ what: `a contents link "${text}" to a place on the same page`, html: `<nav><a id="t" href="#${id}">${text}</a></nav><p>…</p><h2 id="${id}">${text}</h2>`, click: "#t", want: "passes" });
const route = (text: string, href: string): Op => ({ what: `a "${href}" route that says "${text}"`, html: `<nav><a href="#/">Home</a> <a id="t" href="${href}">${text}</a></nav><div id="app"></div>`, click: "#t", want: "passes" });
/** A product page with a pay-later message frame and a wallet button frame, both from another site. (Round six: a
 * frame that calls itself "express checkout" and names no brand is a card signal, so the wallet frame here names one.) */
const SHOP = (inner: string) => `<main><h1>Desk lamp</h1><p>$40.00</p>${inner}
  <object title="Klarna On-site messaging"></object><object title="Shop Pay"></object></main>`;
const shop = (what: string, inner: string, rest: Partial<Op> = { click: "#t" }): Op => ({ what: `${what} on a shop page with a pay-later frame and a wallet frame`, html: SHOP(inner), want: "passes", ...rest });
/** An article with an advert frame, and a link whose name in the snapshot is not what its text says. */
const renamed = (what: string, anchor: string, named: string): Op => ({ what: `${what}, by ref, on a page with an advert frame`, html: `<article>${anchor}<p>Body.</p></article><object title="Advertisement"></object>`, click: "#t", named, want: "passes" });
const LONG = "How to share and post your first message with the new publishing tools: a complete walk-through for people who have never sent one before today";
const CARD_REGION = (control: string) => `<form>${CARD}${control}</form>`;
const shadow = (host: string, inner: string) => () => { page.querySelector(host)!.attachShadow!({ mode: "open" }).innerHTML = inner; };

const GAPS: Op[] = [
  // Links that stay on the page: a contents list, a single-page app's routes.
  contents("Transfer of power", "transfer"), contents("Trade", "trade"), contents("Reply to critics", "reply"), contents("Share of the vote", "share"),
  contents("Post-war order", "post-war"), contents("Book of the year", "book"),
  { what: "a contents link to a named anchor", html: `<nav><a id="t" href="#notes">Send-off notes</a></nav><a name="notes"></a>`, click: "#t", want: "passes" },
  route("Blog post", "#/blog"), route("Message centre", "#/messages"), route("Share prices", "#!/share"), route("Pay rates", "#/pay"), route("Subscribe", "#/subscribe"),
  { what: 'a "#" link that says Send, still', html: `<p><a id="t" href="#">Send</a></p>`, click: "#t", want: "held as Send" },
  { what: "a link to a place the page does not have, that says Send", html: `<p><a id="t" href="#nowhere">Send</a></p>`, click: "#t", want: "held as Send" },
  { what: "a route link with a click handler, that says Send", html: `<p><a id="t" href="#/send" onclick="send()">Send</a></p>`, click: "#t", want: "held as Send" },

  // A shop page with a payment brand's message or button in a frame is still a shop page.
  shop('"Add to cart"', `<button id="t" type="button">Add to cart</button>`),
  shop("a size list that updates the page", `<select id="t" aria-label="Size" onchange="pick(this.value)"><option value="a">Small</option><option value="b">Large</option></select>`, { tool: ["agent_browser_select", "#t"] }),
  shop("a quantity stepper", `<button id="t" type="button" aria-label="Increase quantity">+</button>`),
  shop("a link to the reviews", `<a id="t" href="/reviews">Read the reviews</a>`),
  shop("an accordion", `<div id="t" role="button" tabindex="0" aria-expanded="false">Shipping details</div>`),
  shop('"Add to wishlist"', `<button id="t" type="button">Add to wishlist</button>`),
  { what: "a link on a blog post with a donation-button frame", html: `<article><p>Thanks for reading.</p><a id="t" href="/next">Share this story</a><object title="Donate with PayPal button"></object></article>`, click: "#t", want: "passes" },
  { what: '"Like" on a blog post with a donation-button frame', html: `<article><p>Thanks for reading.</p><button id="t" type="button">Like</button><object title="Donate with PayPal button"></object></article>`, click: "#t", want: "passes" },
  // A click inside such a frame is still money, and a frame for typing a card in still makes its form a card region.
  { what: "the button inside a wallet frame", html: SHOP(""), inFrame: { role: "button", name: "Buy with Pay" }, want: "held as Money" },
  { what: 'a "Continue" inside a frame named only klarna-payments-main', html: `<main><h1>Checkout</h1><object name="klarna-payments-main"></object></main>`, inFrame: { role: "button", name: "Continue" }, want: "held as Money" },
  { what: '"Continue" on a form whose card field is a hosted card-number frame', html: `<form><input aria-label="Email"><object title="Secure card number input frame"></object><button id="t" type="button">Continue</button></form>`, click: "#t", want: "held as Money" },

  // Forms with a box of many lines, on an English page: an everyday label is not a send.
  ...["Save settings", "Save draft", "Update profile", "Translate", "Format", "Run", "Generate", "Create", "Add note", "Finish", "Convert", "Check grammar"].map((label) => boxForm(label, "passes")),
  { ...boxForm("Save draft", "passes"), what: '"Save draft" on such a form, on a page that declares no language', lang: "" },
  // The same form on a page in another language is where the rule is for.
  { ...boxForm("Speichern", "held as Send"), what: '"Speichern" on such a form, on a German page', lang: "de" },
  { ...boxForm("Enviar", "held as Send"), what: '"Enviar" on such a form, on a Spanish page', lang: "es-MX" },
  { ...boxForm("Veröffentlichen", "held as Send"), what: '"Veröffentlichen" on such a form, on a page that declares no language', lang: "" },
  { ...boxForm("送信", "held as Send"), what: "a label in Japanese on such a form, on a page that says it is English" },

  // A link whose name in the snapshot is not what its text says.
  renamed("a headline longer than a label", `<h2><a id="t" href="/story">${LONG}</a></h2>`, LONG),
  renamed("a link with text only a screen reader gets", `<a id="t" href="/subscribe">Subscribe<span aria-hidden="true"> to the newsletter</span></a>`, "Subscribe"),
  renamed("a link with a picture and text", `<a id="t" href="/tips"><img alt="Send icon" width="10" height="10"> Send us a tip</a>`, "Send icon Send us a tip"),
  { ...shop("a link the snapshot names by its title", `<a id="t" href="/guide" title="Buy and pay guide">Guide</a>`), named: "Buy and pay guide" },
  { ...renamed("a button the snapshot calls Send", `<a id="t" href="/story">Read on</a>`, "Send"), what: "a ref the snapshot calls a button named Send, over a plain link, on a page with an advert frame", role: "button", want: "held as Send" as const },

  // A search field is no way round a payment.
  { what: 'Enter in an address finder inside a card form with "Pay now"', html: `<form><input id="find" type="search" aria-label="Find your address">${CARD}<button>Pay now</button></form>`, focus: "#find", press: "Enter", want: "held as Money" },
  { what: "Enter in a promo field marked as a search box, inside a card form", html: `<form><input id="find" role="searchbox" aria-label="Promo code">${CARD}<button>Continue</button></form>`, focus: "#find", press: "Enter", want: "held as Money" },
  { what: '"Continue" on a card form inside a search region', html: `<div role="search"><form>${CARD}<button id="t">Continue</button></form></div>`, click: "#t", want: "held as Money" },
  { what: '"Buy now" on a form whose only text field is a search field', html: `<form><input type="search" aria-label="Find a product" value="lamp"><button id="t">Buy now</button></form>`, click: "#t", want: "held as Money" },
  { what: 'Enter in the search field of a form whose button says "Buy now"', html: `<form><input id="find" type="search" aria-label="Find a product" value="lamp"><button>Buy now</button></form>`, focus: "#find", press: "Enter", want: "held as Money" },
  { what: "a search whose words are a card number", html: `<form role="search"><input type="search" aria-label="Search" value="4242 4242 4242 4242"><button id="t">Search</button></form>`, click: "#t", want: "passes" },

  // Typed text with a line break, aimed at a field that does not have the focus.
  // (Round five: the gate types the text at the search box itself, and presses Enter only once that box has the focus.)
  { what: "a line break typed at a search box while a Buy now button has the focus", html: `<form role="search"><input id="q" type="search" aria-label="Search"></form><form><button id="buy">Buy now</button></form>`, focus: "#buy", type: ["#q", "lamps\n"], want: "passes" },
  { what: "a line break typed at a disabled field while a payment form has the focus", html: `<fieldset disabled><form><input id="off" aria-label="Notes"></form></fieldset><form><input id="amount" aria-label="Amount"><button>Pay now</button></form>`, focus: "#amount", type: ["#off", "x\n"], want: "refused" },
  { what: "a line break typed at a notes box that does not have the focus", html: `<form><input id="title" aria-label="Title"><textarea id="box" aria-label="Notes"></textarea><button>Save</button></form>`, focus: "#title", type: ["#box", "one\n"], want: "passes" },
  { what: "a line break typed into the search box that has the focus", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button>Search</button></form>`, focus: "#q", type: ["#q", "lamps\n"], want: "passes" },

  // In a card region, a control with an option, tab or switch role pays like a button.
  { what: 'an option that says "Use this card" in a card region', html: CARD_REGION(`<div id="t" role="option" tabindex="0">Use this card</div>`), click: "#t", want: "held as Money" },
  { what: "a tab in a card region", html: CARD_REGION(`<div id="t" role="tab" tabindex="0">Card ending 4242</div>`), click: "#t", want: "held as Money" },
  { what: "a switch in a card region", html: CARD_REGION(`<div id="t" role="switch" tabindex="0" aria-checked="false">One-click pay</div>`), click: "#t", want: "held as Money" },

  // Card fields inside a web component.
  { what: '"Continue" beside card fields that sit in a component\'s shadow root', html: `<section><card-fields></card-fields><button id="t" type="button">Continue</button></section>`,
    setup: shadow("card-fields", `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">`), click: "#t", want: "held as Money" },
  { what: '"Continue" inside the same shadow root as the card fields', html: `<checkout-box id="host"></checkout-box>`,
    setup: shadow("checkout-box", `<input aria-label="Card number" autocomplete="cc-number"><button id="go" type="button">Continue</button>`),
    pick: () => (page.querySelector("#host") as unknown as { shadowRoot: { querySelector(selector: string): El } }).shadowRoot.querySelector("#go"), want: "held as Money" },
];

// ── Round five ──
const LOGIN = `<form><input aria-label="Email" value="ada@example.com"><input id="pw" type="password" aria-label="Password"><button>Log in</button></form>`;
/** A page whose only payment element is a frame from another site with this title. */
const beside = (title: string) => `<main><h1>Your order</h1><p>Lamp, $40.00</p><button id="t" type="button">Continue</button><object title="${title}"></object></main>`;
const MESSAGES = `<header><input type="search" aria-label="Search the site"><nav><input aria-label="Jump to a page"></nav></header>
  <div id="box" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Write a message">Hello</div><footer><input aria-label="Newsletter email"></footer>`;
const MAIL = `<header><input type="search" aria-label="Search mail"></header><form><input aria-label="To" value="ada@example.com"><input aria-label="Subject" value="Lunch"><textarea id="box" aria-label="Body">At one?</textarea><button>Send</button></form>`;

const LATER: Op[] = [
  // Text with a line break, typed at a field that was not clicked first: the way a bot usually types.
  { what: "a search typed with a line break at a box that was not clicked first", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button>Search</button></form><button id="other" type="button">Help</button>`, focus: "#other", type: ["#q", "lamps\n"], want: "passes" },
  { what: "a password typed with a line break at a field that was not clicked first", html: LOGIN, type: ["#pw", "correct-horse\n"], want: "passes" },
  { what: "a note typed with a line break at a box that was not clicked first", html: NOTES, focus: "#t", type: ["#box", "Bring the charger\n"], want: "passes" },
  { what: "a message typed with a line break at a chat composer that was not clicked first", html: CHAT, focus: "#send", type: ["#box", "On my way\n"], want: "held as Send" },
  { what: "a line break typed at a field under an inert parent while a payment form has the focus", html: `<div inert><form><input id="off" aria-label="Notes"></form></div><form><input id="amount" aria-label="Amount"><button>Pay now</button></form>`, focus: "#amount", type: ["#off", "x\n"], want: "refused" },
  { what: "several lines typed at a notes box that was not clicked first", html: NOTES, focus: "#t", type: ["#box", "one\ntwo\n"], want: "refused" },

  // A frame that speaks of payment and is no known brand's message or button.
  ...["Checkout", "Payment", "Secure payment"].map((title): Op => ({ what: `"Continue" beside a frame titled "${title}"`, html: beside(title), click: "#t", want: "held as Money" })),
  ...["Klarna On-site messaging", "PayPal Message", "Google Pay button", "Donate with PayPal button"].map((title): Op => ({ what: `"Continue" beside a frame titled "${title}"`, html: beside(title), click: "#t", want: "passes" })),

  // An address a browser reads as a script, written so as not to look like one.
  { what: 'a "Pay now" link whose address is java, a tab, script:', html: `<p><a id="t" href="java\tscript:pay()">Pay now</a></p>`, click: "#t", want: "held as Money" },
  { what: 'a "Send" link whose address starts with a line break and spaces before javascript:', html: `<p><a id="t" href="\n  javascript:send()">Send</a></p>`, click: "#t", want: "held as Send" },
  { what: 'a "Send" link with a data: address', html: `<p><a id="t" href="data:text/html,<p>sent</p>">Send</a></p>`, click: "#t", want: "held as Send" },
  { what: 'a "Pay now" link with a vbscript: address', html: `<p><a id="t" href="vbscript:pay">Pay now</a></p>`, click: "#t", want: "held as Money" },

  // A message box on a page with a search in its header.
  { what: "Enter in a message box on a page with a header search and no region around the box", html: MESSAGES, focus: "#box", press: "Enter", want: "held as Send" },
  { what: "Enter in the body of a mail form with To and Subject fields", html: MAIL, focus: "#box", press: "Enter", want: "passes" },
];

// ── Round six ──
/** A form whose button is disabled until its field has text, and the page's script that enables it. */
const gated = (field: string, button: string) => `<form><input id="f" aria-label="${field}"><button id="b" disabled>${button}</button></form>`;
const enable = () => { (page.querySelector("#b") as unknown as { removeAttribute(name: string): void }).removeAttribute("disabled"); };
/** A shop page with one frame from another site, and a button and a link on the page itself. */
const shopWith = (frame: string) => `<main><h1>Desk lamp</h1><p>$40.00</p><button id="t" type="button">Add to cart</button> <a id="l" href="/tickets">Buy tickets for the launch</a>${frame}</main>`;

const LATEST: Op[] = [
  // Text and its Enter never go to the engine together: what Enter does is judged once the text is in.
  { what: "text with a line break typed at a focused field whose Pay now button is disabled until the field has text", html: gated("Amount", "Pay now"), focus: "#f", type: ["#f", "hello\n"], reacts: enable, want: "held as Money" },
  { what: "the same, at a field that was not clicked first", html: gated("Amount", "Pay now"), type: ["#f", "hello\n"], reacts: enable, want: "held as Money" },
  { what: "text with a line break typed at a focused field whose Send button is disabled until the field has text", html: gated("Ask anything", "Send"), focus: "#f", type: ["#f", "hello\n"], reacts: enable, want: "held as Send" },
  { what: "the same Send, at a field that was not clicked first", html: gated("Ask anything", "Send"), type: ["#f", "hello\n"], reacts: enable, want: "held as Send" },
  { what: "a search typed with a carriage return and a line feed at its end", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button>Search</button></form>`, type: ["#q", "lamps\r\n"], want: "passes" },
  { what: "a search typed with a carriage return at its end, at a box that has the focus", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button>Search</button></form>`, focus: "#q", type: ["#q", "lamps\r"], want: "passes" },

  // A wallet or pay-later frame does not make the page ask.
  ...["Shop Pay", "Donate with PayPal", "PayPal", "Apple Pay", "Google Pay", "Amazon Pay", "Klarna", "Afterpay", "Affirm", "Pay later with Affirm"].map((title): Op => ({ what: `"Add to cart" beside a frame titled "${title}"`, html: shopWith(`<object title="${title}"></object>`), click: "#t", want: "passes" })),
  { what: 'a link beside a frame titled "Shop Pay"', html: shopWith(`<object title="Shop Pay"></object>`), click: "#l", want: "passes" },
  // Nor does a word in a frame's address.
  { what: '"Add to cart" beside a reviews widget with "pay" only in its address', html: shopWith(`<object title="Reviews" data="https://widgets.example.com/pay/embed?id=7"></object>`), click: "#t", want: "passes" },
  { what: 'a link beside an advert with "checkout" only in its address', html: shopWith(`<object title="Advertisement" data="https://ads.example.com/checkout/banner"></object>`), click: "#l", want: "passes" },
  { what: 'a "Continue" inside a widget frame with "pay" only in its address', html: shopWith(`<object title="Reviews" data="https://widgets.example.com/pay/embed?id=7"></object>`), inFrame: { role: "button", name: "Continue" }, want: "passes" },
  // A frame that calls itself payment or checkout does, for every button around it.
  ...["Payment button frame", "Checkout message", "Onsite checkout", "Secure express checkout frame", "PayPal card fields", "Klarna payments"].map((title): Op => ({ what: `"Add to cart" beside a frame titled "${title}"`, html: shopWith(`<object title="${title}"></object>`), click: "#t", want: "held as Money" })),
  { what: '"Add to cart" beside an untitled frame served from a processor\'s hosted card field', html: shopWith(`<object data="https://js.stripe.com/v3/elements-inner-card-19.html"></object>`), click: "#t", want: "held as Money" },
  // A click inside a wallet frame is still money.
  { what: 'a "Continue" inside a frame titled "Shop Pay"', html: shopWith(`<object title="Shop Pay"></object>`), inFrame: { role: "button", name: "Continue" }, want: "held as Money" },
];

// ── Round seven ──
const LAST: Op[] = [
  // Enter in a field is judged by the form's submit button even while that is disabled: a page can enable it a moment later.
  { what: "text with a line break typed at a field whose Pay now button is still disabled", html: gated("Amount", "Pay now"), type: ["#f", "hello\n"], want: "held as Money" },
  { what: "Enter in a field whose Pay now button is still disabled", html: gated("Amount", "Pay now"), focus: "#f", press: "Enter", want: "held as Money" },
  { what: "text with a line break typed at a field whose Send button is still disabled", html: gated("Ask anything", "Send"), focus: "#f", type: ["#f", "hello\n"], want: "held as Send" },
  { what: "a search typed with a line break while its Search button is still disabled", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button disabled>Search</button></form>`, type: ["#q", "lamps\n"], want: "passes" },
  { what: "a password typed with a line break while the Log in button is still disabled", html: `<form><input aria-label="Email" value="ada@example.com"><input id="pw" type="password" aria-label="Password"><button disabled>Log in</button></form>`, type: ["#pw", "correct-horse\n"], want: "passes" },
  { what: "Enter in a profile field while Save changes is still disabled", html: `<form><input id="f" aria-label="Name" value="Ada"><button disabled>Save changes</button></form>`, focus: "#f", press: "Enter", want: "passes" },
  { what: "Enter in a filter field while Apply is still disabled", html: `<form><input id="f" aria-label="Max price" value="50"><button disabled>Apply</button></form>`, focus: "#f", press: "Enter", want: "passes" },
  // A known address counts by the host a frame is served from.
  { what: '"Add to cart" beside a frame titled "Checkout" whose address only mentions a wallet button\'s address', html: shopWith(`<object title="Checkout" data="https://shop.example.com/embed?next=https://pay.google.com/gp/p/ui/pay"></object>`), click: "#t", want: "held as Money" },
  { what: '"Add to cart" beside a frame titled "Checkout" on a host that only starts like a wallet\'s', html: shopWith(`<object title="Checkout" data="https://pay.google.com.evil.example/gp/p/ui/pay"></object>`), click: "#t", want: "held as Money" },
  { what: '"Add to cart" beside an untitled frame served from a wallet button\'s own address', html: shopWith(`<object data="https://pay.google.com/gp/p/ui/pay?x=1"></object>`), click: "#t", want: "passes" },
  { what: '"Add to cart" beside an untitled frame whose address only mentions a card-field host', html: shopWith(`<object data="https://cdn.example.com/x?u=https://js.stripe.com/v3/elements-inner-card-19.html"></object>`), click: "#t", want: "passes" },
  // Several lines at a one-line field that has the focus.
  { what: "several lines typed at a one-line field that has the focus", html: `<form role="search"><input id="q" type="search" aria-label="Search"><button>Search</button></form>`, focus: "#q", type: ["#q", "lamps\nand shades\n"], want: "refused" },
];

describe("ordinary operations, round seven", () => {
  it.each(LAST.map((op) => [op.want, op.what, op] as const))("%s: %s", async (want, _what, op) => {
    expect(await outcomeOf(op)).toBe(want);
  });
});

describe("ordinary operations, round six", () => {
  it.each(LATEST.map((op) => [op.want, op.what, op] as const))("%s: %s", async (want, _what, op) => {
    expect(await outcomeOf(op)).toBe(want);
  });
});

describe("ordinary operations, round five", () => {
  it.each(LATER.map((op) => [op.want, op.what, op] as const))("%s: %s", async (want, _what, op) => {
    expect(await outcomeOf(op)).toBe(want);
  });
});

describe("ordinary operations the first table missed", () => {
  it("has a row for each group", () => {
    expect(GAPS.length).toBeGreaterThanOrEqual(50);
    expect(new Set(GAPS.map((op) => op.what)).size).toBe(GAPS.length);
  });

  it.each(GAPS.map((op) => [op.want, op.what, op] as const))("%s: %s", async (want, _what, op) => {
    expect(await outcomeOf(op)).toBe(want);
  });
});

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
