import { describe, expect, it } from "vitest";

import { chordPress, classifyCommit, commitRule, commitRuleClass, enterPress, isButtonRole, scriptAction, spacePress, type CommitTarget } from "./browser-commit.ts";

const click = (label: string, extra: Partial<CommitTarget> = {}): CommitTarget => ({
  via: "click", label, role: "button", box: null, submits: false, search: false, card: false, multiline: false, ...extra,
});
const enter = (extra: Partial<CommitTarget> = {}): CommitTarget => ({
  via: "enter", label: "", role: "textbox", box: "single", submits: false, search: false, card: false, multiline: false, ...extra,
});

describe("classifyCommit", () => {
  it.each([
    "Send", "send", "SEND NOW", "Reply", "Post", "Post reply", "Publish", "Comment", "Share", "Message", "Submit",
    "Invite people", "List item", "List  item", "Send message",
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

  it("never treats search as a commitment of either class", () => {
    expect(classifyCommit(click("Submit", { submits: true, search: true }))).toBeNull();
    expect(classifyCommit(click("Go", { submits: true, search: true, multiline: true }))).toBeNull();
    expect(classifyCommit(click("Buy", { submits: true, search: true }))).toBeNull();
    // A query that happens to be a card number does not make the search a payment.
    expect(classifyCommit(click("Search", { submits: true, search: true, card: true, button: true }))).toBeNull();
    expect(classifyCommit(enter({ label: "Search", role: "button", box: "search", submits: true, search: true, card: true }))).toBeNull();
  });
});

// Labels as shops, mail and social sites write them. The class is what a
// person would say the button does; null is a button that commits nothing.
describe("real button labels", () => {
  it.each([
    // Money: the list's own words, and the other ways sites say them.
    ["Pay", "money"], ["Pay now", "money"], ["Pay $12.00", "money"], ["Buy", "money"], ["Buy now", "money"], ["Buy it now", "money"],
    ["Place order", "money"], ["Place your order", "money"], ["Place Order & Pay", "money"], ["Purchase", "money"], ["Complete purchase", "money"],
    ["Complete your purchase", "money"], ["Purchase tickets", "money"], ["Order now", "money"], ["Order", "money"], ["Order again", "money"],
    ["Reorder", "money"], ["Pre-order", "money"], ["Checkout", "money"], ["Check out", "money"], ["Check out now", "money"], ["Check out as guest", "money"],
    ["Proceed to checkout", "money"], ["Confirm booking", "money"], ["Complete booking", "money"], ["Book now", "money"], ["Book a demo", "money"],
    ["Reserve a table", "money"], ["Confirm reservation", "money"], ["Subscribe", "money"], ["Donate now", "money"], ["Make a donation", "money"],
    ["Transfer", "money"], ["Place bid", "money"], ["Confirm order", "money"], ["Confirm your order", "money"], ["Complete order", "money"],
    ["Confirm and pay", "money"], ["Make a payment", "money"], ["Confirm purchase", "money"], ["Authorize payment", "money"], ["Finish checkout", "money"],
    // A money word lifts a send to money: these go out with money attached.
    ["Submit payment", "money"], ["Send payment", "money"], ["Send money", "money"], ["Submit order", "money"], ["Apply payment", "money"],
    // Send.
    ["Send", "send"], ["Send message", "send"], ["Reply", "send"], ["Reply all", "send"], ["Post", "send"], ["Post reply", "send"], ["Publish", "send"],
    ["Comment", "send"], ["Share", "send"], ["Submit", "send"], ["Invite", "send"], ["Apply now", "send"], ["List item", "send"],
    // Nothing: reading, moving on, managing. A money word that names a thing, not an act, holds nothing.
    ["Order history", null], ["Payment methods", null], ["Search", null], ["Next", null], ["Continue", null], ["Confirm", null], ["Cancel", null],
    ["Cancel order", null], ["Track order", null], ["View order", null], ["Your orders", null], ["Order summary", null], ["Booking details", null],
    ["Purchase history", null], ["Check out our new arrivals", null], ["Check out the docs", null], ["Bookmark", null], ["PayPal", null],
    ["Log in", null], ["Sign up", null], ["Add to cart", null], ["Save", null], ["Back", null], ["Close", null], ["Confirm email", null],
    ["Complete profile", null], ["Reservations", null], ["Donation receipts", null],
    // "Apply" where nothing is being submitted: a coupon, a filter.
    ["Apply", null], ["Apply coupon", null], ["Apply filters", null],
  ] as const)("reads %j as %s", (label, kind) => {
    expect(classifyCommit(click(label))).toBe(kind);
  });

  it("applies the same reading to the button Enter would press, and never to a toggle or a text box", () => {
    expect(classifyCommit(enter({ label: "Place your order", role: "button", submits: true }))).toBe("money");
    expect(classifyCommit(click("Send money", { role: "tab" }))).toBeNull();
    expect(classifyCommit(click("Order now", { role: "textbox", box: "single" }))).toBeNull();
  });

  it("still never treats search as a commitment", () => {
    expect(classifyCommit(click("Submit order", { submits: true, search: true }))).toBeNull();
    expect(classifyCommit(click("Send", { submits: true, search: true }))).toBeNull();
  });
});

describe("a card region", () => {
  const inRegion = (label: string, extra: Partial<CommitTarget> = {}) => click(label, { card: true, button: true, ...extra });

  // A form or region with a card field, a payment frame or a card number
  // in it. What a button there is called says nothing about what it does.
  it.each(["Continue", "Confirm", "Next", "OK", "Weiter", "", "Show details"])("holds a click on a button-like control labelled %j as money", (label) => {
    expect(classifyCommit(inRegion(label))).toBe("money");
    expect(classifyCommit(inRegion(label, { role: "link" }))).toBe("money");
    expect(classifyCommit(inRegion(label, { role: "generic" }))).toBe("money");
  });

  it("holds Enter and Space on such a control, and Enter in a one-line field there", () => {
    expect(classifyCommit(enter({ label: "Continue", role: "button", box: null, card: true, button: true }))).toBe("money");
    expect(classifyCommit(click("Continue", { card: true, button: true }))).toBe("money");
    expect(classifyCommit(enter({ label: "Card number", role: "textbox", box: "single", card: true }))).toBe("money");
  });

  it("holds a list or a tick box there whose own handler runs on change", () => {
    expect(classifyCommit(click("Plan", { role: "combobox", card: true, changes: true }))).toBe("money");
    expect(classifyCommit(click("Save this card", { role: "checkbox", card: true, changes: true }))).toBe("money");
  });

  it("lets through what only puts the cursor somewhere, or ticks a box nothing listens to", () => {
    expect(classifyCommit(click("Card number", { role: "textbox", box: "single", card: true }))).toBeNull();
    expect(classifyCommit(click("Notes", { role: "textbox", box: "multiline", card: true, multiline: true }))).toBeNull();
    expect(classifyCommit(click("Save this card", { role: "checkbox", card: true }))).toBeNull();
    expect(classifyCommit(click("Plan", { role: "combobox", card: true }))).toBeNull();
    // Plain text that is not a control and does not look like one.
    expect(classifyCommit(click("Order summary", { role: "generic", card: true }))).toBeNull();
  });

  it("holds none of this outside a card region", () => {
    for (const label of ["Continue", "Confirm", "Next"]) expect(classifyCommit(click(label, { button: true }))).toBeNull();
    expect(classifyCommit(click("Plan", { role: "combobox", changes: true }))).toBeNull();
  });
});

// The tuning pass: the hold is a guard against a bot over-acting on ordinary
// pages, and it has to stay out of the way of ordinary browsing.
describe("a plain link", () => {
  const link = (label: string, extra: Partial<CommitTarget> = {}) => click(label, { role: "link", button: true, link: true, ...extra });

  it.each(["Share", "Send", "Pay now", "Buy tickets", "Subscribe", "Post archive", "Order", "Book a demo"])("is never a commitment by its text: %j", (label) => {
    expect(classifyCommit(link(label))).toBeNull();
    // Enter or Space on it follows it, like a click.
    expect(classifyCommit(link(label, { via: "enter" }))).toBeNull();
  });

  it("is money inside a card region, like any other control there", () => {
    expect(classifyCommit(link("Terms", { card: true }))).toBe("money");
    expect(classifyCommit(link("Pay now", { card: true }))).toBe("money");
  });

  it("is judged as a button when it acts as one: the read does not call that a plain link", () => {
    expect(classifyCommit(click("Share", { role: "link", button: true }))).toBe("send");
    expect(classifyCommit(click("Pay now", { role: "link", button: true }))).toBe("money");
  });
});

describe("a harmless label on a form with a multi-line field", () => {
  it.each([
    "Save", "Save changes", "Update", "Next", "Continue", "Back", "Cancel", "Close", "Done", "OK", "Search", "Filter", "Sort", "Reset", "Clear",
    "Add", "Edit", "Preview", "Upload", "Sign in", "Log in", "Sign up", "Create account", "Register",
    // As sites write them.
    "SAVE", "Save changes…", "Next →", "‹ Back", "  Done  ", "Ok", "Sign-in", "Login",
  ])("lets %j through", (label) => {
    expect(classifyCommit(click(label, { submits: true, multiline: true }))).toBeNull();
    // Enter in a one-line field of that form acts through the same button.
    expect(classifyCommit(enter({ label, role: "button", submits: true, multiline: true }))).toBeNull();
  });

  it.each(["Go", "Speichern", "Veröffentlichen", "Enviar", "", "Save and continue editing", "Next step", "Finish"])("still holds %j: the label is not one it knows", (label) => {
    expect(classifyCommit(click(label, { submits: true, multiline: true }))).toBe("send");
  });

  it("still holds a label with a send or a spend word, whatever else it says", () => {
    expect(classifyCommit(click("Save and send", { submits: true, multiline: true }))).toBe("send");
    expect(classifyCommit(click("Update and publish", { submits: true, multiline: true }))).toBe("send");
    expect(classifyCommit(click("Confirm and pay", { submits: true, multiline: true }))).toBe("money");
  });

  // "Apply" is on the list of harmless labels, and the rule for Apply is the
  // more particular one: with a multi-line field, something is being submitted.
  it("holds Apply there all the same", () => {
    expect(classifyCommit(click("Apply", { submits: true, multiline: true }))).toBe("send");
  });

  it("changes nothing inside a card region", () => {
    for (const label of ["Save", "Continue", "Next", "OK", "Cancel"]) expect(classifyCommit(click(label, { submits: true, multiline: true, card: true, button: true })), label).toBe("money");
  });
});

describe("a sign-in form", () => {
  it.each(["Submit", "Send code", "Post", "Reply", "Message me a link", "Share"])("is never a send, whatever its button says: %j", (label) => {
    expect(classifyCommit(click(label, { submits: true, signin: true }))).toBeNull();
    expect(classifyCommit(enter({ label, role: "button", submits: true, signin: true }))).toBeNull();
    // The same button on a form that is no sign-in is a send.
    expect(classifyCommit(click(label, { submits: true }))).toBe("send");
  });

  it("is still money where it spends, and in a card region", () => {
    expect(classifyCommit(click("Pay now", { submits: true, signin: true }))).toBe("money");
    expect(classifyCommit(click("Submit payment", { submits: true, signin: true }))).toBe("money");
    expect(classifyCommit(click("Continue", { submits: true, signin: true, card: true, button: true }))).toBe("money");
  });
});

describe("Apply", () => {
  it.each(["Apply", "Apply filters", "Apply coupon", "Apply changes", "Apply code", "Apply to all"])("alone is not a send where nothing is being submitted: %j", (label) => {
    expect(classifyCommit(click(label))).toBeNull();
    expect(classifyCommit(click(label, { submits: true }))).toBeNull();
  });

  it("is a send where the form or region has a file to attach or a multi-line field", () => {
    expect(classifyCommit(click("Apply", { submits: true, carries: true }))).toBe("send");
    expect(classifyCommit(click("Apply", { carries: true }))).toBe("send");
    expect(classifyCommit(click("Apply", { submits: true, multiline: true }))).toBe("send");
  });

  it.each(["Apply now", "APPLY NOW", "Easy Apply", "Quick apply", "Apply today", "Apply online", "Apply for this job", "Apply for the role", "Apply to this position", "Submit application", "Send application"])("is a send when the label says an application goes out: %j", (label) => {
    expect(classifyCommit(click(label))).toBe("send");
  });

  it("still lifts to money beside what money is spent on", () => {
    expect(classifyCommit(click("Apply payment"))).toBe("money");
  });
});

describe("Enter in a multi-line field", () => {
  const box = (extra: Partial<CommitTarget> = {}) => enter({ label: "Text", box: "multiline", multiline: true, only: false, ...extra });

  it("is a new line when nothing says the field is a message composer", () => {
    expect(classifyCommit(box({ label: "Notes" }))).toBeNull();
    expect(classifyCommit(box({ label: "About you", only: true, says: "About you Tell us about yourself", near: ["Save changes", "Cancel"] }))).toBeNull();
    // A composer word, or a send button, beside other text fields: a form with a message in it, not a composer.
    expect(classifyCommit(box({ label: "Message", says: "Message", near: ["Send"] }))).toBeNull();
  });

  it.each([
    ["its keyboard hint says send", { hint: true }],
    ["it is the only text field there and a send-labelled control is there too", { only: true, near: ["Attach", "Send"] }],
    ["it is the only text field there and its label has a composer word", { only: true, label: "Message #general" }],
    ["it is the only text field there and its placeholder has one", { only: true, says: "Editor Write a reply…" }],
    ["it is the only text field there and it is a comment box", { only: true, says: "Add a comment" }],
    ["it is the only text field there and it is a chat box", { only: true, says: "Chat with us" }],
  ])("is a send when %s", (_what, extra) => {
    expect(classifyCommit(box(extra))).toBe("send");
    // Shift+Enter is a new line even there.
    expect(classifyCommit(box({ ...extra, shift: true }))).toBeNull();
  });

  it("is a send when the read said nothing of the field: not knowing is not a new line", () => {
    expect(classifyCommit(enter({ label: "Notes", box: "multiline", multiline: true }))).toBe("send");
  });

  it("is a send with any key but Shift held, composer or not: that is never a new line", () => {
    expect(classifyCommit(box({ label: "Notes", chord: true }))).toBe("send");
    expect(classifyCommit(box({ label: "Notes", chord: true, only: true }))).toBe("send");
  });

  it("is nothing in a search box, as before", () => {
    expect(classifyCommit(box({ label: "Search", search: true, hint: true }))).toBeNull();
  });

  // Nothing is relaxed inside a card region: there Enter in any multi-line
  // field is held as it was before the field had to be a composer.
  it("is held inside a card region, composer or not", () => {
    expect(classifyCommit(box({ label: "Delivery notes", card: true }))).toBe("send");
    expect(classifyCommit(box({ label: "Delivery notes", card: true, shift: true }))).toBeNull();
  });
});

describe("chordPress", () => {
  it.each(["Control+Enter", "Enter+Control", "Meta+Enter", "Alt+Return", "Shift+Control+Enter", "Enter+a"])("reads %j as Enter with another key held", (key) => {
    expect(chordPress(key)).toBe(true);
  });

  it.each(["Enter", "Return", "\n", "Shift+Enter", "Enter+Shift", " Enter ", "Tab", "Control+a", "", 13, null, undefined])("does not read %j as one", (key) => {
    expect(chordPress(key)).toBe(false);
  });
});

describe("the labels added in the tuning pass", () => {
  it.each([
    "Place bet", "Place a bet", "Place bets", "Deposit", "Deposit funds", "Withdraw", "Top up", "Top-up", "Add funds", "Upgrade", "Upgrade plan", "Start free trial",
    "Start your free trial", "Renew", "Renew now", "Get tickets", "Sell", "Trade", "Sign transaction", "Charge", "Charge card",
  ])("holds %j as money", (label) => {
    expect(classifyCommit(click(label))).toBe("money");
  });

  it.each(["Forward", "Tweet", "Notify", "Notify team", "Accept invitation"])("holds %j as a send", (label) => {
    expect(classifyCommit(click(label))).toBe("send");
  });

  it.each(["Confirm", "Continue", "Complete", "Approve", "Authorize", "Agree & Continue"])("leaves %j out of the lists: money only inside a card region", (label) => {
    expect(classifyCommit(click(label))).toBeNull();
    expect(classifyCommit(click(label, { submits: true }))).toBeNull();
    expect(classifyCommit(click(label, { card: true, button: true }))).toBe("money");
  });

  it.each(["Upgrades", "Seller", "Trademark", "Discharge", "Renewal", "Deposits", "Forwarded", "Tweets", "Notifications"])("still matches whole words only: %j", (label) => {
    expect(classifyCommit(click(label))).toBeNull();
  });
});

describe("Space", () => {
  // agent-browser 0.37.0 presses the space bar for each of these, and with
  // the focus on a button that clicks it.
  it.each(["Space", "space", "SPACE", " ", "Shift+Space", "Space+Shift", "Control+Space", "Alt+ ", "Spacebar"])("reads %j as a Space press", (key) => {
    expect(spacePress(key)).toBe(true);
  });

  it.each(["Enter", "a", "Backspace", "", "Tab", "Shift+a", "Spaces", 32, null, undefined])("does not read %j as one", (key) => {
    expect(spacePress(key)).toBe(false);
  });
});

describe("isButtonRole", () => {
  it("is true for what a click activates, by the names a snapshot gives", () => {
    for (const role of ["button", "link", "menuitem"]) expect(isButtonRole(role), role).toBe(true);
    for (const role of ["textbox", "searchbox", "checkbox", "combobox", "tab", "option", "Iframe", "generic", "", "heading"]) expect(isButtonRole(role), role).toBe(false);
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

  // A guard against habit, not a wall: the families a bot reaches for when
  // the click tool is held.
  it.each([
    ["$.post('/api/send', { to: 'ada' })", "network"],
    ["jQuery.ajax({ url: '/pay', method: 'POST' })", "network"],
    ["$.ajax('/pay')", "network"],
    ["$.get('/unsubscribe?id=7')", "network"],
    ["$.getJSON('/api/orders')", "network"],
    ["axios.post('/api/send', body)", "network"],
    ["axios({ method: 'post', url: '/pay' })", "network"],
    ["window.axios.request(config)", "network"],
    ["$('#send').trigger('click')", "event"],
    ["jQuery(form).trigger(\"submit\")", "event"],
    ["$('#send').triggerHandler('click')", "event"],
    ["el.onclick()", "click"],
    ["document.querySelector('#send').onclick(new MouseEvent('click'))", "click"],
    ["form.onsubmit.call(form, event)", "click"],
    ["button.onclick.apply(button)", "click"],
    ["input.onchange()", "event"],
    ["box.onkeydown({ key: 'Enter' })", "event"],
    ["el.setAttribute('aria-label', 'Next')", "write"],
    ["button.removeAttribute('disabled')", "write"],
    ["el.toggleAttribute('hidden')", "write"],
    ["el.setAttributeNS(null, 'role', 'tab')", "write"],
    ["button.ariaLabel = 'Next'", "write"],
    ["button.role = 'tab'", "write"],
    ["field.type = 'search'", "write"],
    ["card.autocomplete = 'off'", "write"],
    ["el.outerHTML = '<span>Next</span>'", "write"],
  ] as const)("refuses %j as %s", (script, action) => {
    expect(scriptAction(script)).toBe(action);
  });

  it.each([
    "document.querySelector('button').getAttribute('aria-label')",
    "el.hasAttribute('disabled')",
    "[...document.querySelectorAll('[onclick]')].length",
    "document.querySelector('#send').onclick !== null",
    "typeof el.onclick",
    "el.ariaLabel",
    "button.role === 'tab'",
    "input.type == 'search'",
    "[...document.querySelectorAll('input')].map((input) => ({ name: input.name, type: input.type, role: input.role }))",
    "$('#price').text()",
    "jQuery('.item').length",
    "typeof axios",
    "document.querySelector('.axios-badge').textContent",
    "el.outerHTML",
    "document.getElementById('user').focus()",
  ])("lets the read %j through", (script) => {
    expect(scriptAction(script)).toBeNull();
  });

  // A script that builds its own result object is a read, whatever its
  // properties are called; so is a call that only looks like a handler.
  it.each([
    "const out = {}; out.type = el.type; out.value = el.value; out",
    "const row = {}; row.value = cell.innerText; row",
    "const r = {}; r.role = el.getAttribute('role'); r",
    "const list = []; list.type = 'rows'; list",
    "[...document.querySelectorAll('tr')].map((tr) => { const row = {}; row.value = tr.cells[1].innerText; row.checked = tr.querySelector('input').checked; return row; })",
    "emitter.once('ready', done)",
    "new Promise((resolve) => bus.once('loaded', resolve))",
    "x.onload()",
    "img.onerror()",
    "typeof worker.onmessage",
  ])("lets the read %j through", (script) => {
    expect(scriptAction(script)).toBeNull();
  });

  // The same shapes when the thing written to, or called on, is the page.
  it.each([
    ["el.type = 'search'", "write"],
    ["const out = document.querySelector('input'); out.value = 'x'", "write"],
    ["let out = {}; out = document.body; out.innerHTML = ''", "write"],
    ["var out = {}; out.value = 1; document.querySelector('input').value = out.value", "write"],
    ["const out = {}; out.el = document.querySelector('input'); out.el.value = 'x'", "write"],
    ["const out = {}; document.querySelector('#to').value = 'mallory@example.com'", "write"],
    ["const out = {}; rows.forEach((row) => { row.checked = true; })", "write"],
    ["x.onclick()", "click"],
    ["form.onsubmit()", "click"],
    ["x.onchange()", "event"],
    ["el.oninput.call(el)", "event"],
    ["node.onkeydown({ key: 'Enter' })", "event"],
    ["btn.onpointerdown()", "event"],
    ["el.onmouseup.apply(el)", "event"],
    ["el.onfocus()", "event"],
  ] as const)("still refuses %j as %s", (script, action) => {
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
