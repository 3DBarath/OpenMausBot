// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { browserPageReader, pageReadScript, parsePageDetail, parsePageTarget, type EngineQuery } from "./browser-commit-page.ts";
import { classifyCommit, type CommitTarget } from "../shared/browser-commit.ts";

/** The server's types carry no DOM. This is all of happy-dom the test touches. */
interface PageElement { focus(): void }
const page = (globalThis as unknown as { document: { body: { innerHTML: string }; getElementById(id: string): PageElement | null } }).document;

afterEach(() => { page.body.innerHTML = ""; });

const PAGE = `
  <form id="message-form"><label for="msg">Message</label><textarea id="msg" name="body">Hello there</textarea>
    <input type="hidden" name="csrf" value="tok"><button type="submit" id="send"><span id="send-text">Send</span></button></form>
  <form id="login-form"><label for="user">Username</label><input id="user" type="text" value="omkar">
    <label for="pw">Password</label><input id="pw" type="password" value="hunter2-SECRET"><button id="login">Log in</button></form>
  <form id="search-form" role="search"><input id="q" type="search" aria-label="Search" value="shoes"><button id="go">Search</button></form>
  <form id="pay-form"><label for="cc">Card number</label><input id="cc" autocomplete="cc-number" value="4111111111111111">
    <input id="exp" autocomplete="cc-exp" aria-label="Expiry" value="12/30"><button id="continue">Continue</button></form>
  <div id="composer" contenteditable="true" role="textbox" aria-label="Write a message">draft text</div>
  <div id="icon" role="button" tabindex="0" aria-label="Send message"></div>
  <input id="single" type="text" aria-label="Quick note">
  <label id="news"><input id="news-box" type="checkbox"> Subscribe to the newsletter</label>
  <a id="share" href="#share">Share</a>`;

/** Run one of the two fixed scripts the way the engine's eval does: as one expression. */
type Asked = Omit<Parameters<typeof pageReadScript>[0], "detail">;
const script = (input: Parameters<typeof pageReadScript>[0]) => new Function(`return ${pageReadScript(input)}`)() as Record<string, unknown>;
/** The first read: what the call would act on. */
const light = (input: Asked) => script({ ...input, detail: false });
/** The second read: the evidence, one part for each element described. */
const detail = (input: Asked) => script({ ...input, detail: true }) as { found: boolean; parts?: Array<Record<string, unknown>>; secrets?: boolean };
/** Both reads as one description: each element with its own evidence. */
const run = (input: Asked) => {
  const target = light(input);
  if (target.found !== true) return target;
  const evidence = detail(input);
  const [first, ...rest] = evidence.parts ?? [];
  const also = (target.also as Array<Record<string, unknown>> | undefined)?.map((each, index) => ({ ...each, ...rest[index] }));
  return { ...target, ...first, secrets: evidence.secrets, ...(also ? { also } : {}) } as Record<string, unknown>;
};
/** happy-dom lays nothing out, so the element the engine "measured" gets a
 * box of its own. The read asks the prototype, never the element (a page
 * can shadow an element's own properties), so the stand-in sits there too. */
const boxes = new WeakMap<object, { x: number; y: number; width: number; height: number }>();
const layout = (globalThis as unknown as { Element: { prototype: { getBoundingClientRect(): unknown } } }).Element.prototype;
const measure = layout.getBoundingClientRect;
beforeAll(() => { layout.getBoundingClientRect = function (this: object) { return boxes.get(this) ?? measure.call(this); }; });
afterAll(() => { layout.getBoundingClientRect = measure; });
function boxOf(id: string, box = { x: 40, y: 80, width: 120, height: 24 }) {
  boxes.set(page.getElementById(id)!, box);
  return box;
}
const focus = (id: string) => { page.body.innerHTML = PAGE; page.getElementById(id)!.focus(); return run({ box: null, enter: true }); };
const click = (id: string) => { page.body.innerHTML = PAGE; return run({ box: boxOf(id), enter: false }); };
/** The same two reads on a page of the test's own. */
const focusIn = (html: string, id: string) => { page.body.innerHTML = html; page.getElementById(id)!.focus(); return run({ box: null, enter: true }); };
const clickIn = (html: string, id: string) => { page.body.innerHTML = html; return run({ box: boxOf(id), enter: false }); };
/** What the browser's own DOM classes look like from a test. */
const dom = globalThis as unknown as Record<string, { prototype: object }>;
/** Swap one prototype member for the length of a test. */
function patched<T>(proto: object, name: string, descriptor: PropertyDescriptor, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { configurable: true, ...descriptor });
  try { return body(); }
  finally { if (original) Object.defineProperty(proto, name, original); else delete (proto as Record<string, unknown>)[name]; }
}

