// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { browserPageReader, pageReadScript, parsePageTarget, type EngineQuery } from "./browser-commit-page.ts";

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

/** Run the fixed script the way the engine's eval does: as one expression. */
const run = (input: Parameters<typeof pageReadScript>[0]) => new Function(`return ${pageReadScript(input)}`)() as Record<string, unknown>;
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
      found: true, label: "Send", role: "button", box: null, submits: true, search: false, card: false, multiline: true,
      fields: [{ name: "Message", type: "textarea", value: "Hello there" }],
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
    expect(read.fields).toEqual([{ name: "Card number", type: "card", length: 16 }, { name: "Expiry", type: "text", value: "12/30" }]);
  });

  it("marks search, whether by the form's role or its only field", () => {
    expect(click("go")).toMatchObject({ label: "Search", submits: true, search: true });
    page.body.innerHTML = `<form><input id="only" type="search" aria-label="Find"><button id="find">Go</button></form>`;
    expect(run({ box: boxOf("find"), enter: false })).toMatchObject({ submits: true, search: true });
  });

  it("describes controls outside any form by their own label and role", () => {
    expect(click("icon")).toMatchObject({ found: true, label: "Send message", role: "button", submits: false, fields: [] });
    expect(click("share")).toMatchObject({ label: "Share", role: "link", submits: false });
    expect(click("news")).toMatchObject({ label: "Subscribe to the newsletter", role: "checkbox" });
  });

  it("says a click into a text box lands in a text box", () => {
    expect(click("msg")).toMatchObject({ label: "Message", role: "textbox", box: "multiline", submits: false });
    expect(click("composer")).toMatchObject({
      label: "Write a message", role: "textbox", box: "multiline", submits: false,
      fields: [{ name: "Write a message", type: "contenteditable", value: "draft text" }],
    });
  });

  it("answers found: false for a box no element has", () => {
    page.body.innerHTML = PAGE;
    expect(run({ box: { x: 900, y: 900, width: 5, height: 5 }, enter: false })).toEqual({ found: false });
  });

  it("reads Enter in a message box as typed there", () => {
    expect(focus("composer")).toMatchObject({ label: "Write a message", role: "textbox", box: "multiline", submits: false, multiline: true });
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

describe("the script as an engine argument", () => {
  // It is base64 on the engine's command line. Windows refuses a command
  // line over 32,767 characters, and a refused read refuses every click.
  it("stays well inside the longest command line Windows will start", () => {
    const script = pageReadScript({ box: { x: 1234.5678, y: 2345.6789, width: 345.6789, height: 45.6789 }, enter: false });
    expect(Buffer.from(script).toString("base64").length).toBeLessThan(26_000);
    expect(script).not.toMatch(/^\s*\/\//m);
  });
});

describe("parsePageTarget", () => {
  it("accepts only a found target and bounds everything the page wrote", () => {
    expect(parsePageTarget({ found: false })).toBeNull();
    expect(parsePageTarget("found")).toBeNull();
    expect(parsePageTarget({ found: true, label: "x".repeat(500), role: 7, box: "weird", submits: "yes", fields: [{ name: "n", type: "text", value: "v", length: "3" }, null, "x"] })).toEqual({
      label: "x".repeat(120), role: "", box: null, submits: false, search: false, card: false, multiline: false,
      fields: [{ name: "n", type: "text", value: "v" }],
    });
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
    const query: EngineQuery = async (args) => {
      calls.push(args);
      const key = args[0] === "eval" ? "eval" : args.slice(0, 2).join(" ");
      const scripted = answers[key];
      return (Array.isArray(scripted) ? scripted.shift() : scripted) ?? { ok: false, error: "unexpected call" };
    };
    return { reader: browserPageReader(query), calls };
  }
  const box: Answer = { ok: true, data: { x: 1, y: 2, width: 3, height: 4 } };
  const found: Answer = { ok: true, data: { result: { found: true, label: "Send", role: "button", box: null, submits: true, search: false, card: false, multiline: true, fields: [] } } };
  const unseen: Answer = { ok: true, data: { result: { found: false } } };

  it("measures the selector with the engine, then reads the element in that box", async () => {
    const { reader, calls } = engine({ "get box": box, eval: found, "get url": { ok: true, data: { url: "https://example.com/a#b" } } });
    await expect(reader.target("@e4", false)).resolves.toMatchObject({ label: "Send", submits: true });
    expect(calls[0]).toEqual(["get", "box", "@e4"]);
    expect(calls[1]!.slice(0, 2)).toEqual(["eval", "-b"]);
    expect(Buffer.from(calls[1]![2]!, "base64").toString()).toContain('{"box":{"x":1,"y":2,"width":3,"height":4},"enter":false}');
    await expect(reader.url()).resolves.toBe("https://example.com/a#b");
  });

  it("reads the focused element without measuring anything", async () => {
    const { reader, calls } = engine({ eval: found });
    await expect(reader.target(null, true)).resolves.toMatchObject({ label: "Send" });
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]![2]!, "base64").toString()).toContain('{"box":null,"enter":true}');
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
