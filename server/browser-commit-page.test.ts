// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { browserPageReader, pageReadScript, parsePageTarget, type EngineQuery } from "./browser-commit-page.ts";

/** The server's types carry no DOM. This is all of happy-dom the test touches. */
interface PageElement { focus(): void; getBoundingClientRect: () => unknown }
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
/** happy-dom lays nothing out, so the element the engine "measured" gets a box of its own. */
function boxOf(id: string) {
  const box = { x: 40, y: 80, width: 120, height: 24 };
  page.getElementById(id)!.getBoundingClientRect = () => box;
  return box;
}
const focus = (id: string) => { page.body.innerHTML = PAGE; page.getElementById(id)!.focus(); return run({ box: null, enter: true }); };
const click = (id: string) => { page.body.innerHTML = PAGE; return run({ box: boxOf(id), enter: false }); };

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

  it("says missing when the engine has no such element or it has no area, and never hands the engine a flag", async () => {
    const { reader, calls } = engine({ "get box": [
      { ok: false, error: "Unknown ref: e4" },
      { ok: false, error: "Element not found: #nope. Verify the selector, role, or name is correct and the element exists in the DOM." },
      { ok: false, error: "Could not get bounding box for: text=Send" },
      { ok: true, data: { x: 0, y: 0, width: 0, height: 0 } },
    ] });
    await expect(reader.target("@e4", false)).resolves.toBe("missing");
    await expect(reader.target("#nope", false)).resolves.toBe("missing");
    await expect(reader.target("text=Send", false)).resolves.toBe("missing");
    await expect(reader.target("#display-none", false)).resolves.toBe("missing");
    await expect(reader.target("--session=other-bot", false)).resolves.toBe("missing");
    await expect(reader.target("", false)).resolves.toBe("missing");
    await expect(reader.target("x".repeat(2_001), false)).resolves.toBe("missing");
    expect(calls).toEqual([["get", "box", "@e4"], ["get", "box", "#nope"], ["get", "box", "text=Send"], ["get", "box", "#display-none"]]);
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