describe("the fixed page read", () => {
  it("describes a submit button with its form's visible fields, and never a hidden one", () => {
    expect(click("send")).toEqual({
      // The page has a password field and a card field elsewhere on it.
      found: true, label: "Send", role: "button", box: null, submits: true, search: false, card: false, multiline: true, secrets: true, frames: false,
      button: true, changes: false, typable: false, field: false, reach: false, payFrame: false, inPay: false, lang: "",
      // Not a plain link, not a sign-in; the form has a box of many lines, so something is being submitted.
      link: false, signin: false, carries: true, opaque: false,
      fields: [{ name: "Message", type: "textarea", value: "Hello there" }], others: 0,
      // The form's own fields say what it is; there is nothing around it to add.
      identity: expect.stringMatching(/^html:0\/body:\d+\/form:0\/button:\d+#[0-9a-f]{16}$/), context: "",
      bound: expect.stringMatching(/^[0-9a-f]{16}$/), around: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("finds the control from an element inside it", () => {
    expect(click("send-text")).toMatchObject({ found: true, label: "Send", role: "button", submits: true });
  });

  it("reads only the length of a password", () => {
    const read = click("login");
    expect(read).toMatchObject({ label: "Log in", submits: true, multiline: false, card: false });
    expect(read.fields).toEqual([{ name: "Username", type: "text", value: "omkar" }, { name: "Password", type: "password", length: 14 }]);
    expect(JSON.stringify(read)).not.toContain("hunter2");
  });

  it("flags a card form and reads only the length of the card number", () => {
    const read = click("continue");
    expect(read).toMatchObject({ label: "Continue", submits: true, card: true });
    expect(read.fields).toEqual([{ name: "Card number", type: "card", length: 16 }, { name: "Expiry", type: "card", length: 5 }]);
    expect(JSON.stringify(read)).not.toContain("12/30");
  });

  it("marks search, whether by the form's role or its only field", () => {
    expect(click("go")).toMatchObject({ label: "Search", submits: true, search: true });
    page.body.innerHTML = `<form><input id="only" type="search" aria-label="Find"><button id="find">Go</button></form>`;
    expect(run({ box: boxOf("find"), enter: false })).toMatchObject({ submits: true, search: true });
  });

  it("describes controls outside any form by their own label and role", () => {
    // With no form and no region around it, the page is its region, and this page has a card form.
    expect(click("icon")).toMatchObject({ found: true, label: "Send message", role: "button", submits: false, multiline: false, card: true, search: false });
    expect(clickIn(PAGE.replace(/<form id="pay-form">.*?<\/form>/s, ""), "icon")).toMatchObject({ label: "Send message", card: false });
    expect(click("share")).toMatchObject({ label: "Share", role: "link", submits: false });
    expect(click("news")).toMatchObject({ label: "Subscribe to the newsletter", role: "checkbox" });
  });

  it("says a click into a text box lands in a text box", () => {
    expect(click("msg")).toMatchObject({ label: "Message", role: "textbox", box: "multiline", submits: false });
    expect(click("composer")).toMatchObject({ label: "Write a message", role: "textbox", box: "multiline", submits: false, multiline: true, button: false, search: false });
  });

  // The test page has no dialog or region, so "around it" is the page: its
  // six other filled fields (a message, a username, a password, a search, a
  // card number and an expiry) are the rest of the page. They are counted,
  // and bound, and never listed.
  it("shows a box outside any form, and counts the filled fields elsewhere on the page instead of listing them", () => {
    expect(click("composer")).toMatchObject({ fields: [{ name: "Write a message", type: "contenteditable", value: "draft text" }], others: 6 });
  });

  it("lists nothing for a button with no form and no region, and counts every filled field on the page", () => {
    const read = click("icon");
    expect(read).toMatchObject({ fields: [], others: 7 });
    expect(JSON.stringify(read)).not.toMatch(/omkar|shoes|Hello there|draft text/);
    // What it counts it is bound to: a change to any of them is a change.
    page.body.innerHTML = PAGE.replace('value="omkar"', 'value="someone-else"');
    expect(run({ box: boxOf("icon"), enter: false }).bound).not.toBe(read.bound);
    page.body.innerHTML = PAGE;
    expect(run({ box: boxOf("icon"), enter: false }).bound).toBe(read.bound);
  });

  it("answers found: false for a box no element has", () => {
    page.body.innerHTML = PAGE;
    expect(run({ box: { x: 900, y: 900, width: 5, height: 5 }, enter: false })).toEqual({ found: false, frames: false, payFrame: false, inPay: false });
  });

  it("reads Enter in a message box as typed there", () => {
    expect(focus("composer")).toMatchObject({ label: "Write a message", role: "textbox", box: "multiline", submits: false, multiline: true, search: false, button: false });
    expect(focus("msg")).toMatchObject({ label: "Message", box: "multiline", submits: false });
  });

  it("reads Enter in a one-line field as its form's submit button", () => {
    expect(focus("pw")).toMatchObject({ label: "Log in", role: "button", box: "single", submits: true });
    expect(focus("cc")).toMatchObject({ label: "Continue", role: "button", box: "single", submits: true, card: true });
    expect(focus("q")).toMatchObject({ label: "Search", box: "search", submits: true, search: true });
  });

  it("reads Enter outside any form, or with nothing focused, as acting on nothing", () => {
    expect(focus("single")).toMatchObject({ label: "Quick note", role: "textbox", box: "single", submits: false });
    page.body.innerHTML = PAGE;
    expect(run({ box: null, enter: true })).toMatchObject({ found: true, role: "document", label: "", submits: false });
  });

  it("applies the Enter reading to a selector's element too, for text typed with a line break", () => {
    page.body.innerHTML = PAGE;
    expect(run({ box: boxOf("user"), enter: true })).toMatchObject({ label: "Log in", role: "button", box: "single", submits: true });
  });
});

describe("Enter on a form control", () => {
  const BUY = `<form id="buy-form"><label><input id="agree" type="checkbox"> I agree</label><label><input id="gift" type="radio" name="wrap"> Gift wrap</label>
    <select id="size" aria-label="Size"><option>S</option><option>M</option></select><input id="qty" type="range" aria-label="Quantity">
    <button id="save" type="button">Save for later</button><button id="buy">Buy now</button><button id="ask" name="alt">Ask a question</button></form>`;

  // Chrome submits the form through its default button from any of these
  // (agent-browser 0.37.0: tick "I agree", press Enter, "Buy now" fires).
  it.each(["agree", "gift", "size", "qty"])("reads Enter on #%s as the form's default submit button", (id) => {
    expect(focusIn(BUY, id)).toMatchObject({ found: true, label: "Buy now", role: "button", box: null, submits: true });
  });

  it("reads Enter on a focused button as that button, never the default one", () => {
    expect(focusIn(BUY, "ask")).toMatchObject({ label: "Ask a question", role: "button", submits: true });
    expect(focusIn(BUY, "save")).toMatchObject({ label: "Save for later", role: "button", submits: false });
  });

  it("leaves a control that is in no form, or whose form has no submit button, as it is", () => {
    expect(focusIn(`<input id="lone" type="checkbox" aria-label="Remember me">`, "lone")).toMatchObject({ label: "Remember me", role: "checkbox", submits: false });
    expect(focusIn(`<form><textarea>draft</textarea><input id="opt" type="checkbox" aria-label="Urgent"></form>`, "opt")).toMatchObject({ label: "Urgent", role: "checkbox", submits: false });
  });
});

describe("a form's submit control", () => {
  const ORDER = `<form id="order"><input id="name" aria-label="Name" value="Ada"><input id="card" aria-label="Card number" autocomplete="cc-number" value="4111111111111111">
    <input id="go" type="image" alt="Continue" src="x.gif"></form>
    <form id="ext"><textarea aria-label="Comment">Nice</textarea><input id="who" aria-label="Name" value="Ada"><input id="mail" aria-label="Email" value="a@b.c"></form><button form="ext" id="outside">Go</button>`;
  /** form.elements as Chrome answers it: an image button is not in it. */
  const likeChrome = <T,>(body: () => T): T => {
    const elements = Object.getOwnPropertyDescriptor(dom.HTMLFormElement!.prototype, "elements")!;
    return patched(dom.HTMLFormElement!.prototype, "elements", {
      get(this: object) { return Array.from(elements.get!.call(this) as Iterable<{ tagName: string; type: string }>).filter((el) => !(el.tagName === "INPUT" && el.type === "image")); },
    }, body);
  };

  it("finds an image button although form.elements leaves it out", () => {
    likeChrome(() => {
      expect(focusIn(ORDER, "name")).toMatchObject({ label: "Continue", role: "button", box: "single", submits: true, card: true });
      expect(clickIn(ORDER, "go")).toMatchObject({ label: "Continue", role: "button", submits: true, card: true });
    });
  });

  it("finds a button tied to the form by its form attribute", () => {
    likeChrome(() => {
      expect(focusIn(ORDER, "who")).toMatchObject({ label: "Go", role: "button", submits: true, multiline: true });
      expect(clickIn(ORDER, "outside")).toMatchObject({ label: "Go", submits: true, multiline: true, fields: expect.arrayContaining([{ name: "Comment", type: "textarea", value: "Nice" }]) });
    });
  });
});

describe("a control whose own handler submits its form", () => {
  const form = (control: string) => `<form id="quick"><textarea aria-label="Message">Running late</textarea>${control}</form>`;

  it("judges a select, checkbox or radio as the form's submit when its inline handler submits", () => {
    expect(clickIn(form(`<select id="when" aria-label="When" onchange="this.form.requestSubmit()"><option>later</option><option>now</option></select>`), "when"))
      .toMatchObject({ label: "When", role: "combobox", submits: true, multiline: true });
    expect(clickIn(form(`<input id="notify" type="checkbox" aria-label="Notify me" onchange="this.form.submit()">`), "notify")).toMatchObject({ role: "checkbox", submits: true });
    expect(clickIn(form(`<input id="pick" type="radio" aria-label="Fast" oninput="document.forms[0].submit ()">`), "pick")).toMatchObject({ role: "radio", submits: true });
  });

  it("looks at the form's own inline handler too, and acts through the default button when there is one", () => {
    const html = `<form id="quick" onchange="submit()"><select id="when" aria-label="When"><option>later</option></select><button>Send now</button></form>`;
    expect(clickIn(html, "when")).toMatchObject({ label: "Send now", role: "button", submits: true });
  });

  it("does not guess about a handler that shows no submit", () => {
    expect(clickIn(form(`<select id="when" aria-label="When" onchange="updateTotal(this)"><option>later</option></select>`), "when")).toMatchObject({ label: "When", role: "combobox", submits: false });
    expect(clickIn(form(`<select id="when" aria-label="When"><option>later</option></select>`), "when")).toMatchObject({ submits: false });
  });
});

describe("names a form control can take", () => {
  // In a browser a control named "tagName" makes form.tagName that control
  // (named access on a form shadows its built-in properties). happy-dom does
  // not do that by itself, so the test puts the same own properties there.
  const NAMES = ["tagName", "elements", "action", "id", "closest", "querySelectorAll"];
  const CLOBBERED = `<form id="clob">${NAMES.map((name) => `<input id="c-${name}" name="${name}" value="${name}">`).join("")}
    <textarea id="feedback" aria-label="Feedback">Great</textarea><button id="go">Go</button></form>`;
  const shadow = () => {
    const form = page.getElementById("clob")!;
    for (const name of NAMES) Object.defineProperty(form, name, { configurable: true, value: page.getElementById(`c-${name}`) });
  };

  it("still sees the form, its fields and its submit button", () => {
    page.body.innerHTML = CLOBBERED;
    shadow();
    expect(String((page.getElementById("clob") as unknown as { tagName: unknown }).tagName)).not.toBe("FORM");
    const read = run({ box: boxOf("go"), enter: false });
    expect(read).toMatchObject({ found: true, label: "Go", role: "button", submits: true, multiline: true });
    expect(read.fields).toEqual(expect.arrayContaining([{ name: "Feedback", type: "textarea", value: "Great" }]));
    expect((read.fields as unknown[]).length).toBe(NAMES.length + 1);
  });

  it("still reads Enter in one of those fields as the form's submit", () => {
    page.body.innerHTML = CLOBBERED;
    shadow();
    page.getElementById("c-action")!.focus();
    expect(run({ box: null, enter: true })).toMatchObject({ label: "Go", role: "button", submits: true, multiline: true });
  });
});

describe("two elements in one box", () => {
  const STACK = `<div><button id="vis" type="button">Send</button><button id="hid" type="button" style="visibility:hidden">Cancel</button></div>`;
  const stacked = (hit: string | null) => {
    page.body.innerHTML = STACK;
    const box = boxOf("hid", boxOf("vis"));
    // The document's own class, so the stand-in is the first one the read finds.
    return patched(Object.getPrototypeOf(page) as object, "elementFromPoint", { value: () => (hit ? page.getElementById(hit) : null) }, () => run({ box, enter: false }));
  };

  it("describes the one a hit test at the centre of the box returns", () => {
    expect(stacked("vis")).toMatchObject({ found: true, label: "Send" });
    expect(stacked("vis")).not.toHaveProperty("also");
    expect(stacked("hid")).toMatchObject({ found: true, label: "Cancel" });
  });

  it("describes every one of them when the hit test settles nothing", () => {
    const read = stacked(null) as { label: string; also?: Array<{ label: string }> };
    expect([read.label, ...(read.also ?? []).map((other) => other.label)].sort()).toEqual(["Cancel", "Send"]);
  });

  it("describes a control once, whether its wrapper or its only child shares its box", () => {
    page.body.innerHTML = `<div id="wrap"><button id="send"><span id="text">Send</span></button></div>`;
    const box = boxOf("text", boxOf("wrap", boxOf("send")));
    const read = run({ box, enter: false });
    expect(read).toMatchObject({ found: true, label: "Send", role: "button" });
    expect(read).not.toHaveProperty("also");
  });
});

describe("which element it is", () => {
  const SHOP = `<ul id="list"><li id="row1">Sticker $1 <button id="b1" type="button">Buy now</button></li><li id="row2">Laptop $18,000 <button id="b2" type="button">Buy now</button></li></ul>`;

  it("tells two buttons with the same label apart by where they are, and shows what is around each", () => {
    const first = clickIn(SHOP, "b1");
    const second = clickIn(SHOP, "b2");
    expect(first).toMatchObject({ label: "Buy now", context: "Sticker $1 Buy now" });
    expect(second).toMatchObject({ label: "Buy now", context: "Laptop $18,000 Buy now" });
    expect(first.identity).toMatch(/^html:0\/body:\d+\/ul:0\/li:0\/button:0#[0-9a-f]{16}$/);
    expect(second.identity).toMatch(/\/li:1\/button:0#[0-9a-f]{16}$/);
  });

  it("gives the same element the same identity twice, and another one once its own markup changes", () => {
    const first = clickIn(SHOP, "b1").identity;
    expect(run({ box: boxOf("b1"), enter: false }).identity).toBe(first);
    (page.getElementById("b1") as unknown as { setAttribute(name: string, value: string): void }).setAttribute("formaction", "/buy-everything");
    const changed = run({ box: boxOf("b1"), enter: false }).identity as string;
    expect(changed.split("#")[0]).toBe(String(first).split("#")[0]);
    expect(changed).not.toBe(first);
  });

  it("identifies both the focused field and the button Enter would press", () => {
    const read = focus("user");
    expect(read.identity).toMatch(/\/form:\d+\/input:\d+#[0-9a-f]{16} \S+\/form:\d+\/button:\d+#[0-9a-f]{16}$/);
  });

  it.each([
    ["a table row", `<table><tbody><tr><td>Invoice 7</td> <td>$40</td> <td><button id="b" type="button">Pay</button></td></tr><tr><td>Invoice 8</td> <td>$900</td> <td><button type="button">Pay</button></td></tr></tbody></table>`, "Invoice 7 $40 Pay"],
    ["an article", `<article><h2>Trip to Pune</h2> <p>Two nights</p> <button id="b" type="button">Book</button></article><article><h2>Trip to Goa</h2> <button type="button">Book</button></article>`, "Trip to Pune Two nights Book"],
    ["a dialog", `<div role="dialog" aria-label="Confirm"><p>Delete 3 files and send the report?</p> <div><span><button id="b" type="button">Send</button></span></div></div>`, "Delete 3 files and send the report? Send"],
    ["a card with no role, by the nearest wrapper that says more than the button", `<div class="tile"><div><b>Plan Pro</b> $89 a month</div> <div><button id="b" type="button">Subscribe</button></div></div>`, "Plan Pro $89 a month Subscribe"],
  ])("takes the context from %s", (_what, html, context) => {
    expect(clickIn(html, "b").context).toBe(context);
  });

  it("gives no context when the nearest text is a whole page, and bounds what it gives", () => {
    expect(clickIn(`<main><p>${"All the news of the day. ".repeat(60)}</p><button id="b" type="button">Share</button></main>`, "b").context).toBe("");
    const long = clickIn(`<div role="dialog"><p>${"Terms and conditions apply. ".repeat(60)}</p><button id="b" type="button">Send</button></div>`, "b").context as string;
    expect(long).toHaveLength(300);
    expect(long.startsWith("Terms and conditions apply.")).toBe(true);
  });
});

describe("a button with no form around it", () => {
  const DM = `<nav><input id="find" type="search" aria-label="Search" value="invoices"></nav>
    <div id="dialog" role="dialog" aria-label="New message"><input id="to" aria-label="To" value="ada@example.com"><input id="cc" aria-label="Cc" value="">
      <input id="secret" type="hidden" value="token"><input id="gone" aria-label="Old" value="stale" style="display:none">
      <div id="body" contenteditable="true" role="textbox" aria-label="Message body">Lunch at one?</div><div id="send" role="button" tabindex="0">Send</div></div>`;

  it("collects the filled, visible fields of the dialog it is in, and nothing outside it", () => {
    const read = clickIn(DM, "send");
    expect(read).toMatchObject({ label: "Send", role: "button", submits: false, multiline: false, card: false, search: false });
    expect(read.fields).toEqual([
      { name: "To", type: "text", value: "ada@example.com" },
      { name: "Message body", type: "contenteditable", value: "Lunch at one?" },
    ]);
  });

  it("counts the fields of the whole page when there is no dialog or region, and is bound to each of them", () => {
    const plain = DM.replace('role="dialog"', "").replace("<nav>", "<div>").replace("</nav>", "</div>");
    const read = clickIn(plain, "send");
    // Search, To and the message body: filled and shown. Not the empty Cc, the hidden token or the field not displayed.
    expect(read).toMatchObject({ fields: [], others: 3 });
    // What is around a button never decides what the button is.
    expect(read).toMatchObject({ submits: false, multiline: false, search: false });
    for (const [from, to] of [["invoices", "receipts"], ["ada@example.com", "eve@example.com"], ["Lunch at one?", "Lunch at two?"], ['value="token"', 'value="other"'], ['value="stale"', 'value="fresh"']]) {
      expect(clickIn(plain.replace(from!, to!), "send").bound).not.toBe(read.bound);
    }
  });

  it("does the same for Enter in a box there, with the box itself first", () => {
    page.body.innerHTML = DM;
    page.getElementById("body")!.focus();
    expect(run({ box: null, enter: true }).fields).toEqual([
      { name: "Message body", type: "contenteditable", value: "Lunch at one?" },
      { name: "To", type: "text", value: "ada@example.com" },
    ]);
  });
});

describe("values that never leave the page", () => {
  const field = (attrs: string, value: string) => `<input ${attrs} value="${value}">`;
  const form = (fields: string) => `<form id="checkout">${fields}<button id="pay">Pay</button></form>`;
  const read = (fields: string) => clickIn(form(fields), "pay");

  it.each([
    ["a field named cardnumber", field('name="cardnumber" aria-label="Number"', "4000056655665556"), "Number", "card", 16],
    ["a field with the id ccNum", field('id="ccNum"', "4000056655665556"), "ccNum", "card", 16],
    ["a plain CVC field", field('id="cvc" placeholder="CVC"', "9173"), "CVC", "card", 4],
    ["a security code", field('aria-label="Security code"', "9173"), "Security code", "card", 4],
    ["a card's expiry", field('autocomplete="cc-exp" aria-label="Expiry"', "12/30"), "Expiry", "card", 5],
    ["the name on a card", field('autocomplete="section-pay cc-name" aria-label="Name on card"', "ADA LOVELACE"), "Name on card", "card", 12],
    ["a one-time code", field('autocomplete="one-time-code" aria-label="Code from your phone"', "246810"), "Code from your phone", "code", 6],
    ["a verification code", field('name="verificationCode" aria-label="Enter it"', "246810"), "Enter it", "code", 6],
    ["an OTP box", field('id="otp_1"', "2"), "otp_1", "code", 1],
    ["a PIN", field('aria-label="PIN"', "4821"), "PIN", "code", 4],
    ["a password shown as text", field('type="text" id="password" aria-label="Sign-in secret"', "correct-horse"), "Sign-in secret", "password", 13],
    ["a new password", field('type="text" autocomplete="new-password" aria-label="Choose one"', "correct-horse"), "Choose one", "password", 13],
    ["a passcode", field('aria-label="Passcode"', "007007"), "Passcode", "password", 6],
    ["a card number with nothing to name it", field('aria-label="Reference"', "5555 5555 5555 4444"), "Reference", "card", 19],
    ["a card number written with dashes", field('aria-label="Reference"', "4242-4242-4242-4242"), "Reference", "card", 19],
  ])("reads only the length of %s", (_what, html, name, type, length) => {
    const got = read(html);
    expect(got.fields).toEqual([{ name, type, length }]);
    expect(got.secrets).toBe(true);
  });

  it.each([
    ["a city", field('aria-label="City"', "Baramati"), "Baramati"],
    ["a postal PIN code", field('aria-label="PIN code"', "413102"), "413102"],
    ["a pincode", field('name="pincode" aria-label="Pincode"', "413102"), "413102"],
    ["a promo code", field('aria-label="Promo code"', "SAVE10"), "SAVE10"],
    ["sixteen digits that are no card number", field('aria-label="Order number"', "1234567890123456"), "1234567890123456"],
    ["a phone number", field('type="tel" aria-label="Phone"', "+91 98765 43210"), "+91 98765 43210"],
    ["shipping notes", field('name="shipping" aria-label="Shipping"', "leave at door"), "leave at door"],
  ])("still shows %s", (_what, html, value) => {
    const got = read(html);
    expect(got.fields).toEqual([expect.objectContaining({ value })]);
    expect(got.secrets).toBe(false);
  });

  // A message is what the person is asked to approve: its label does not hide it.
  it("shows a multi-line message whatever its label says, unless all of it is a card number", () => {
    expect(read(`<textarea aria-label="Describe your password problem">It will not reset</textarea>`).fields).toEqual([{ name: "Describe your password problem", type: "textarea", value: "It will not reset" }]);
    expect(read(`<textarea aria-label="Notes">4242 4242 4242 4242</textarea>`).fields).toEqual([{ name: "Notes", type: "card", length: 19 }]);
  });
});

describe("a page that must not be pictured", () => {
  const SEND = `<form id="f"><textarea aria-label="Message">Hello</textarea><button id="send">Send</button></form>`;

  it("says so when any visible field on the page is length-only, wherever it is", () => {
    expect(clickIn(SEND, "send").secrets).toBe(false);
    expect(clickIn(`${SEND}<aside><input type="password" aria-label="Password"></aside>`, "send").secrets).toBe(true);
    expect(clickIn(`${SEND}<input aria-label="Card number" value="">`, "send").secrets).toBe(true);
    // The fields of the form being sent are unchanged by what is elsewhere.
    expect(clickIn(`${SEND}<input type="password" aria-label="Password" value="hunter2">`, "send").fields).toEqual([{ name: "Message", type: "textarea", value: "Hello" }]);
  });

  it("does not count a field nobody can see", () => {
    expect(clickIn(`${SEND}<input type="password" aria-label="Password" style="display:none"><input type="hidden" name="cvc" value="1">`, "send").secrets).toBe(false);
  });

  it("looks inside a frame it can read, and takes a payment or sign-in frame it cannot read to hold one", () => {
    // An <object> stands in for the frame: happy-dom loads nothing for one,
    // and to the read it is a frame like any other. It says "IFRAME" here,
    // and what is inside it is whatever sits behind its contentDocument,
    // which the read asks the prototype for.
    const framed = (attrs: string, inner: string | null) => {
      page.body.innerHTML = `${SEND}<object id="frame" ${attrs}></object>`;
      const frame = page.getElementById("frame")!;
      const proto = Object.getPrototypeOf(frame) as object;
      const tagName = Object.getOwnPropertyDescriptor(dom.Element!.prototype, "tagName")!.get!;
      const doc = inner === null ? null : new (globalThis as unknown as { DOMParser: new () => { parseFromString(html: string, type: string): unknown } }).DOMParser().parseFromString(inner, "text/html");
      return patched(proto, "tagName", { get(this: object) { return this === frame ? "IFRAME" : tagName.call(this); } }, () =>
        patched(proto, "contentDocument", { get: () => doc }, () => run({ box: boxOf("send"), enter: false }).secrets));
    };
    expect(framed('title="Comments"', `<body><input aria-label="Name" value="Ada"></body>`)).toBe(false);
    expect(framed('title="Comments"', `<body><input type="password" aria-label="Password"></body>`)).toBe(true);
    expect(framed('title="Video player" src="https://videos.example/embed/7"', null)).toBe(false);
    expect(framed('title="Secure card number input frame" src="https://js.stripe.com/v3/elements-inner-card.html"', null)).toBe(true);
    expect(framed('name="__privateStripeFrame5" src="https://pay.example/x"', null)).toBe(true);
    expect(framed('src="https://accounts.example/signin/challenge"', null)).toBe(true);
    expect(framed('title="Secure card number input frame" style="display:none"', null)).toBe(false);
  });
});

describe("a frame", () => {
  /** An <object> stands in for the frame, as above, under the tag name
   * given. `inner` is the frame's own page, or null for a frame from
   * another site, which nothing here can read. */
  type Doc = { getElementById(id: string): object | null };
  const withFrame = <T,>(html: string, inner: { html: string; focus?: string } | null, body: (frame: PageElement, inside: Doc | null) => T, tag = "IFRAME"): T => {
    page.body.innerHTML = html;
    const frame = page.getElementById("frame")!;
    const proto = Object.getPrototypeOf(frame) as object;
    const tagName = Object.getOwnPropertyDescriptor(dom.Element!.prototype, "tagName")!.get!;
    const doc = inner === null ? null : new (globalThis as unknown as { DOMParser: new () => { parseFromString(html: string, type: string): Doc } }).DOMParser().parseFromString(inner.html, "text/html");
    const focused = doc && inner?.focus ? doc.getElementById(inner.focus) : null;
    const docProto = Object.getPrototypeOf(page) as object;
    const active = (() => { for (let at: object | null = docProto; at; at = Object.getPrototypeOf(at)) { const found = Object.getOwnPropertyDescriptor(at, "activeElement"); if (found) return found.get!; } throw new Error("no activeElement"); })();
    return patched(proto, "tagName", { get(this: object) { return this === frame ? tag : tagName.call(this); } }, () =>
      patched(proto, "contentDocument", { get(this: object) { return this === frame ? doc : null; } }, () =>
        patched(docProto, "activeElement", { get(this: object) { return this === doc ? focused : active.call(this); } }, () => body(frame, doc))));
  };
  const SHOP = `<input id="before" aria-label="Email" value="a@b.c"><object id="frame" tabindex="0" title="Secure payment"></object><button id="help" type="button">Help</button>`;
  const PAY = `<body><form id="pay"><input id="card" aria-label="Card number" autocomplete="cc-number" value="4242424242424242"><button id="go">Pay</button></form><input id="lone" aria-label="Coupon"></body>`;

  // Enter in a payment frame's card field pays (agent-browser 0.37.0, a frame
  // from another origin). The page's own script cannot look into that frame,
  // so it must not answer as if the frame element were the target.
  it("says framed, not a description of the frame element, when the focus is inside a frame it cannot read", () => {
    expect(withFrame(SHOP, null, (frame) => { frame.focus(); return run({ box: null, enter: true }); })).toEqual({ found: false, framed: true, frames: true, payFrame: true, inPay: false });
  });

  it("reads Enter inside a frame it can read as it would anywhere: the form's submit, the card field, the frame it is in", () => {
    const read = withFrame(SHOP, { html: PAY, focus: "card" }, (frame) => { frame.focus(); return run({ box: null, enter: true }); });
    expect(read).toMatchObject({ found: true, label: "Pay", role: "button", box: "single", submits: true, card: true });
    expect(read.fields).toEqual([{ name: "Card number", type: "card", length: 16 }]);
    // The identity says which frame, then where in it.
    expect(read.identity).toMatch(/\/iframe:\d+#[0-9a-f]{16}>html:0\/body:\d+\/form:0\/input:0#[0-9a-f]{16} /);
  });

  it("keeps a formless field inside a readable frame to that frame's own page", () => {
    const read = withFrame(SHOP, { html: PAY, focus: "lone" }, (frame) => { frame.focus(); return run({ box: null, enter: true }); });
    expect(read).toMatchObject({ found: true, label: "Coupon", box: "single", submits: false });
    // The fields around it are the frame's, never the page's outside it.
    expect(JSON.stringify(read.fields)).not.toContain("a@b.c");
  });

  it("reads a readable frame with nothing focused in it as acting on nothing", () => {
    expect(withFrame(SHOP, { html: PAY }, (frame) => { frame.focus(); return run({ box: null, enter: true }); })).toMatchObject({ found: true, role: "document", submits: false });
  });

  // A click on the frame element lands on whatever is inside it at that
  // point, and text typed "into" it goes to whatever has the focus inside.
  it.each([["a click", false], ["typed text", true]])("says framed when the selector of %s is the frame itself, readable or not", (_what, enter) => {
    // A frame called "Secure payment" that cannot be read is taken for a payment frame.
    for (const inner of [null, { html: PAY }]) {
      expect(withFrame(SHOP, inner, () => run({ box: boxOf("frame"), enter }))).toEqual({ found: false, framed: true, frames: true, payFrame: inner === null, inPay: false });
    }
  });

  it("says framed when a click on a wrapper would land on the frame inside it", () => {
    const html = `<div id="wrap"><object id="frame" tabindex="0" title="Secure payment"></object></div>`;
    const read = withFrame(html, null, (frame) => {
      const box = boxOf("wrap", { x: 10, y: 10, width: 300, height: 200 });
      return patched(Object.getPrototypeOf(page) as object, "elementFromPoint", { value: () => frame }, () => run({ box, enter: false }));
    });
    expect(read).toEqual({ found: false, framed: true, frames: true, payFrame: true, inPay: false });
  });

  it("says whether the page has a frame at all, so a caller knows a box can be a frame's own", () => {
    expect(withFrame(SHOP, null, () => run({ box: boxOf("help"), enter: false }))).toMatchObject({ found: true, label: "Help", frames: true });
    expect(clickIn(`<button id="help" type="button">Help</button>`, "help")).toMatchObject({ found: true, frames: false });
  });
});

describe("a card form with no autofill hints", () => {
  const input = (label: string, value = "", attrs = "") => `<input aria-label="${label}" value="${value}" ${attrs}>`;
  const form = (fields: string, button = "Continue") => `<form id="f">${fields}<button id="go">${button}</button></form>`;
  /** The class a click on the form's button gets, from the read alone. */
  const classOf = (html: string) => {
    const read = clickIn(html, "go");
    return { card: read.card, class: classifyCommit({ via: "click", ...(read as unknown as Omit<CommitTarget, "via">) }) };
  };

  it.each([
    // Two signs by name: a card number, and a security code or an expiry.
    ["a card number, an expiry and a CVC", "money", form(input("Name on card", "Ada Lovelace") + input("Card number") + input("Expiry (MM/YY)") + input("CVC"))],
    ["a card number and a security code, by id and placeholder only", "money", form(`<input id="cardNumber"><input placeholder="Security code">`)],
    ["a card number and expiry lists", "money", form(`<input name="ccnum"><select name="exp_month"><option>01</option></select><select name="exp_year"><option>2030</option></select>`)],
    ["a credit card field and a CVV", "money", form(input("Credit card") + input("CVV"))],
    // One value that is a card number, whatever its field is called.
    ["a Luhn-valid number in a field called ref", "money", form(`<input name="ref" id="ref" value="4242 4242 4242 4242">`)],
    // The autofill hint alone, as before.
    ["a field with the cc-number hint", "money", form(`<input autocomplete="cc-number" aria-label="Number">`)],
    // One sign is not a card form.
    ["a library card number and a PIN", null, form(input("Library card number", "20451900") + input("PIN", "4821"), "Log in")],
    ["a gift card code", null, form(input("Gift card code", "GFT-8842-XKQ2"), "Check balance")],
    ["a card number alone", null, form(input("Card number"))],
    ["a CVC alone", null, form(input("CVC"))],
    ["an expiry date alone", null, form(input("Expiry date"))],
    ["sixteen digits that are no card number, in an order number", null, form(input("Order number", "1234567890123456"), "Track")],
    ["an experience field beside a membership card number", null, form(input("Membership card number") + input("Experience"))],
  ] as const)("reads a form with %s as %s", (_what, kind, html) => {
    expect(classOf(html)).toEqual({ card: kind === "money", class: kind });
  });

  it("needs the two signs on two fields, and counts only fields that are shown", () => {
    expect(classOf(form(input("Card number or CVC"))).class).toBeNull();
    expect(classOf(form(input("Card number") + `<input aria-label="CVC" style="display:none">`)).class).toBeNull();
    expect(classOf(form(input("Card number") + `<input type="hidden" name="cvc" value="1">`)).class).toBeNull();
  });

  it("reads Enter in such a form's field as money too, and a click into one of its fields as nothing", () => {
    const html = form(`<input id="num" aria-label="Card number"><input aria-label="CVC">`);
    const entered = focusIn(html, "num");
    expect(classifyCommit({ via: "enter", ...(entered as unknown as Omit<CommitTarget, "via">) })).toBe("money");
    const clicked = clickIn(html, "num");
    expect(classifyCommit({ via: "click", ...(clicked as unknown as Omit<CommitTarget, "via">) })).toBeNull();
  });
});

describe("a long form", () => {
  const LONG = `<form id="long">${Array.from({ length: 35 }, (_, index) => `<input id="f${index + 1}" aria-label="Field ${index + 1}" value="value ${index + 1}">`).join("")}
    <textarea id="essay" aria-label="Essay">${"long ".repeat(4_000)}</textarea><button id="send">Send</button></form>`;

  it("reads every field, each at full length", () => {
    const fields = clickIn(LONG, "send").fields as Array<{ name: string; value: string }>;
    expect(fields).toHaveLength(36);
    expect(fields[32]).toEqual({ name: "Field 33", type: "text", value: "value 33" });
    expect(fields[35]!.value).toHaveLength(20_000);
    expect(fields[35]).not.toHaveProperty("length");
  });
});

describe("round three: a frame the read can look into, clicked", () => {
  const SHOP = `<input id="before" aria-label="Email" value="a@b.c"><object id="frame" tabindex="0" title="Billing"></object><button id="help" type="button">Help</button>`;
  const PAY = `<body><form id="pay"><input id="card" aria-label="Card number" autocomplete="cc-number" value="4242424242424242"><button id="go">Continue</button></form></body>`;
  const tagName = Object.getOwnPropertyDescriptor(dom.Element!.prototype, "tagName")!.get!;
  type Doc = { getElementById(id: string): object | null };
  const inFrame = <T,>(html: string, inner: string | null, body: (inside: Doc | null) => T, tag = "IFRAME"): T => {
    page.body.innerHTML = html;
    const frame = page.getElementById("frame")!;
    const proto = Object.getPrototypeOf(frame) as object;
    const doc = inner === null ? null : new (globalThis as unknown as { DOMParser: new () => { parseFromString(html: string, type: string): Doc } }).DOMParser().parseFromString(inner, "text/html");
    return patched(proto, "tagName", { get(this: object) { return this === frame ? tag : tagName.call(this); } }, () =>
      patched(proto, "contentDocument", { get(this: object) { return this === frame ? doc : null; } }, () => body(doc)));
  };
  const INSIDE = { x: 8, y: 30, width: 61, height: 21 };

  // The engine measures an element inside a frame from the frame's own
  // corner (agent-browser 0.37.0), so its box is looked for in there too.
  it("describes the element inside the frame: its form, its card fields, and which frame", () => {
    const read = inFrame(SHOP, PAY, (inside) => { boxes.set(inside!.getElementById("go")!, INSIDE); return run({ box: INSIDE, enter: false }); });
    expect(read).toMatchObject({ found: true, label: "Continue", role: "button", submits: true, card: true, frames: true });
    expect(read.fields).toEqual([{ name: "Card number", type: "card", length: 16 }]);
    expect(read.identity).toMatch(/\/iframe:\d+#[0-9a-f]{16}>html:0\/body:\d+\/form:0\/button:\d+#[0-9a-f]{16}$/);
  });

  it("describes both when an element out here has the same box as one in there", () => {
    const read = inFrame(SHOP, PAY, (inside) => { boxes.set(inside!.getElementById("go")!, INSIDE); boxOf("help", INSIDE); return run({ box: INSIDE, enter: false }); }) as { label: string; also?: Array<{ label: string; card: boolean }> };
    expect([read.label, ...(read.also ?? []).map((other) => other.label)].sort()).toEqual(["Continue", "Help"]);
  });

  it("says nothing was seen, and that the page has a payment frame, for a box that is only inside a frame it cannot read", () => {
    const pay = SHOP.replace('title="Billing"', 'title="Secure card payment"');
    expect(inFrame(pay, null, () => light({ box: INSIDE, enter: false }))).toEqual({ found: false, frames: true, payFrame: true, inPay: false });
    expect(inFrame(SHOP, null, () => light({ box: INSIDE, enter: false }))).toEqual({ found: false, frames: true, payFrame: false, inPay: false });
  });

  it.each(["IFRAME", "FRAME", "OBJECT", "EMBED"])("treats %s as a frame: the focus inside one it cannot read is framed, a box inside one it can is found", (tag) => {
    expect(inFrame(SHOP, null, () => { page.getElementById("frame")!.focus(); return light({ box: null, enter: true }); }, tag)).toMatchObject({ found: false, framed: true });
    expect(inFrame(SHOP, PAY, (inside) => { boxes.set(inside!.getElementById("go")!, INSIDE); return light({ box: INSIDE, enter: false }); }, tag)).toMatchObject({ found: true, label: "Continue", card: true });
  });
});

describe("round three: text typed with a line break", () => {
  // The engine focuses the selector's element and types. When that element
  // cannot take the focus the keys go to whatever has it (agent-browser
  // 0.37.0: typed at a paragraph, the Enter submitted the form in focus).
  const HTML = `<form id="f"><label id="label" for="to">To</label><input id="to"><textarea id="body" aria-label="Message"></textarea><input id="off" aria-label="Off" disabled>
    <select id="plan" aria-label="Plan"><option>Free</option></select><button id="send">Send</button></form>
    <p id="para">Read this first</p><img id="logo" alt="Logo"><div id="edit" contenteditable="true" aria-label="Note"><p id="line">one</p></div>`;
  /** Text typed at #id, with the focus on #focus (on the same element when not given). */
  const typed = (id: string, focus = id) => { page.body.innerHTML = HTML; page.getElementById(focus)!.focus(); return light({ box: boxOf(id), enter: true }); };

  it.each(["to", "body", "edit"])("says #%s is a text field that will itself take the text, when it already has the focus", (id) => {
    expect(typed(id)).toMatchObject({ found: true, typable: true });
  });

  it.each(["send", "para", "logo", "label", "off", "plan", "line"])("says #%s is not", (id) => {
    expect(typed(id)).toMatchObject({ found: true, typable: false });
  });

  // Round four. The engine focuses the field before it types, and when it
  // cannot (the field is behind a modal, in a disabled fieldset, inert, not
  // visible) its Enter lands on whatever has the focus: measured, on a "Buy
  // now" button. Only a field that already has the focus is sure to take it.
  it.each(["to", "body", "edit"])("says #%s will not take the text while something else has the focus", (id) => {
    expect(typed(id, "send")).toMatchObject({ found: true, typable: false });
    page.body.innerHTML = HTML;
    expect(light({ box: boxOf(id), enter: true })).toMatchObject({ found: true, typable: false });
  });

  // Round five. A text field that does not have the focus is still a text
  // field: the gate can type the text there and judge the Enter afterwards,
  // when the field can take the focus at all.
  it.each(["to", "body", "edit"])("says #%s is a text field the text can be typed at, focused or not", (id) => {
    expect(typed(id)).toMatchObject({ field: true, reach: true, typable: true });
    expect(typed(id, "send")).toMatchObject({ field: true, reach: true, typable: false });
  });

  it.each(["send", "para", "logo", "label", "off", "plan", "line"])("says #%s is no such field", (id) => {
    expect(typed(id)).toMatchObject({ field: false, reach: false });
  });

  it.each([
    ["in a disabled group", `<fieldset disabled><input id="t" aria-label="Notes"></fieldset>`],
    ["under an inert parent", `<div inert><div><input id="t" aria-label="Notes"></div></div>`],
    ["that is not visible", `<input id="t" aria-label="Notes" style="visibility:hidden">`],
    ["that is not displayed", `<div style="display:none"><input id="t" aria-label="Notes"></div>`],
  ])("says a field %s cannot take the focus", (_what, html) => {
    page.body.innerHTML = `${html}<input id="other" aria-label="Amount">`;
    page.getElementById("other")!.focus();
    expect(light({ box: boxOf("t"), enter: true })).toMatchObject({ found: true, field: true, reach: false, typable: false });
  });

  it("knows the focus inside an open shadow root", () => {
    page.body.innerHTML = `<note-box id="host"></note-box><input id="other">`;
    const root = (page.getElementById("host") as unknown as { attachShadow(init: { mode: string }): { innerHTML: string; getElementById(id: string): PageElement } }).attachShadow({ mode: "open" });
    root.innerHTML = `<textarea id="inner" aria-label="Notes"></textarea>`;
    const inner = root.getElementById("inner");
    boxes.set(inner, { x: 5, y: 6, width: 70, height: 20 });
    inner.focus();
    expect(light({ box: { x: 5, y: 6, width: 70, height: 20 }, enter: true })).toMatchObject({ found: true, label: "Notes", typable: true });
    page.getElementById("other")!.focus();
    expect(light({ box: { x: 5, y: 6, width: 70, height: 20 }, enter: true })).toMatchObject({ found: true, typable: false });
  });

  it("says so only of a selector's element read for typing", () => {
    page.body.innerHTML = HTML;
    page.getElementById("to")!.focus();
    expect(light({ box: boxOf("to"), enter: false })).toMatchObject({ found: true, typable: false });
    expect(light({ box: null, enter: true })).toMatchObject({ found: true, typable: false });
  });
});

describe("round three: a card region", () => {
  const CARD = `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">`;
  const classed = (read: Record<string, unknown>, via: "click" | "enter" = "click") => classifyCommit({ via, ...(read as unknown as Omit<CommitTarget, "via">) });

  it.each([
    ["a button that submits nothing", `<button id="go" type="button">Continue</button>`],
    ["an input button", `<input id="go" type="button" value="Next">`],
    ["a div with the button role", `<div id="go" role="button" tabindex="0">Next</div>`],
    ["a link", `<a id="go" href="#next">Next step</a>`],
    ["a menu item", `<div id="go" role="menuitem" tabindex="0">Confirm</div>`],
    ["a plain element with a pointer for a cursor, made focusable", `<div id="go" tabindex="0" style="cursor: pointer">Continue</div>`],
  ])("calls %s in a card form money, by click, Enter and Space, whatever it says", (_what, control) => {
    const html = `<form id="f">${CARD}${control}</form>`;
    const read = clickIn(html, "go");
    expect(read).toMatchObject({ card: true, button: true });
    expect(classed(read)).toBe("money");
    // With the focus on it: Enter, and Space (read as a click at the focus).
    expect(classed(focusIn(html, "go"), "enter")).toBe("money");
    page.body.innerHTML = html;
    page.getElementById("go")!.focus();
    expect(classed(light({ box: null, enter: false }))).toBe("money");
    // The same control beside fields that are no card form is nothing.
    expect(classed(clickIn(`<form id="f"><input aria-label="Name">${control}</form>`, "go"))).toBeNull();
  });

  it.each([
    ["a list", `<select id="go" aria-label="Plan" onchange="choose(this.value)"><option>Monthly</option></select>`, `<select id="go" aria-label="Plan"><option>Monthly</option></select>`],
    ["a tick box", `<input id="go" type="checkbox" aria-label="Save this card" oninput="save(this.checked)">`, `<input id="go" type="checkbox" aria-label="Save this card">`],
  ])("calls %s with a change handler in a card form money, and one with none nothing", (_what, handled, bare) => {
    const read = clickIn(`<form id="f">${CARD}${handled}<button>Pay</button></form>`, "go");
    expect(read).toMatchObject({ card: true, changes: true, button: false });
    expect(classed(read)).toBe("money");
    const quiet = clickIn(`<form id="f">${CARD}${bare}<button>Pay</button></form>`, "go");
    expect(quiet).toMatchObject({ card: true, changes: false });
    expect(classed(quiet)).toBeNull();
  });

  it("calls a plain element money there only when it shows a pointer: text is not a button", () => {
    const html = (style: string) => `<form id="f">${CARD}<div id="go" ${style}>Continue</div><p id="note">Your card is charged when the order ships.</p></form>`;
    expect(classed(clickIn(html('style="cursor: pointer"'), "go"))).toBe("money");
    expect(clickIn(html(""), "go")).toMatchObject({ card: true, button: false });
    expect(classed(clickIn(html(""), "go"))).toBeNull();
    expect(classed(clickIn(html(""), "note"))).toBeNull();
  });

  it("still lets a click into one of its text fields through", () => {
    const read = clickIn(`<form id="f"><input id="num" aria-label="Card number" autocomplete="cc-number"><button type="button">Continue</button></form>`, "num");
    expect(read).toMatchObject({ card: true, button: false, box: "single" });
    expect(classed(read)).toBeNull();
  });

  const BUTTON = `<div id="go" role="button" tabindex="0">Continue</div>`;
  it.each([
    ["the dialog around it", `<div role="dialog">${CARD}${BUTTON}</div>`, true],
    ["the section around it", `<section>${CARD}<div>${BUTTON}</div></section>`, true],
    ["the page, when it has no region around it", `<div>${CARD}</div><div>${BUTTON}</div>`, true],
    ["a navigation bar beside the card fields", `<main>${CARD}</main><nav>${BUTTON}</nav>`, false],
    ["a footer beside the card fields", `<section>${CARD}</section><footer>${BUTTON}</footer>`, false],
    ["its own form, which has no card signal, beside a card form", `<form>${CARD}</form><form><input aria-label="Email">${BUTTON}</form>`, false],
  ])("with no form of its own, takes %s for its region", (_what, html, card) => {
    const read = clickIn(html, "go");
    expect(read).toMatchObject({ card });
    expect(classed(read)).toBe(card ? "money" : null);
  });

  it("counts a frame it recognises as a payment or card frame, and a frame it can read that holds card fields", () => {
    const framed = (attrs: string, inner: string | null) => {
      page.body.innerHTML = `<form id="f"><input aria-label="Email"><object id="frame" ${attrs}></object><button id="go" type="button">Continue</button></form>`;
      const frame = page.getElementById("frame")!;
      const proto = Object.getPrototypeOf(frame) as object;
      const doc = inner === null ? null : new (globalThis as unknown as { DOMParser: new () => { parseFromString(html: string, type: string): unknown } }).DOMParser().parseFromString(inner, "text/html");
      return patched(proto, "contentDocument", { get(this: object) { return this === frame ? doc : null; } }, () => light({ box: boxOf("go"), enter: false }).card);
    };
    expect(framed('title="Secure card number input frame" src="https://js.stripe.com/v3/elements-inner-card.html"', null)).toBe(true);
    expect(framed('title="Kartennummer"', null)).toBe(true);
    // A frame that calls itself payment is a card signal, whatever else it says; a brand's own button is not (round six).
    expect(framed('title="Zahlung"', null)).toBe(true);
    expect(framed('title="Zahlung Button"', null)).toBe(true);
    expect(framed('title="PayPal Button"', null)).toBe(false);
    expect(framed('title="Video player" src="https://videos.example/embed/7"', null)).toBe(false);
    expect(framed('title="Secure card number input frame" style="display:none"', null)).toBe(false);
    expect(framed('title="Billing"', `<body>${CARD}</body>`)).toBe(true);
    expect(framed('title="Billing"', `<body><input aria-label="Comment"></body>`)).toBe(false);
  });
});

describe("round three: a number that passes the checksum", () => {
  const classOf = (html: string) => classifyCommit({ via: "click", ...(clickIn(html, "go") as unknown as Omit<CommitTarget, "via">) });
  const form = (fields: string, button = "Check") => `<form id="f">${fields}<button id="go">${button}</button></form>`;

  it.each([
    ["an IMEI", form(`<input aria-label="IMEI" value="356938035643809">`)],
    ["a fifteen-digit serial number", form(`<input aria-label="Serial number" value="490154203237518">`)],
    ["a tracking number", form(`<input aria-label="Tracking number" value="79927398713008">`, "Track")],
    ["a SIM's number", form(`<input aria-label="ICCID" value="8910042348144559361">`)],
  ])("is not a card number in %s lookup", (_what, html) => {
    expect(classOf(html)).toBeNull();
  });

  it.each([
    ["with a card scheme's first digits", form(`<input aria-label="Reference" value="4242 4242 4242 4242">`)],
    ["with another scheme's first digits and length", form(`<input aria-label="Reference" value="378282246310005">`)],
    ["beside a second card signal in the same form", form(`<input aria-label="Number" value="356938035643809"><input aria-label="CVC">`)],
  ])("is a card number %s", (_what, html) => {
    expect(classOf(html)).toBe("money");
  });

  it("never makes a search form money, whatever is typed in it", () => {
    expect(classOf(`<form id="f" role="search"><input type="search" aria-label="Search" value="4242424242424242"><button id="go">Search</button></form>`)).toBeNull();
    expect(classOf(`<form id="f"><input type="search" aria-label="Find an order" value="4242 4242 4242 4242"><button id="go">Go</button></form>`)).toBeNull();
  });
});

describe("round three: a closed part of the page", () => {
  const docProto = Object.getPrototypeOf(page) as object;
  /** In a browser the focus inside a closed shadow root shows as its host. */
  const focusedOn = (html: string, id: string, enter = true) => {
    page.body.innerHTML = html;
    const host = page.getElementById(id)!;
    return patched(docProto, "activeElement", { get: () => host }, () => light({ box: null, enter }));
  };

  it.each([
    ["a custom element with no root it can open", `<closed-pay id="host"></closed-pay>`],
    ["an element that cannot take the focus by itself", `<div id="host">Card details</div>`],
    ["a custom element that can take the focus but says nothing of what it is", `<pay-box id="host" tabindex="0"></pay-box>`],
  ])("says sealed when the focus is on %s", (_what, html) => {
    expect(focusedOn(html, "host")).toEqual({ found: false, framed: true, sealed: true, frames: false, payFrame: false, inPay: false });
    expect(focusedOn(html, "host", false)).toMatchObject({ found: false, sealed: true });
  });

  it.each([
    ["a button", `<button id="host" type="button">More</button>`, "More"],
    ["a custom element that says it is a button", `<fancy-button id="host" role="button" tabindex="0" aria-label="More"></fancy-button>`, "More"],
    ["an element made focusable", `<div id="host" tabindex="0" aria-label="Panel"></div>`, "Panel"],
  ])("describes the focus on %s as it is", (_what, html, label) => {
    expect(focusedOn(html, "host")).toMatchObject({ found: true, label });
  });
});

describe("round three: what an approval is bound to", () => {
  const FORM = `<form id="f"><input aria-label="To" value="ada@example.com"><input type="hidden" name="amount" value="10">
    <input name="memo" aria-label="Memo" value="rent" style="display:none"><label><input id="tick" type="checkbox" name="urgent"> Urgent</label>
    <label><input type="radio" name="speed" value="slow" checked> Slow</label><label><input id="fast" type="radio" name="speed" value="fast"> Fast</label>
    <select name="account" aria-label="From"><option value="a" selected>Savings</option><option value="b">Current</option></select>
    <textarea aria-label="Message">Hello</textarea><button id="send">Send</button></form>`;
  const bound = (html: string) => clickIn(html, "send").bound;

  it("is the same for the same page, and another for another salt", () => {
    expect(bound(FORM)).toBe(bound(FORM));
    page.body.innerHTML = FORM;
    const salted = (salt: string) => detail({ box: boxOf("send"), enter: false, salt }).parts![0]!.bound;
    expect(salted("aaaa")).toBe(salted("aaaa"));
    expect(salted("aaaa")).not.toBe(salted("bbbb"));
  });

  it.each([
    ["a hidden field", 'name="amount" value="10"', 'name="amount" value="1000"'],
    ["a field that is not displayed", 'value="rent"', 'value="everything"'],
    ["a tick box", 'name="urgent"', 'name="urgent" checked'],
    ["which radio button is chosen", 'value="fast"', 'value="fast" checked'],
    ["a list's choice", 'value="b"', 'value="b" selected'],
    ["a shown field", "ada@example.com", "eve@example.com"],
    ["the message", ">Hello<", ">Hello, and goodbye<"],
  ])("covers %s of the form", (_what, from, to) => {
    expect(FORM).toContain(from);
    expect(bound(FORM.replace(from, to))).not.toBe(bound(FORM));
  });

  it("covers every control of the region around a button with no form, shown or not", () => {
    const region = (extra: string) => `<section><input aria-label="Note" value="See you soon">${extra}<div id="send" role="button" tabindex="0">Send</div></section><input aria-label="Elsewhere" value="x">`;
    const first = clickIn(region(`<input type="hidden" name="to" value="ada">`), "send");
    expect(first).toMatchObject({ fields: [{ name: "Note", type: "text", value: "See you soon" }], others: 0 });
    expect(clickIn(region(`<input type="hidden" name="to" value="eve">`), "send").bound).not.toBe(first.bound);
    expect(clickIn(region(`<input type="hidden" name="to" value="ada">`).replace('value="x"', 'value="y"'), "send").bound).toBe(first.bound);
  });

  it("covers every control on the page when the region has none of its own", () => {
    const html = (to: string) => `<input type="hidden" name="to" value="${to}"><input aria-label="Amount" value="10"><section><div id="send" role="button" tabindex="0">Send</div></section>`;
    const first = clickIn(html("ada"), "send");
    expect(first).toMatchObject({ fields: [], others: 1 });
    expect(clickIn(html("eve"), "send").bound).not.toBe(first.bound);
  });

  it("covers the text in a frame it can read: a rich-text editor keeps its message there", () => {
    const editor = (words: string) => {
      page.body.innerHTML = `<form id="f"><object id="frame" title="Rich text area"></object><button id="send">Send</button></form>`;
      const frame = page.getElementById("frame")!;
      const doc = new (globalThis as unknown as { DOMParser: new () => { parseFromString(html: string, type: string): unknown } }).DOMParser().parseFromString(`<body contenteditable="true"><p>${words}</p></body>`, "text/html");
      return patched(Object.getPrototypeOf(frame) as object, "contentDocument", { get(this: object) { return this === frame ? doc : null; } }, () => run({ box: boxOf("send"), enter: false }).bound);
    };
    expect(editor("Lunch at one?")).toBe(editor("Lunch at one?"));
    expect(editor("Lunch at two?")).not.toBe(editor("Lunch at one?"));
  });
});

describe("round three: names that hide a value", () => {
  const read = (fields: string) => clickIn(`<form id="f">${fields}<button id="go">Save</button></form>`, "go");
  const field = (label: string, value: string, attrs = "") => `<input aria-label="${label}" value="${value}" ${attrs}>`;

  it.each([
    ["a code", "Code", "731942", "code"],
    ["a verification code", "Verification code", "731942", "code"],
    ["a backup code", "Backup code", "8842-1190", "code"],
    ["a confirmation code, in German", "Bestätigungscode", "731942", "code"],
    ["a code, in Spanish", "Código", "731942", "code"],
    ["a security answer", "Security answer", "Fluffy the cat", "secret"],
    ["an answer, in French", "Réponse", "Minou", "secret"],
    ["an answer, in German", "Antwort", "Mieze", "secret"],
    ["a secret key", "Secret key", "sk_live_abcdefg12345", "secret"],
    ["an API key", "API key", "abcd-1234", "secret"],
    ["a key, in Spanish", "Clave", "abcd-1234", "secret"],
    ["a key, in Portuguese", "Chave", "abcd-1234", "secret"],
    ["a recovery phrase", "Recovery phrase", "apple brave candle", "secret"],
    ["a backup phrase", "Backup phrase", "apple brave candle", "secret"],
    ["a social security number", "Social security number", "078-05-1120", "id"],
    ["a national insurance number", "National Insurance number", "QQ123456C", "id"],
    ["a tax number", "Tax number", "12/345/67890", "id"],
    ["a tax number, in German", "Steuernummer", "12/345/67890", "id"],
    ["an IBAN", "IBAN", "DE89370400440532013000", "id"],
    ["an account number", "Account number", "00123456", "id"],
    ["a DNI", "DNI", "12345678Z", "id"],
    ["a CPF", "CPF", "123.456.789-09", "id"],
    ["a passport number", "Passport number", "X1234567", "id"],
    ["a password, in Spanish", "Contraseña", "mi-secreto-123", "password"],
    ["a password, in French", "Mot de passe", "mon-secret-123", "password"],
    ["a password, in German", "Kennwort", "mein-geheimnis", "password"],
    ["a password, in Portuguese", "Senha", "meu-segredo", "password"],
    ["a card number, in Spanish", "Número de tarjeta", "4242 42", "card"],
    ["a card number, in French", "Numéro de carte", "4242 42", "card"],
    ["a card number, in German", "Kartennummer", "4242 42", "card"],
  ])("reads only the length of %s", (_what, label, value, type) => {
    const got = read(field(label, value));
    expect(got.fields).toEqual([{ name: label, type, length: value.length }]);
    expect(JSON.stringify(got)).not.toContain(value);
    expect(got.secrets).toBe(true);
  });

  it.each([
    ["a postal code", "Postal code", "413102"],
    ["a postal code, in French", "Code postal", "75001"],
    ["a promo code", "Promo code", "SAVE10"],
    ["a country code", "Country code", "+91"],
    ["a keyword", "Keywords", "browser, guard"],
    ["a city", "City", "Baramati"],
  ])("still shows %s", (_what, label, value) => {
    expect(read(field(label, value)).fields).toEqual([{ name: label, type: "text", value }]);
  });

  it("hides a box of many lines only when its name is a key or a phrase", () => {
    const boxes = read(`<textarea aria-label="Recovery phrase">apple brave candle</textarea><textarea aria-label="Private key">-----BEGIN</textarea><textarea aria-label="Your answer">Use a mutex.</textarea>`);
    expect(boxes.fields).toEqual([
      { name: "Recovery phrase", type: "secret", length: 18 },
      { name: "Private key", type: "secret", length: 10 },
      { name: "Your answer", type: "textarea", value: "Use a mutex." },
    ]);
  });

  it("leaves the text around the button off when it says a secret out loud, and says the page must not be pictured", () => {
    const row = (said: string) => clickIn(`<div role="row">${said} <button id="go" type="button">Send</button></div>`, "go");
    expect(row("Invoice 7 is ready")).toMatchObject({ context: "Invoice 7 is ready Send", secrets: false });
    for (const said of ["Your new password is Tr0ub4dor", "Your recovery code is 5519-2207", "Paying with 4242 4242 4242 4242", "API key sk_live_abcdefg12345"]) {
      const got = row(said);
      expect(got).toMatchObject({ context: "", secrets: true });
      expect(JSON.stringify(got)).not.toContain(said.split(" ").at(-1));
    }
    // It is still bound to that text: another secret there is another page.
    expect(row("Your new password is Tr0ub4dor").around).not.toBe(row("Your new password is hunter2").around);
  });
});

describe("round three: an element a page keeps restyling", () => {
  const ROW = (attrs: string, ago: string) => `<div role="row"><span>${ago}</span> Invoice 7 <button id="pay" type="button" ${attrs}>Pay</button></div>`;

  it("is the same element whatever its style, class or state attributes say", () => {
    const first = clickIn(ROW("", "3s ago"), "pay").identity;
    for (const attrs of ['style="opacity: 0.93"', 'class="btn btn-hover"', 'data-state="ready" aria-busy="false"', 'tabindex="0"']) {
      expect(clickIn(ROW(attrs, "3s ago"), "pay").identity).toBe(first);
    }
    // What it does is still what it is.
    for (const attrs of ['formaction="/pay-all"', 'onclick="payAll()"', 'name="all"', 'aria-label="Pay everything"']) {
      expect(clickIn(ROW(attrs, "3s ago"), "pay").identity).not.toBe(first);
    }
  });

  it("compares the text around it with relative times and clocks evened out, and every other number as it is", () => {
    const first = clickIn(ROW("", "3s ago"), "pay").around;
    for (const ago of ["4s ago", "59s ago", "1m ago", "2 minutes ago", "an hour ago", "a few seconds ago", "just now", "12:04", "12:04:59"]) {
      expect(clickIn(ROW("", ago), "pay").around).toBe(first);
    }
    // A number that is no time is part of what was approved.
    expect(clickIn(ROW("", "3s ago").replace("Invoice 7", "Invoice 9"), "pay").around).not.toBe(first);
    expect(clickIn(ROW("", "3s ago").replace("Invoice", "Refund"), "pay").around).not.toBe(first);
    expect(clickIn(ROW("", "overdue"), "pay").around).not.toBe(first);
    const priced = (price: string) => clickIn(`<div role="row">Laptop ${price} <button id="pay" type="button">Pay</button></div>`, "pay").around;
    expect(priced("$10.00")).not.toBe(priced("$99.00"));
  });
});

describe("round three: a click that is no commitment on a very large page", () => {
  const BIG = `<button id="details" type="button">Show details</button><section><input aria-label="Note" value="See you soon"><div id="send" role="button" tabindex="0">Send</div></section>
    ${Array.from({ length: 6_000 }, (_, index) => `<input aria-label="Cell ${index}" value="value ${index}">`).join("")}`;
  /** An engine over this page: it measures by id and runs the script here. */
  const engine = (): EngineQuery => async (args, stdin) => {
    if (args[0] === "get" && args[1] === "box") return { ok: true, data: boxOf(args[2]!.slice(1)) };
    if (args[0] === "get") return { ok: true, data: { url: "https://sheet.example/" } };
    return { ok: true, data: { result: new Function(`return ${stdin}`)() as Record<string, unknown> } };
  };

  it("is described from the element and its region alone, with no field of the page in the answer", async () => {
    page.body.innerHTML = BIG;
    const reader = browserPageReader(engine());
    const started = performance.now();
    const target = await reader.target("#details", false);
    const took = performance.now() - started;
    expect(target).toMatchObject({ label: "Show details", role: "button", card: false });
    expect(JSON.stringify(target)).not.toContain("value 17");
    expect(target).not.toHaveProperty("fields");
    // A bound on the work, not a benchmark: the old read took the value and the label of every field.
    expect(took).toBeLessThan(2_500);
  }, 20_000);

  it("gives the evidence for a commitment there: its region's fields listed, the rest counted and bound", async () => {
    page.body.innerHTML = BIG;
    const evidence = await browserPageReader(engine()).evidence("#send", false);
    expect(evidence).toMatchObject({ parts: [{ fields: [{ name: "Note", type: "text", value: "See you soon" }], others: 0 }] });
  }, 20_000);
});

describe("tuning: a plain link", () => {
  it.each([
    ["a link to another page", `<a id="t" href="/pricing">Pay now</a>`],
    ["a link to another site", `<a id="t" href="https://example.com/share">Share</a>`],
    ["a link clicked by the text inside it", `<a href="/posts"><span id="t">Post archive</span></a>`],
    ["a link that says it is a link", `<a id="t" role="link" href="/x">Send</a>`],
    ["a link to another page with a fragment", `<a id="t" href="/guide#comment">Comment policy</a>`],
  ])("says so of %s", (_what, html) => {
    expect(light({ box: (page.body.innerHTML = html, boxOf("t")), enter: false })).toMatchObject({ found: true, link: true, button: true });
  });

  it.each([
    ['a "#" link', `<a id="t" href="#">Send</a>`],
    ["a link to a place this page does not have", `<a id="t" href="#comments">Comment</a>`],
    ['a "javascript:" link', `<a id="t" href="javascript:void(0)">Send</a>`],
    ['a "JavaScript:" link, however it is written', `<a id="t" href=" JavaScript:send()">Send</a>`],
    ["a link with a button role", `<a id="t" role="button" href="/x">Send</a>`],
    ["a link with a menu item role", `<a id="t" role="menuitem" href="/x">Send</a>`],
    ["a link with a click handler written on it", `<a id="t" href="/x" onclick="send(); return false">Send</a>`],
    ["a link with an empty address", `<a id="t" href="">Send</a>`],
    ["an anchor with no address", `<a id="t">Send</a>`],
    ["a button", `<button id="t" type="button">Send</button>`],
    ["an element with the link role", `<span id="t" role="link" tabindex="0">Send</span>`],
  ])("does not say so of %s", (_what, html) => {
    expect(light({ box: (page.body.innerHTML = html, boxOf("t")), enter: false })).toMatchObject({ found: true, link: false });
  });

  it("does not say so of a link whose click handler was set by script", () => {
    page.body.innerHTML = `<a id="t" href="/x">Send</a>`;
    (page.getElementById("t") as unknown as { onclick: unknown }).onclick = () => {};
    expect(light({ box: boxOf("t"), enter: false })).toMatchObject({ link: false });
  });

  it("does not say so of a link to this same page with a fragment: it loads nothing", () => {
    const here = (globalThis as unknown as { document: { URL: string } }).document.URL.split("#")[0];
    page.body.innerHTML = `<a id="t" href="${here}#reply">Reply</a><a id="again" href="${here}">Post</a>`;
    expect(light({ box: boxOf("t"), enter: false })).toMatchObject({ link: false });
    // The same address with no fragment loads the page again.
    expect(light({ box: boxOf("again", { x: 1, y: 2, width: 3, height: 4 }), enter: false })).toMatchObject({ link: true });
  });
});

describe("tuning: a sign-in, and a form where something is submitted", () => {
  const read = (html: string, id = "t") => light({ box: (page.body.innerHTML = html, boxOf(id)), enter: false });

  it("calls a form with a password field and no multi-line field a sign-in", () => {
    const form = `<form><input aria-label="Email"><input id="pw" type="password" aria-label="Password"><button id="t">Submit</button></form>`;
    expect(read(form)).toMatchObject({ signin: true, carries: false });
    expect(focusIn(form, "pw")).toMatchObject({ label: "Submit", signin: true });
    expect(read(`<div role="dialog"><input type="password" aria-label="Password"><div id="t" role="button" tabindex="0">Submit</div></div>`)).toMatchObject({ signin: true });
  });

  it.each([
    ["a multi-line field too", `<form><input type="password" aria-label="Password"><textarea aria-label="Message"></textarea><button id="t">Submit</button></form>`],
    ["no password field", `<form><input aria-label="Email"><button id="t">Submit</button></form>`],
    ["a password field nobody can see", `<form><input type="password" aria-label="Password" style="display:none"><button id="t">Submit</button></form>`],
    ["a password field in another form", `<form><input type="password" aria-label="Password"></form><form><input aria-label="Email"><button id="t">Submit</button></form>`],
    ["no form and no region, on a page with a password field", `<input type="password" aria-label="Password"><div id="t" role="button" tabindex="0">Submit</div>`],
  ])("does not call it one with %s", (_what, html) => {
    expect(read(html)).toMatchObject({ signin: false });
  });

  it.each([
    ["a form with a file to attach", `<form><input aria-label="Name"><input type="file" aria-label="CV"><button id="t">Apply</button></form>`, true],
    ["a form whose file input is hidden behind a styled button", `<form><input type="file" style="display:none"><button id="t">Apply</button></form>`, true],
    ["a form with a multi-line field", `<form><textarea aria-label="Cover letter"></textarea><button id="t">Apply</button></form>`, true],
    ["a region with a file to attach", `<section><input type="file" aria-label="CV"><div id="t" role="button" tabindex="0">Apply</div></section>`, true],
    ["a filter form", `<form><select aria-label="Sort by"><option>Newest</option></select><input aria-label="Max price"><button id="t">Apply</button></form>`, false],
    ["a button with no form and no region, beside a text area", `<textarea aria-label="Notes"></textarea><div id="t" role="button" tabindex="0">Apply</div>`, false],
  ])("says something is being submitted in %s: %s", (_what, html, carries) => {
    expect(read(html)).toMatchObject({ carries });
  });
});

describe("tuning: what could make a multi-line field a message composer", () => {
  const entered = (html: string) => focusIn(html, "box");

  it("says nothing of it for a click, or for Enter anywhere else", () => {
    const html = `<form><input id="one" aria-label="Title"><textarea id="box" aria-label="Notes"></textarea><button id="t">Save</button></form>`;
    for (const key of ["hint", "only", "says", "near"]) {
      expect(clickIn(html, "box")).not.toHaveProperty(key);
      expect(focusIn(html, "one")).not.toHaveProperty(key);
    }
  });

  it("says when it is the only text field of its form, and what the buttons there are called", () => {
    expect(entered(`<form><textarea id="box" aria-label="Your thoughts"></textarea><input type="hidden" name="thread" value="7"><button type="button" aria-label="Attach a file"></button><button>Comment</button></form>`))
      .toMatchObject({ box: "multiline", hint: false, only: true, says: "Your thoughts", near: ["Attach a file", "Comment"] });
    expect(entered(`<form><input aria-label="Title"><textarea id="box" aria-label="Notes"></textarea><button>Save</button></form>`)).toMatchObject({ only: false, near: [] });
    // A field nobody can see is not another text field.
    expect(entered(`<form><input aria-label="Trap" style="display:none"><textarea id="box" aria-label="Reply"></textarea><button>Send</button></form>`)).toMatchObject({ only: true, near: ["Send"] });
  });

  it("looks in the region around a box with no form, and at the page when there is none", () => {
    const chat = `<header><input type="search" aria-label="Search"><button type="button">Log out</button></header>
      <main><div id="box" contenteditable="true" role="textbox" aria-label="Message #general"></div><button type="button" aria-label="Send"></button></main>`;
    expect(entered(chat)).toMatchObject({ only: true, says: "Message #general", near: ["Send"] });
    const plain = chat.replace("<main>", "<div>").replace("</main>", "</div>").replace("<header>", "<div>").replace("</header>", "</div>");
    expect(entered(plain.replace('type="search" aria-label="Search"', 'aria-label="Subject"'))).toMatchObject({ only: false });
    expect(entered(`<div><textarea id="box" placeholder="Write a reply"></textarea></div><p><a href="/help">Help</a></p>`)).toMatchObject({ only: true, says: "Write a reply Write a reply", near: ["Help"] });
  });

  // Round five. A page's search box, and the fields in its header,
  // navigation, footer and sidebars, are not part of what a message box
  // belongs to: they do not make it one field among several.
  it("does not count search fields, or fields in the page's header, navigation, footer or aside", () => {
    const box = `<div id="box" contenteditable="true" role="textbox" aria-label="Write a message"></div>`;
    for (const html of [
      `<input type="search" aria-label="Search">${box}`,
      `<div role="search"><input aria-label="Find"></div>${box}`,
      `<input role="searchbox" aria-label="Find">${box}`,
      `<header><input aria-label="Jump to"></header>${box}`,
      `<nav><input aria-label="Filter the menu"></nav>${box}<footer><input aria-label="Newsletter email"></footer><aside><input aria-label="Notes to self"></aside>`,
      `<div role="banner"><input aria-label="Jump to"></div><div role="navigation"><input aria-label="Go"></div>${box}<div role="contentinfo"><input aria-label="Email"></div><div role="complementary"><input aria-label="Tag"></div>`,
      `<form><input type="search" aria-label="Find in thread"><textarea id="box" aria-label="Reply"></textarea><button>Send</button></form>`,
    ]) expect(entered(html), html).toMatchObject({ only: true });
  });

  it("still counts an ordinary field beside it, wherever both are", () => {
    for (const html of [
      `<input aria-label="Subject"><div id="box" contenteditable="true" role="textbox" aria-label="Write a message"></div>`,
      `<form><input aria-label="To"><input aria-label="Subject"><textarea id="box" aria-label="Body"></textarea><button>Send</button></form>`,
      // A box that is itself in a sidebar counts the sidebar's other fields: they are its own neighbours.
      `<aside><input aria-label="Your name"><textarea id="box" aria-label="Message"></textarea></aside>`,
      `<footer><form><input aria-label="Email"><textarea id="box" aria-label="Message"></textarea></form></footer>`,
    ]) expect(entered(html), html).toMatchObject({ only: false });
  });

  it("reads the keyboard hint, the label and the placeholder", () => {
    expect(entered(`<form><input aria-label="Title"><textarea id="box" aria-label="Text" placeholder="Say something" enterkeyhint="Send"></textarea></form>`)).toMatchObject({ hint: true, only: false, says: "Text Say something" });
    expect(entered(`<form><textarea id="box" aria-label="Text" enterkeyhint="enter"></textarea></form>`)).toMatchObject({ hint: false, only: true });
  });

  it("names the nearest buttons first, and no more than twelve", () => {
    const many = Array.from({ length: 30 }, (_, index) => `<button type="button">Tool ${index}</button>`).join("");
    const read = entered(`<section><div>${many}</div><div><div><textarea id="box" aria-label="Text"></textarea><button type="button">Send</button></div></div></section>`) as { near: string[] };
    expect(read.near).toHaveLength(12);
    expect(read.near[0]).toBe("Send");
  });
});

describe("round four: links that stay on the page", () => {
  const linked = (html: string) => light({ box: (page.body.innerHTML = html, boxOf("t")), enter: false });

  it.each([
    ["a place on this page, by its id", `<a id="t" href="#trade">Trade</a><h2 id="trade">Trade</h2>`],
    ["a place on this page, by a named anchor", `<a id="t" href="#notes">Send-off</a><a name="notes"></a>`],
    ["a place whose name needs decoding", `<a id="t" href="#transfer%20of%20power">Transfer of power</a><h2 id="transfer of power">Transfer of power</h2>`],
    ["a #/ route", `<a id="t" href="#/blog">Blog post</a>`],
    ["a #! route", `<a id="t" href="#!/share">Share prices</a>`],
    ["a #/ route with nothing after it", `<a id="t" href="#/">Home</a>`],
  ])("calls a link to %s a plain link", (_what, html) => {
    expect(linked(html)).toMatchObject({ found: true, link: true });
  });

  it.each([
    ["a bare #", `<a id="t" href="#">Send</a><h2 id="send">x</h2>`],
    ["a place this page does not have", `<a id="t" href="#nowhere">Send</a>`],
    ["a route, with a click handler written on it", `<a id="t" href="#/send" onclick="send()">Send</a>`],
    ["a place on this page, with a button role", `<a id="t" href="#trade" role="button">Trade</a><h2 id="trade">Trade</h2>`],
    ["javascript:", `<a id="t" href="javascript:void(0)">Send</a>`],
    ["nothing", `<a id="t" href="">Send</a>`],
    // Round five: an address is read the way a browser reads it.
    ["java, a tab, script:", `<a id="t" href="java&#9;script:send()">Send</a>`],
    ["javascript: split by a line break and a carriage return", `<a id="t" href="jav&#10;ascr&#13;ipt:send()">Send</a>`],
    ["javascript: after control characters and spaces", `<a id="t" href="&#1;&#2;  javascript:send()">Send</a>`],
    ["data:", `<a id="t" href="data:text/html,<p>sent</p>">Send</a>`],
    ["vbscript:", `<a id="t" href="vbscript:send">Send</a>`],
  ])("still calls a link to %s a button", (_what, html) => {
    expect(linked(html)).toMatchObject({ found: true, link: false });
  });
});

describe("round four: a search field in a card region", () => {
  const CARD = `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">`;
  const classed = (read: Record<string, unknown>, via: "click" | "enter" = "click") => classifyCommit({ via, ...(read as unknown as Omit<CommitTarget, "via">) });

  it.each([
    ["an address finder inside a card form", `<form><input id="find" type="search" aria-label="Find your address">${CARD}<button>Pay now</button></form>`, "Pay now"],
    ["a promo field marked as a search box inside a card form", `<form><input id="find" role="searchbox" aria-label="Promo code">${CARD}<button>Continue</button></form>`, "Continue"],
    ["the search field of a form whose button says Buy now", `<form><input id="find" type="search" aria-label="Find a product"><button>Buy now</button></form>`, "Buy now"],
  ])("reads Enter in %s as the button it presses, and as money", (_what, html, label) => {
    const read = focusIn(html, "find");
    expect(read).toMatchObject({ label, search: true, submits: true });
    expect(classed(read, "enter")).toBe("money");
  });

  it("reads a button on a card form inside a search region as money", () => {
    const read = clickIn(`<div role="search"><form>${CARD}<button id="go">Continue</button></form></div>`, "go");
    expect(read).toMatchObject({ search: true, card: true });
    expect(classed(read)).toBe("money");
  });

  it("does not take what is typed in a search form for a card number, whatever its fields are", () => {
    for (const html of [
      `<form role="search"><input type="search" aria-label="Search" value="4242 4242 4242 4242"><button id="go">Search</button></form>`,
      `<form role="search"><input aria-label="Order or card reference" value="4242424242424242"><button id="go">Find</button></form>`,
      `<form><input type="search" aria-label="Find" value="5555 5555 5555 4444"><button id="go">Go</button></form>`,
    ]) {
      const read = clickIn(html, "go");
      expect(read).toMatchObject({ search: true, card: false });
      expect(classed(read)).toBeNull();
    }
  });
});

describe("round four: a payment brand's frame, and a frame for typing a card in", () => {
  /** A page with one frame from another site, and the read of a click on #go. */
  const beside = (attrs: string, html = (frame: string) => `<main><h1>Desk lamp</h1><button id="go" type="button">Add to cart</button>${frame}</main>`) => {
    page.body.innerHTML = html(`<object id="frame" ${attrs}></object>`);
    return light({ box: boxOf("go"), enter: false });
  };

  // Round six. A frame is a card signal for the page around it when what it
  // calls itself speaks of a card, a payment or a checkout. It is not one
  // when what it calls itself is a wallet or pay-later brand and nothing of
  // paying besides. A word in its address decides nothing, except for a few
  // addresses known to be a processor's card fields or a brand's button.
  it.each([
    // A wallet or pay-later brand, alone.
    'title="Shop Pay"', 'title="PayPal"', 'title="Apple Pay"', 'title="Google Pay"', 'title="Amazon Pay"', 'title="Klarna"', 'title="Afterpay"', 'title="Affirm"', 'name="gpay"',
    // A brand with words for a button or a message.
    'title="Donate with PayPal"', 'title="Donate with PayPal button"', 'title="Klarna On-site messaging"', 'title="Klarna Placement"', 'title="PayPal Message"',
    'name="__zoid__paypal_message__abc" title="PayPal Message 7"', 'title="PayPal" name="__zoid__paypal_buttons__abc" src="https://www.paypal.com/smart/buttons?x=1"',
    'title="Afterpay messaging"', 'title="Pay later with Affirm"', 'title="Google Pay button"', 'name="shop-pay-button"', 'title="Apple Pay express wallet logo badge"',
    // The few addresses known to serve a brand's button, whatever the frame is called.
    'src="https://pay.google.com/gp/p/ui/pay"', 'title="Secure express checkout frame" src="https://js.stripe.com/v3/elements-inner-express-checkout-1a2b.html"',
    'title="Secure payment button frame" src="https://js.stripe.com/v3/elements-inner-payment-request-1a2b.html"',
    'title="Buy" src="//pay.google.com/gp/p/ui/pay?x=1"', 'data="https://www.paypal.com/smart/buttons?style=gold"',
  ])("does not make the page around %s a card region, and knows it for a payment frame", (attrs) => {
    expect(beside(attrs)).toMatchObject({ found: true, card: false, payFrame: true });
  });

  it.each([
    'title="Secure card number input frame"', 'title="Secure expiration date input frame"', 'title="Secure CVC input frame"', 'title="Secure payment input frame"',
    'title="Secure card payment input frame"', 'name="braintree-hosted-field-number"', 'title="Iframe for card number"', 'title="Iframe for expiry date"',
    'title="Iframe for security code"', 'title="Secure Credit Card Form"', 'name="checkout-frames-cardNumber"', 'title="Field container for: Card number"',
    'title="Hosted fields"', 'title="Número de tarjeta"', 'title="Kartennummer"',
    // A frame that calls itself payment or checkout, whatever else it says.
    'title="Checkout"', 'title="Payment"', 'title="Secure payment"', 'title="Zahlungen"', 'title="Paiements"', 'title="Pay"', 'title="Card payment button"',
    'title="Payment button frame"', 'title="Checkout message"', 'title="Onsite checkout"', 'title="Secure express checkout frame"', 'title="Secure payment button frame"',
    'title="Checkout" src="https://shop.example.com/embed/message-frame?buttonColor=blue"', 'aria-label="Payment"', 'name="checkout-frame"',
    // A brand's frame for paying in.
    'name="klarna-payments-main"', 'title="Klarna payments"', 'title="PayPal card fields"', 'title="paypal_card_number_field"', 'title="PayPal Checkout"', 'title="Pay with Klarna"',
    // The few addresses known to serve a processor's card fields, whatever the frame is called.
    'src="https://js.stripe.com/v3/elements-inner-card-19.html"', 'name="__privateStripeFrame7" src="https://js.stripe.com/v3/elements-inner-payment-3c.html"',
    'src="https://assets.braintreegateway.com/web/3.97.2/html/hosted-fields-frame.min.html"', 'src="https://checkoutshopper-live.adyen.com/checkoutshopper/securedfields/x/5.1/securedFields.html"',
    'src="https://www.paypal.com/smart/card-fields?x=1"', 'src="//js.stripe.com/v3/elements-inner-card-19.html"',
    // Round seven. A known address counts by the host the frame is served from, and its path: a mention of it
    // anywhere else in the address (a query, a path on another host, a look-alike host, a user name) excuses nothing.
    'title="Checkout" src="https://shop.example.com/embed?next=https://pay.google.com/gp/p/ui/pay"', 'title="Checkout" src="https://pay.google.com.evil.example/gp/p/ui/pay"',
    'title="Checkout" src="https://pay.google.com@evil.example/gp/p/ui/pay"', 'title="Checkout" src="https://evil.example/www.paypal.com/smart/buttons"',
    'title="Payment" src="https://js.stripe.com.evil.example/v3/elements-inner-express-checkout-1.html"', 'title="Checkout" src="https://pay.google.com/other/page"',
    'title="Payment" src="https://evil.example/#https://www.paypal.com/smart/buttons"',
  ])("makes the page around %s a card region", (attrs) => {
    expect(beside(attrs)).toMatchObject({ found: true, card: true, payFrame: true });
  });

  // A word that is only in a frame's address makes it nothing: not a card
  // signal, and no payment frame for a click inside it either.
  it.each([
    'title="Reviews" src="https://widgets.example.com/pay/embed?id=7"', 'title="Advertisement" src="https://ads.example.com/checkout/banner"',
    'src="https://pay.example.com/session/7"', 'src="https://pay.example.com/button/7"', 'data="https://cdn.example.com/card/promo.html"', 'title="Stripe"',
    'title="Support chat" src="https://chat.example.com/payments-help"',
    // A card-field host named anywhere but in the host of the address is no card-field host; an address that cannot be read matches nothing.
    'src="https://evil.example/js.stripe.com/v3/elements-inner-card-19.html"', 'src="https://cdn.example.com/x?u=https://js.stripe.com/v3/elements-inner-card-19.html"',
    'src="https://js.stripe.com.evil.example/v3/elements-inner-card-19.html"', 'src="https://js.stripe.com@evil.example/v3/elements-inner-card-19.html"',
    'src="http://[bad/v3/elements-inner-card-19.html"', 'src="https://js.stripe.com/v3/fingerprinted/js/controller.html"',
  ])("takes %s for no payment frame at all", (attrs) => {
    expect(beside(attrs)).toMatchObject({ found: true, card: false, payFrame: false });
  });

  it.each(['title="Advertisement"', 'title="Video player" src="https://videos.example/embed/7"', 'title="Comments"', 'title="Map"'])("takes %s for neither", (attrs) => {
    expect(beside(attrs)).toMatchObject({ found: true, card: false, payFrame: false });
  });

  it("says whether the measured box could be inside a payment frame: it starts within the frame's own size", () => {
    const at = (box: { x: number; y: number; width: number; height: number }) => {
      page.body.innerHTML = `<main><button id="go" type="button">Add to cart</button><object id="frame" title="PayPal"></object></main>`;
      boxOf("frame", { x: 400, y: 300, width: 320, height: 50 });
      return light({ box: boxOf("go", box), enter: false });
    };
    // The engine measures an element in a frame from the frame's own corner.
    expect(at({ x: 8, y: 9, width: 90, height: 24 })).toMatchObject({ payFrame: true, inPay: true });
    expect(at({ x: 600, y: 9, width: 90, height: 24 })).toMatchObject({ payFrame: true, inPay: false });
    expect(at({ x: 8, y: 400, width: 90, height: 24 })).toMatchObject({ payFrame: true, inPay: false });
  });
});

describe("round four: fields inside web components", () => {
  type Host = { attachShadow(init: { mode: string }): { innerHTML: string; getElementById(id: string): PageElement; querySelector(selector: string): { value: string; checked: boolean } } };
  const shadowOf = (id: string, inner: string, mode = "open") => { const root = (page.getElementById(id) as unknown as Host).attachShadow({ mode }); root.innerHTML = inner; return root; };
  const CARD = `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">`;

  it("finds card fields in a component's open shadow root, from a button outside it", () => {
    page.body.innerHTML = `<section><card-fields id="host"></card-fields><button id="go" type="button">Continue</button></section>`;
    expect(light({ box: boxOf("go"), enter: false })).toMatchObject({ card: false });
    shadowOf("host", CARD);
    expect(light({ box: boxOf("go"), enter: false })).toMatchObject({ found: true, label: "Continue", card: true });
  });

  it("finds them from a button in the same shadow root, in a form, and two components deep", () => {
    page.body.innerHTML = `<checkout-box id="host"></checkout-box>`;
    const root = shadowOf("host", `${CARD}<button id="go" type="button">Continue</button>`);
    boxes.set(root.getElementById("go"), { x: 3, y: 4, width: 80, height: 22 });
    expect(light({ box: { x: 3, y: 4, width: 80, height: 22 }, enter: false })).toMatchObject({ found: true, label: "Continue", card: true });
    page.body.innerHTML = `<form><pay-fields id="host"></pay-fields><button id="go">Continue</button></form>`;
    shadowOf("host", `<div><inner-field id="deep"></inner-field></div>`).getElementById("deep");
    ((page.getElementById("host") as unknown as { shadowRoot: { getElementById(id: string): Host } }).shadowRoot.getElementById("deep")).attachShadow({ mode: "open" }).innerHTML = CARD;
    expect(light({ box: boxOf("go"), enter: false })).toMatchObject({ found: true, submits: true, card: true });
  });

  it("lists a form's fields that sit in shadow roots, and is bound to them", () => {
    const mail = (to: string) => {
      page.body.innerHTML = `<form><text-field id="to"></text-field><text-field id="subject"></text-field><button id="send">Send</button></form>`;
      shadowOf("to", `<input aria-label="To" value="${to}">`);
      shadowOf("subject", `<input aria-label="Subject" value="Lunch">`);
      return run({ box: boxOf("send"), enter: false });
    };
    const read = mail("ada@example.com");
    expect(read.fields).toEqual([{ name: "To", type: "text", value: "ada@example.com" }, { name: "Subject", type: "text", value: "Lunch" }]);
    expect(mail("ada@example.com").bound).toBe(read.bound);
    expect(mail("mallory@example.com").bound).not.toBe(read.bound);
  });

  it("says when the form or region holds a component whose inside it cannot read", () => {
    const withBox = (inner: string) => {
      page.body.innerHTML = `<form><input aria-label="To" value="ada@example.com">${inner}<button id="send">Send</button></form><sealed-note id="outside"></sealed-note>`;
      for (const id of ["sealed", "outside"]) if (page.getElementById(id)) boxOf(id, { x: 1, y: 300, width: 200, height: 30 });
      return run({ box: boxOf("send"), enter: false });
    };
    expect(withBox("")).toMatchObject({ opaque: false });
    expect(withBox(`<sealed-note id="sealed"></sealed-note>`)).toMatchObject({ opaque: true });
    // One with content of its own on the page, or with a root that can be opened, or with no size, is not that.
    expect(withBox(`<fancy-row id="sealed"><input aria-label="Cc" value=""></fancy-row>`)).toMatchObject({ opaque: false });
    page.body.innerHTML = `<form><open-note id="sealed"></open-note><button id="send">Send</button></form>`;
    shadowOf("sealed", `<input aria-label="Bcc" value="boss@example.com">`);
    boxOf("sealed", { x: 1, y: 300, width: 200, height: 30 });
    expect(run({ box: boxOf("send"), enter: false })).toMatchObject({ opaque: false, fields: [{ name: "Bcc", type: "text", value: "boss@example.com" }] });
    page.body.innerHTML = `<form><x-tracker id="sealed"></x-tracker><button id="send">Send</button></form>`;
    expect(run({ box: boxOf("send"), enter: false })).toMatchObject({ opaque: false });
  });
});

describe("round four: a field's name", () => {
  const read = (fields: string) => clickIn(`<form id="f">${fields}<button id="go">Send</button></form>`, "go");

  it("is its label's own words, without the text or value of any control inside the label", () => {
    const got = read(`<label>Recovery phrase <textarea>abandon ability able about above absent</textarea></label>
      <label>Password hint <input value="first dog's name"></label>
      <label>Network <select><option>Mainnet</option><option>Testnet</option></select></label>
      <label><input type="checkbox" checked> Remember this device <button type="button">Why?</button></label>
      <label>Note <span>(optional)</span> <input value="private words"></label>`);
    expect((got.fields as Array<{ name: string }>).map((field) => field.name)).toEqual(["Recovery phrase", "Password hint", "Network", "Remember this device", "Note (optional)"]);
    expect(got.fields).toEqual([
      { name: "Recovery phrase", type: "secret", length: 39 },
      { name: "Password hint", type: "password", length: 16 },
      { name: "Network", type: "select", value: "Mainnet" },
      { name: "Remember this device", type: "checkbox", value: "checked" },
      { name: "Note (optional)", type: "text", value: "private words" },
    ]);
    expect(JSON.stringify((got.fields as Array<{ name: string }>).map((field) => field.name))).not.toMatch(/abandon|first dog|Mainnet|private words/);
  });

  it("is taken the same way from the element an aria-labelledby points at", () => {
    const got = read(`<div id="lab">Delivery notes <textarea>ring twice</textarea> <div contenteditable="true">and wait</div></div><input aria-labelledby="lab" value="x">`);
    expect((got.fields as Array<{ name: string; value?: string }>).find((field) => field.value === "x")!.name).toBe("Delivery notes");
  });

  it("is cut short", () => {
    const got = read(`<label>${"A very long label ".repeat(20)}<input value="x"></label>`);
    expect((got.fields as Array<{ name: string }>)[0]!.name.length).toBeLessThanOrEqual(60);
  });
});

describe("round four: boxes and switches that are roles, not inputs", () => {
  const SEND = (state: string) => `<section><div id="all" role="checkbox" ${state} tabindex="0">Everyone in the company</div><input aria-label="Note" value="hi"><div id="send" role="button" tabindex="0">Send</div></section>`;
  const bound = (html: string) => clickIn(html, "send").bound;

  it.each([
    ["a tick box", 'aria-checked="false"', 'aria-checked="true"'],
    ["a tick box that is half ticked", 'aria-checked="false"', 'aria-checked="mixed"'],
  ])("binds an approval to the state of %s", (_what, before, after) => {
    expect(bound(SEND(before))).toBe(bound(SEND(before)));
    expect(bound(SEND(after))).not.toBe(bound(SEND(before)));
  });

  it.each([
    ["a switch", `<div role="switch" aria-checked="false">Share with everyone</div>`, `<div role="switch" aria-checked="true">Share with everyone</div>`],
    ["a radio button", `<div role="radio" aria-checked="false">Public</div>`, `<div role="radio" aria-checked="true">Public</div>`],
    ["an option", `<div role="option" aria-selected="false">All contacts</div>`, `<div role="option" aria-selected="true">All contacts</div>`],
    ["a toggle button", `<button type="button" aria-pressed="false">Notify all</button>`, `<button type="button" aria-pressed="true">Notify all</button>`],
  ])("binds it to the state of %s, in a form too", (_what, before, after) => {
    const form = (inner: string) => `<form><textarea aria-label="Message">Hello</textarea>${inner}<button id="send">Send</button></form>`;
    expect(bound(form(after))).not.toBe(bound(form(before)));
  });
});

describe("round four: the language a page declares", () => {
  it.each([
    ["the page's own", `<form><textarea></textarea><button id="t">Speichern</button></form>`, "de", "de"],
    ["a nearer element's", `<div lang="fr"><form><textarea></textarea><button id="t">Enregistrer</button></form></div>`, "en", "fr"],
    ["none", `<form><textarea></textarea><button id="t">Save draft</button></form>`, null, ""],
  ])("reads %s", (_what, html, lang, want) => {
    const root = (globalThis as unknown as { document: { documentElement: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void } } }).document.documentElement;
    if (lang === null) root.removeAttribute("lang"); else root.setAttribute("lang", lang);
    try { expect(light({ box: (page.body.innerHTML = html, boxOf("t")), enter: false })).toMatchObject({ found: true, lang: want }); }
    finally { root.removeAttribute("lang"); }
  });
});

describe("round seven: Enter in a field whose form's submit button is disabled", () => {
  const CARD = `<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">`;
  const classed = (read: Record<string, unknown>) => classifyCommit({ via: "enter", ...(read as unknown as Omit<CommitTarget, "via">) });

  // A page can enable its button a moment after the last key: between the
  // look at the page and the key press. The browser's default button is the
  // form's first submit control whatever its state, so that is what Enter
  // there is judged by.
  it.each([
    ["a button that pays", `<form><input id="f" aria-label="Amount"><button disabled>Pay now</button></form>`, "Pay now", "money"],
    ["a button that sends", `<form><input id="f" aria-label="Ask anything"><button disabled>Send</button></form>`, "Send", "send"],
    ["a card form's button, whatever it says", `<form>${CARD}<input id="f" aria-label="Name on card"><button disabled>Continue</button></form>`, "Continue", "money"],
    ["an input button", `<form><input id="f" aria-label="Amount"><input type="submit" value="Donate" disabled></form>`, "Donate", "money"],
    ["a button tied to the form from outside it", `<form id="x"><input id="f" aria-label="Amount"></form><button form="x" disabled>Pay now</button>`, "Pay now", "money"],
  ] as const)("judges it by %s although the button is disabled", (_what, html, label, kind) => {
    const read = focusIn(html, "f");
    expect(read).toMatchObject({ label, role: "button", submits: true });
    expect(classed(read)).toBe(kind);
    // The same for text typed at the field.
    page.body.innerHTML = html;
    expect(classed(light({ box: boxOf("f"), enter: true }))).toBe(kind);
  });

  it("goes by the form's first submit control, enabled or not, as the browser does", () => {
    expect(focusIn(`<form><input id="f" aria-label="Amount"><button disabled>Pay now</button><button>Save</button></form>`, "f")).toMatchObject({ label: "Pay now", submits: true });
    expect(focusIn(`<form><input id="f" aria-label="Amount"><button>Save</button><button disabled>Pay now</button></form>`, "f")).toMatchObject({ label: "Save", submits: true });
  });

  it.each([
    ["a search", `<form role="search"><input id="f" type="search" aria-label="Search"><button disabled>Search</button></form>`],
    ["a sign-in", `<form><input aria-label="Email"><input id="f" type="password" aria-label="Password"><button disabled>Log in</button></form>`],
    ["a sign-in whose button says Submit", `<form><input aria-label="Email"><input id="f" type="password" aria-label="Password"><button disabled>Submit</button></form>`],
    ["a filter form", `<form><input id="f" aria-label="Max price"><button disabled>Apply</button></form>`],
    ["a profile form", `<form><input id="f" aria-label="Name"><button disabled>Save changes</button></form>`],
  ])("still lets Enter through in %s whose button is disabled", (_what, html) => {
    const read = focusIn(html, "f");
    expect(read).toMatchObject({ submits: true, role: "button" });
    expect(classed(read)).toBeNull();
  });

  it("judges a list whose handler submits its form by that button too", () => {
    const read = clickIn(`<form><textarea aria-label="Message">Hi</textarea><select id="s" aria-label="When" onchange="this.form.requestSubmit()"><option>now</option></select><button disabled>Send</button></form>`, "s");
    expect(read).toMatchObject({ label: "Send", submits: true });
  });

  it("leaves a click on a disabled button what it was: it is not a submit", () => {
    expect(clickIn(`<form><input aria-label="Name"><button id="b" disabled>Save changes</button></form>`, "b")).toMatchObject({ label: "Save changes", submits: false });
  });
});

describe("the scripts as the engine gets them", () => {
  // They go to the engine on its input. On a command line they would be
  // bounded by the longest one Windows will start (32,767 characters), and a
  // read that cannot start refuses every click.
  it("go in on the engine's input, and nothing long goes on its command line", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const reader = browserPageReader(async (args, stdin) => {
      calls.push({ args, stdin });
      return args[0] === "eval" ? { ok: true, data: { result: { found: false } } } : { ok: true, data: { x: 1, y: 2, width: 3, height: 4, url: "https://example.com/", value: null } };
    });
    await reader.target("#send", false);
    await reader.evidence("#send", true);
    await reader.target(null, true);
    const evals = calls.filter((call) => call.args[0] === "eval");
    expect(evals.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      if (call.args[0] === "eval") {
        expect(call.args).toEqual(["eval", "--stdin"]);
        expect(call.stdin).toMatch(/^\(\(input\) => \{/);
      } else expect(call.stdin).toBeUndefined();
      for (const arg of call.args) expect(arg.length).toBeLessThan(2_100);
    }
  });

  it("carry no comment lines", () => {
    for (const detail of [false, true]) {
      const script = pageReadScript({ box: { x: 1234.5678, y: 2345.6789, width: 345.6789, height: 45.6789 }, enter: false, detail, salt: "0123456789abcdef" });
      expect(script).not.toMatch(/^\s*\/\//m);
      expect(script.length).toBeGreaterThan(5_000);
    }
  });
});

describe("parsePageTarget", () => {
  it("accepts only a found target and bounds everything the page wrote", () => {
    expect(parsePageTarget({ found: false })).toBeNull();
    expect(parsePageTarget("found")).toBeNull();
    expect(parsePageTarget({ found: true, label: "x".repeat(500), role: 7, box: "weird", submits: "yes", button: 1, typable: "yes", fields: [{ name: "n", type: "text", value: "v" }] })).toEqual({
      label: "x".repeat(120), role: "", box: null, submits: false, search: false, card: false, multiline: false,
      button: false, changes: false, typable: false, field: false, reach: false, link: false, signin: false, carries: false, lang: "", frames: false, payFrame: false, inPay: false,
    });
    // What says a multi-line field is a composer comes all together or not at all, and bounded.
    expect(parsePageTarget({ found: true, only: "yes", hint: true, says: "Message", near: ["Send"] })).not.toHaveProperty("only");
    expect(parsePageTarget({ found: true, only: true, hint: 1, says: "s".repeat(500), near: ["Send", 7, null, "b".repeat(200), ...Array.from({ length: 30 }, (_, index) => `Button ${index}`)] })).toMatchObject({
      only: true, hint: false, says: "s".repeat(200), near: ["Send", "b".repeat(60), ...Array.from({ length: 10 }, (_, index) => `Button ${index}`)],
    });
    expect(parsePageTarget({ found: true, link: true, signin: true, carries: true })).toMatchObject({ link: true, signin: true, carries: true });
    expect(parsePageTarget({ found: true, frames: true, payFrame: true, button: true, changes: true, typable: true })).toMatchObject({ frames: true, payFrame: true, button: true, changes: true, typable: true });
  });
});

describe("parsePageDetail", () => {
  const part = { opaque: false, fields: [], others: 0, bound: "0123456789abcdef", identity: "html:0/body:1/button:0#0123456789abcdef", context: "Laptop $18,000 Buy now", around: "fedcba9876543210" };

  it("accepts only a found answer and bounds everything the page wrote", () => {
    expect(parsePageDetail({ found: false })).toBeNull();
    expect(parsePageDetail("found")).toBeNull();
    expect(parsePageDetail({ found: true })).toBeNull();
    expect(parsePageDetail({ found: true, parts: [null] })).toBeNull();
    expect(parsePageDetail({ found: true, parts: Array.from({ length: 10 }, () => part) })).toBeNull();
    expect(parsePageDetail({ found: true, parts: [], secrets: "no" })).toEqual({ parts: [], secrets: false });
    expect(parsePageDetail({ found: true, secrets: true, parts: [{ fields: [{ name: "n", type: "text", value: "v", length: "3" }, null, "x"], others: -4, bound: 7, identity: "i".repeat(5_000), context: "c".repeat(400), around: "a".repeat(100) }] })).toEqual({
      secrets: true,
      parts: [{ opaque: false, fields: [{ name: "n", type: "text", value: "v" }], others: 0, bound: "", identity: "i".repeat(4_000), context: "c".repeat(300), around: "a".repeat(64) }],
    });
    expect(parsePageDetail({ found: true, parts: [{ ...part, others: 12 }] })!.parts[0]).toEqual({ ...part, others: 12 });
    expect(parsePageDetail({ found: true, parts: [{ ...part, opaque: true }] })!.parts[0]).toMatchObject({ opaque: true });
    expect(parsePageDetail({ found: true, parts: [{ ...part, opaque: "yes" }] })!.parts[0]).toMatchObject({ opaque: false });
  });

  it("keeps every field and every character of a value: the approval is bound to all of it", () => {
    const fields = Array.from({ length: 400 }, (_, index) => ({ name: `Field ${index}`, type: "text", value: index === 399 ? "x".repeat(250_000) : `value ${index}` }));
    const parsed = parsePageDetail({ found: true, parts: [{ ...part, fields }] })!.parts[0]!;
    expect(parsed.fields).toHaveLength(400);
    expect(parsed.fields[399]!.value).toHaveLength(250_000);
    expect(parsed).toMatchObject({ identity: "html:0/body:1/button:0#0123456789abcdef", context: "Laptop $18,000 Buy now" });
  });

  it("refuses an answer with more fields than it will bind, rather than bind some of them", () => {
    const fields = Array.from({ length: 5_001 }, (_, index) => ({ name: `Field ${index}`, type: "text", value: "v" }));
    expect(parsePageDetail({ found: true, parts: [{ ...part, fields }] })).toBeNull();
  });
});

describe("parsePageTarget with more than one element in the box", () => {
  it("keeps the others, bounded, and drops what is not a target", () => {
    const other = { found: true, label: "Cancel", role: "button", box: null, submits: false, search: false, card: false, multiline: false, fields: [] };
    const parsed = parsePageTarget({ ...other, label: "Send", also: [other, null, "x", { ...other, also: [other] }, ...Array.from({ length: 20 }, () => other)] });
    expect(parsed).toMatchObject({ label: "Send" });
    expect(parsed!.also!.length).toBe(8);
    expect(parsed!.also![0]).toMatchObject({ label: "Cancel" });
    expect(parsed!.also![1]).not.toHaveProperty("also");
  });
});

describe("browserPageReader", () => {
  type Answer = Awaited<ReturnType<EngineQuery>>;
  /** A scripted engine: one answer per command, or a queue of them. */
  function engine(answers: Record<string, Answer | Answer[]>) {
    const calls: string[][] = [];
    /** What each call gave the engine on its input: the script, for an eval. */
    const scripts: Array<string | undefined> = [];
    const query: EngineQuery = async (args, stdin) => {
      calls.push(args);
      scripts.push(stdin);
      const key = args[0] === "eval" ? "eval" : args.slice(0, 2).join(" ");
      const scripted = answers[key];
      return (Array.isArray(scripted) ? scripted.shift() : scripted) ?? { ok: false, error: "unexpected call" };
    };
    return { reader: browserPageReader(query), calls, scripts };
  }
  const box: Answer = { ok: true, data: { x: 1, y: 2, width: 3, height: 4 } };
  const found: Answer = { ok: true, data: { result: { found: true, label: "Send", role: "button", box: null, submits: true, search: false, card: false, multiline: true, fields: [] } } };
  const unseen: Answer = { ok: true, data: { result: { found: false } } };

  it("measures the selector with the engine, then reads the element in that box", async () => {
    const { reader, calls, scripts } = engine({ "get box": box, eval: found, "get url": { ok: true, data: { url: "https://example.com/a#b" } } });
    await expect(reader.target("@e4", false)).resolves.toMatchObject({ label: "Send", submits: true });
    expect(calls[0]).toEqual(["get", "box", "@e4"]);
    expect(calls[1]).toEqual(["eval", "--stdin"]);
    // The first read: the judging script, with this reader's own salt.
    expect(scripts[1]).toMatch(/\(\{"salt":"[0-9a-f]{16}","box":\{"x":1,"y":2,"width":3,"height":4\},"enter":false,"detail":false\}\)$/);
    await expect(reader.url()).resolves.toBe("https://example.com/a#b");
  });

  it("reads the focused element without measuring anything", async () => {
    const { reader, calls, scripts } = engine({ eval: found });
    await expect(reader.target(null, true)).resolves.toMatchObject({ label: "Send" });
    expect(calls).toHaveLength(1);
    expect(scripts[0]).toMatch(/"box":null,"enter":true,"detail":false\}\)$/);
  });

  it("says missing only when the engine itself finds no such element", async () => {
    const { reader, calls } = engine({ "get box": [
      { ok: false, error: "Unknown ref: e4" },
      { ok: false, error: "Element not found: #nope. Verify the selector, role, or name is correct and the element exists in the DOM." },
      { ok: false, error: "Could not get bounding box for: text=Send" },
    ] });
    await expect(reader.target("@e4", false)).resolves.toBe("missing");
    await expect(reader.target("#nope", false)).resolves.toBe("missing");
    await expect(reader.target("text=Send", false)).resolves.toBe("missing");
    expect(calls).toEqual([["get", "box", "@e4"], ["get", "box", "#nope"], ["get", "box", "text=Send"]]);
  });

  // The engine clicks the corner of a box with no area, and whatever
  // overflows it takes the click (agent-browser 0.37.0), so "no area" is
  // not "nothing there".
  it("says hidden, not missing, for an element the engine found that has no area", async () => {
    const { reader, calls } = engine({ "get box": { ok: true, data: { x: 8, y: 149, width: 0, height: 0 } } });
    await expect(reader.target("#zero", false)).resolves.toBe("hidden");
    expect(calls).toEqual([["get", "box", "#zero"]]);
  });

  // The engine accepts a selector of any length and one that starts with a
  // dash; this read hands it neither, so it must not call them missing.
  it("says unusable for a selector it will not hand to the engine, and never calls the engine with it", async () => {
    const { reader, calls } = engine({ "get box": box, eval: found });
    await expect(reader.target("--session=other-bot", false)).resolves.toBe("unusable");
    await expect(reader.target("-x,#send", false)).resolves.toBe("unusable");
    await expect(reader.target("", false)).resolves.toBe("unusable");
    await expect(reader.target(`#send${",#nope".repeat(400)}`, false)).resolves.toBe("unusable");
    await expect(reader.target("x".repeat(2_001), true)).resolves.toBe("unusable");
    expect(calls).toEqual([]);
    await expect(reader.target("x".repeat(2_000), false)).resolves.toMatchObject({ label: "Send" });
  });

  // The page script's own word for "this would act inside a frame I cannot
  // read". It is neither hidden (judged by a name) nor unreadable.
  it("says framed for the focus and for a selector alike, without looking twice", async () => {
    const framed: Answer = { ok: true, data: { result: { found: false, framed: true } } };
    const focus = engine({ eval: framed });
    await expect(focus.reader.target(null, true)).resolves.toBe("framed");
    const selector = engine({ "get box": box, eval: framed });
    await expect(selector.reader.target("#frame", false)).resolves.toBe("framed");
    expect(selector.calls.map((call) => call[0])).toEqual(["get", "eval"]);
  });

  it("looks twice before calling an element hidden, and reports no address when the engine will not say", async () => {
    const { reader, calls } = engine({ "get box": box, eval: unseen });
    await expect(reader.target("@e27", false)).resolves.toBe("hidden");
    expect(calls.map((call) => call[0])).toEqual(["get", "eval", "get", "eval"]);
    await expect(reader.url()).resolves.toBeNull();
  });

  it("finds the element on the second look when the page moved under the first", async () => {
    const { reader } = engine({ "get box": box, eval: [unseen, found] });
    await expect(reader.target("#send", false)).resolves.toMatchObject({ label: "Send" });
  });

  it("says unreadable, never missing, when the engine or the page did not really answer", async () => {
    const silent = engine({ "get box": { ok: false, error: "the browser did not answer in time" } });
    await expect(silent.reader.target("#send", false)).resolves.toBe("unreadable");
    const unknown = engine({ "get box": { ok: false, error: "Unknown subcommand: box" } });
    await expect(unknown.reader.target("#send", false)).resolves.toBe("unreadable");
    const garbled = engine({ "get box": { ok: true, data: { x: "1", y: 2, width: 3, height: 4 } } });
    await expect(garbled.reader.target("#send", false)).resolves.toBe("unreadable");
    const noEval = engine({ "get box": box, eval: { ok: false, error: "Evaluation error: SyntaxError" } });
    await expect(noEval.reader.target("#send", false)).resolves.toBe("unreadable");
    const threw = engine({ "get box": box, eval: { ok: true, data: { result: { found: false, error: "TypeError: x is not a function" } } } });
    await expect(threw.reader.target("#send", false)).resolves.toBe("unreadable");
    const odd = engine({ eval: { ok: true, data: { result: "not an object" } } });
    await expect(odd.reader.target(null, true)).resolves.toBe("unreadable");
    const noFocus = engine({ eval: unseen });
    await expect(noFocus.reader.target(null, true)).resolves.toBe("unreadable");
  });
});
