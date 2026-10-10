import { describe, expect, it } from "vitest";

import { classifyCommit, commitRule, commitRuleClass, enterPress, scriptAction, type CommitTarget } from "./browser-commit.ts";

const click = (label: string, extra: Partial<CommitTarget> = {}): CommitTarget => ({
  via: "click", label, role: "button", box: null, submits: false, search: false, card: false, multiline: false, ...extra,
});
const enter = (extra: Partial<CommitTarget> = {}): CommitTarget => ({
  via: "enter", label: "", role: "textbox", box: "single", submits: false, search: false, card: false, multiline: false, ...extra,
});

describe("classifyCommit", () => {
  it.each([
    "Send", "send", "SEND NOW", "Reply", "Post", "Post reply", "Publish", "Comment", "Share", "Message", "Submit",
    "Invite people", "Apply", "List item", "List  item", "Send message",
  ])("holds a click on %j as a send", (label) => {
    expect(classifyCommit(click(label))).toBe("send");
  });

  it.each([
    "Pay", "Pay now", "Buy", "Buy it now", "Place order", "Checkout", "Bid", "Book", "Reserve", "Subscribe", "Donate", "Transfer",
  ])("holds a click on %j as money", (label) => {
    expect(classifyCommit(click(label))).toBe("money");
  });

  it.each([
    "Posts", "Repost", "Resend", "Messages", "Comments (12)", "Sharepoint", "Facebook", "Payment methods", "Buyer protection",
    "Log in", "Next", "Continue", "Show details", "Search", "Veröffentlichen", "",
  ])("lets a click on %j through", (label) => {
    expect(classifyCommit(click(label))).toBeNull();
  });

  it("lets money win when a label matches both lists", () => {
    expect(classifyCommit(click("Submit and pay"))).toBe("money");
  });

  it("treats a link or a menu item like a button, and ignores toggles", () => {
    expect(classifyCommit(click("Share", { role: "link" }))).toBe("send");
    expect(classifyCommit(click("Reply", { role: "menuitem" }))).toBe("send");
    expect(classifyCommit(click("Subscribe to the newsletter", { role: "checkbox" }))).toBeNull();
    expect(classifyCommit(click("Message", { role: "tab" }))).toBeNull();
  });

  it("never holds a click that only puts the cursor in a text box", () => {
    expect(classifyCommit(click("Message", { role: "textbox", box: "multiline", multiline: true }))).toBeNull();
    expect(classifyCommit(click("Comment", { role: "textbox", box: "single" }))).toBeNull();
  });

  it("holds any submit on a form with a card field as money", () => {
    expect(classifyCommit(click("Continue", { submits: true, card: true }))).toBe("money");
    // The card field alone is not a commitment: only submitting its form is.
    expect(classifyCommit(click("Show details", { card: true }))).toBeNull();
    expect(classifyCommit(click("Card number", { role: "textbox", box: "single", card: true }))).toBeNull();
  });

  it("holds an unknown-language submit on a form with a multi-line field as a send", () => {
    expect(classifyCommit(click("Veröffentlichen", { submits: true, multiline: true }))).toBe("send");
    expect(classifyCommit(click("Veröffentlichen", { submits: true }))).toBeNull();
    expect(classifyCommit(click("Veröffentlichen", { multiline: true }))).toBeNull();
  });

  it("never treats search as a send, but still holds money there", () => {
    expect(classifyCommit(click("Submit", { submits: true, search: true }))).toBeNull();
    expect(classifyCommit(click("Go", { submits: true, search: true, multiline: true }))).toBeNull();
    expect(classifyCommit(click("Buy", { submits: true, search: true }))).toBe("money");
  });
});

describe("Enter", () => {
  it("is a send in a message or comment box, and nothing in a search box", () => {
    expect(classifyCommit(enter({ label: "Write a message", box: "multiline", multiline: true }))).toBe("send");
    expect(classifyCommit(enter({ label: "Search", role: "searchbox", box: "search", search: true }))).toBeNull();
    expect(classifyCommit(enter({ label: "Search", role: "textbox", box: "multiline", search: true }))).toBeNull();
  });

  it("with Shift is a new line in a message box", () => {
    expect(classifyCommit(enter({ label: "Write a message", box: "multiline", multiline: true, shift: true }))).toBeNull();
  });

  it("in a one-line field is judged by the form it submits", () => {
    // The label is the submit button's, not the field's own.
    expect(classifyCommit(enter({ label: "Log in", role: "button", submits: true }))).toBeNull();
    expect(classifyCommit(enter({ label: "Reply", role: "button", submits: true }))).toBe("send");
    expect(classifyCommit(enter({ label: "Continue", role: "button", submits: true, card: true }))).toBe("money");
    expect(classifyCommit(enter({ label: "Speichern", role: "button", submits: true, multiline: true }))).toBe("send");
    // Shift does not stop a form from submitting.
    expect(classifyCommit(enter({ label: "Reply", role: "button", submits: true, shift: true }))).toBe("send");
  });

  it("in a one-line field outside any form is not a commitment, whatever the field is called", () => {
    expect(classifyCommit(enter({ label: "Message" }))).toBeNull();
  });

  it("on a focused button acts like a click on it", () => {
    expect(classifyCommit(enter({ label: "Send", role: "button", box: null, submits: true, multiline: true }))).toBe("send");
    expect(classifyCommit(enter({ label: "", role: "document", box: null }))).toBeNull();
  });
});

describe("enterPress", () => {
  it.each(["Enter", "enter", "Return", "\n", "Control+Enter", "Meta+Enter", " Enter "])("reads %j as Enter", (key) => {
    expect(enterPress(key)).toEqual({ shift: false });
  });

  it("sees Shift in a chord", () => {
    expect(enterPress("Shift+Enter")).toEqual({ shift: true });
  });

  // agent-browser 0.37.0 takes the key from any part of a chord: "Enter+Shift"
  // is Shift+Enter, "Enter+Control" is Ctrl+Enter.
  it.each(["Enter+Control", "Enter+Alt", "Enter+Meta", "Return+Control", "\n+Alt", "Shift+Enter+Control", "NumpadEnter", "Enter+a"])("reads Enter in any position of %j", (key) => {
    expect(enterPress(key)).toEqual({ shift: false });
  });

  // Measured: Shift+Enter and Enter+Shift type a line break in a text area
  // and a contenteditable box. With any other modifier nothing is typed, so
  // the press is whatever the page makes of it.
  it("excuses Shift only as the one modifier, in either position", () => {
    expect(enterPress("Enter+Shift")).toEqual({ shift: true });
    expect(enterPress("Shift+Return")).toEqual({ shift: true });
    for (const key of ["Control+Shift+Enter", "Shift+Enter+Alt", "Meta+Shift+Enter", "Shift+Enter+Enter"]) expect(enterPress(key), key).toEqual({ shift: false });
  });

  it.each(["Tab", "Escape", "a", "Space", "Enterprise", "", "Control+a", 13, undefined, null])("ignores %j", (key) => {
    expect(enterPress(key)).toBeNull();
  });
});

describe("scriptAction", () => {
  it.each([
    ["document.querySelector('#send').click()", "click"],
    ["document.forms[0].submit()", "click"],
    ["form.requestSubmit ()", "click"],
    ["fetch('/api/pay', { method: 'POST' })", "network"],
    ["new XMLHttpRequest()", "network"],
    ["navigator.sendBeacon('/x', data)", "network"],
    ["new WebSocket('wss://example.com')", "network"],
    ["document.querySelector('textarea').value = 'hi'", "write"],
    ["input.value += 'more'", "write"],
    ["box.checked=true", "write"],
    ["editor.textContent = 'hi'", "write"],
    ["document.execCommand('insertText', false, 'hi')", "write"],
    ["el.dispatchEvent(new Event('input'))", "event"],
    ["location.href = 'https://example.com'", "navigation"],
    ["window.location = '/next'", "navigation"],
    ["location.assign('/next')", "navigation"],
    ["history.pushState({}, '', '/next')", "navigation"],
    ["window.open('https://example.com')", "navigation"],
  ] as const)("refuses %j as %s", (script, action) => {
    expect(scriptAction(script)).toBe(action);
  });

  it.each([
    "document.title",
    "location.href",
    "window.location.href === 'https://example.com/'",
    "[...document.querySelectorAll('input')].map((input) => input.value)",
    "document.querySelector('#price').textContent",
    "document.querySelector('input').value == ''",
    "document.querySelector('input').checked === true",
    "const location = document.querySelector('.location').textContent; location",
    "JSON.stringify({ value: 1, checked: true })",
    "document.querySelectorAll('button').length",
  ])("lets the read %j through", (script) => {
    expect(scriptAction(script)).toBeNull();
  });
});

describe("commitRule", () => {
  it("names the class in the decision log, and reads it back from any outcome", () => {
    expect(commitRule("send")).toBe("browser-commit:send");
    expect(commitRule("money", "page-changed")).toBe("browser-commit:money:page-changed");
    expect(commitRuleClass(commitRule("send", "daily-allowance:3/25"))).toBe("send");
    expect(commitRuleClass("browser-commit:money")).toBe("money");
  });

  it.each([undefined, "", "daily-cap:25", "browser-commit", "browser-commit:other", "scope:gmail:app"])("reads no class from %j", (rule) => {
    expect(commitRuleClass(rule)).toBeNull();
  });
});
