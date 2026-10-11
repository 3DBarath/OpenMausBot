// The commit hold against an actual browser, always in a disposable fixture
// HOME: real agent-browser, real Chrome, real harness, fake model CLI parked
// mid-turn. Drives the turn's own browser route the way its MCP proxy does,
// answers the cards through the respond route, prints what happened as JSON
// and exits non-zero when anything is not as documented in
// docs/verification/browser-commit-hold.md: the walkthrough stops at its
// first surprise, and after it every case runs and reports on its own.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { promisify } from "node:util";

import { launchVerificationServer } from "./control-omb.ts";

const binaryPath = process.env.OMB_VERIFY_BROWSER_BINARY;
const executablePath = process.env.OMB_VERIFY_BROWSER_CHROME;
if (!binaryPath || !executablePath) throw new Error("Set OMB_VERIFY_BROWSER_BINARY and OMB_VERIFY_BROWSER_CHROME to explicit installed binaries.");

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Commit hold test</title>
<form id="message"><label for="body">Message</label><textarea id="body" name="body">Hello from the fixture</textarea><button>Send</button></form>
<form id="find" role="search"><input type="search" aria-label="Search" value="shoes"><button>Search</button></form>
<section aria-label="Chat"><div id="composer" contenteditable="true" role="textbox" aria-label="Write a message">On my way</div></section>
<button id="details" type="button">Show details</button>
<button id="later" type="button">Change the draft in a moment</button>
<output id="log"></output>
<script>
  document.getElementById("later").addEventListener("click", () => setTimeout(() => { document.getElementById("composer").textContent = "Edited while the card was open"; }, 1500));
  for (const form of document.forms) form.addEventListener("submit", (event) => { event.preventDefault(); document.getElementById("log").textContent = "submitted:" + form.id; });
  document.getElementById("composer").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); document.getElementById("log").textContent = "sent:composer"; } });
</script></html>`;

/** Every case page reports what it did here; a form marked data-real really submits. */
const LOG = `<output id="log"></output><output id="state"></output><script>
  window.note = (text) => { const log = document.getElementById("log"); log.textContent = (log.textContent ? log.textContent + " " : "") + text; };
  document.addEventListener("submit", (event) => { if (event.target.dataset.real) return; event.preventDefault(); window.note("submitted:" + event.target.getAttribute("id")); }, true);
</script>`;
const doc = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title>${body}${LOG}</html>`;
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
/** A second origin, for a frame the page around it cannot read: a payment
 * frame as a shop embeds one. Its form really posts, to this origin. */
let framedPaid = 0;
const FRAME_PAGES: Record<string, string> = {
  // A whole payment form, as a shop embeds one.
  "/pay-frame": `<form id="pay" onsubmit="event.preventDefault(); fetch('/framed-paid', { method: 'POST' });">
    <input id="card" aria-label="Card number" value="4242424242424242"><input id="cvc" aria-label="CVC" value="123"><button>Pay</button></form>`,
  // One hosted field, as a processor puts each card field in a frame of its own.
  "/card-number-frame": `<input id="card" aria-label="Card number">`,
  // A payment frame whose button says nothing about money.
  "/continue-frame": `<button type="button" onclick="fetch('/framed-paid', { method: 'POST' })">Continue</button>`,
  // A payment brand's message, as a shop page carries one beside the price.
  "/message-frame": `<p>4 interest-free instalments of $10. <a href="/pay-frame">Learn more</a></p>`,
  // Frames that are nothing to do with paying, served from addresses with a payment word in them.
  "/pay/widget": `<p>Rated 4.8 by 312 buyers.</p>`,
  "/checkout/advert": `<p>Summer sale: 20% off lamps.</p>`,
};
const frameSite = createServer((req, res) => {
  req.resume();
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (path === "/framed-paid") { framedPaid += 1; res.end("ok"); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Payment frame</title>${FRAME_PAGES[path] ?? FRAME_PAGES["/pay-frame"]}</html>`);
});
await new Promise<void>((resolve) => frameSite.listen(0, "127.0.0.1", resolve));
/** Reached as localhost, so it is another site than the page at 127.0.0.1, not only another port. */
const frameOrigin = `http://localhost:${(frameSite.address() as { port: number }).port}`;

/** A headline longer than the 120 characters a label is cut to, with words from the lists in it. */
const LONG_HEADLINE = "How to share and post your first message with the new publishing tools: a complete walk-through for people who have never sent one before today";
/** Frames from another site that speak of payment or checkout and are no brand's own: the page around each is a card region. */
const STRICT_FRAMES = ["Checkout", "Payment", "Secure payment", "Payment button frame", "Checkout message", "Klarna payments", "PayPal card fields"];
/** Everyday buttons on a form with a text area: none of them sends anything. */
const EVERYDAY = ["Save draft", "Translate", "Generate", "Check grammar", "Update profile", "Add note"];
/** One local page per reviewer scenario (docs/verification/browser-commit-hold.md, "Cases"). */
const CASE_PAGES: Record<string, string> = {
  // The Email field is the first thing on the page, as the card field is the
  // first thing in the frame: the engine measures an element in a frame from
  // the frame's own corner, so it gives both fields the same box.
  "/frame-checkout": doc("Checkout", `<div><input id="before" aria-label="Email" value="ada@example.com"></div><iframe id="payframe" title="Secure payment" src="${frameOrigin}/pay-frame" width="420" height="120"></iframe>`),
  "/inner-checkout": doc("Checkout", `<div><input id="before" aria-label="Email" value="ada@example.com"></div><iframe id="inner" title="Billing" src="/inner-pay" width="420" height="120"></iframe>`),
  "/inner-pay": `<!doctype html><html lang="en"><meta charset="utf-8"><title>Order frame</title><form id="pay" onsubmit="event.preventDefault(); parent.note('submitted:inner');">
    <input id="card" aria-label="Card number" autocomplete="cc-number" value="4242424242424242"><button>Pay</button></form></html>`,
  "/plain-card-form": doc("Card form", `<form id="order"><input aria-label="Name on card" value="Ada Lovelace"><input aria-label="Card number" value="1234 5678 9012 3456"><input aria-label="Expiry (MM/YY)" value="12/30"><input aria-label="CVC" value="123"><button>Continue</button></form>
    <form id="lookup"><input name="ref" aria-label="Reference" value="4242 4242 4242 4242"><button>Look up</button></form>
    <form id="library"><input aria-label="Library card number" value="20451900"><input aria-label="PIN" value="4821"><button>Log in</button></form>`),
  // The walkthrough's second page: a sign-in and a card form. Nothing on it is ever pictured.
  "/account": doc("Account", `<form id="login"><label for="user">Username</label><input id="user" value="ada"><label for="pw">Password</label><input id="pw" type="password" value="not-a-real-secret"><button>Log in</button></form>
    <form id="pay"><label for="cc">Card number</label><input id="cc" autocomplete="cc-number" value="4111111111111111"><button>Continue</button></form>`),
  "/enter-on-controls": doc("Enter on a control", `<form id="buy"><label><input id="agree" type="checkbox"> I agree</label>
    <label><input id="gift" type="radio" name="wrap"> Gift wrap</label><select id="size" aria-label="Size"><option>S<option>M</select>
    <input id="qty" type="range" aria-label="Quantity"><button>Buy now</button></form>`),
  "/check": doc("Check and uncheck", `<form id="note"><textarea aria-label="Note">Remember the milk</textarea><button id="send">Send</button></form>
    <form id="prefs"><textarea aria-label="Reply">Thanks</textarea><label><input id="notify" type="checkbox" checked onchange="this.form.requestSubmit()"> Notify me</label></form>`),
  "/chords": doc("Enter chords", `<form id="quick"><textarea aria-label="Notes">n</textarea><input id="title" aria-label="Title" value="Hello"><button>Post</button></form>
    <div id="composer" contenteditable="true" role="textbox" aria-label="Write a message">On my way</div>
    <script>document.getElementById("composer").addEventListener("keydown", (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey || !event.shiftKey)) { event.preventDefault(); window.note("sent:composer"); } });</script>`),
  "/pay": doc("Pay", `<form id="pay" method="post" action="/paid" data-real="1"><input type="hidden" name="amount" value="5"><button>Pay</button></form>`),
  "/elsewhere": doc("Elsewhere", `<p>Nothing to send here.</p>`),
  "/odd-targets": doc("Odd targets", `<form id="memo"><textarea aria-label="Memo">Hi</textarea><button id="send">Send</button></form>
    <button id="zero" type="button" style="width:0;height:0;padding:0;border:0;overflow:visible;position:relative" onclick="note('clicked:zero')"><span style="position:absolute;left:0;top:0;width:90px;height:22px;display:block">Send C</span></button>`),
  "/stacked": doc("Stacked", `<div style="display:grid;width:200px"><button id="vis" type="button" style="grid-area:1/1" onclick="note('clicked:send')">Send</button><button id="hid" type="button" style="grid-area:1/1;visibility:hidden" onclick="note('clicked:cancel')">Cancel</button></div>`),
  "/image-submit": doc("Image submit", `<form id="order"><input id="name" aria-label="Name" value="Ada"><input id="card" aria-label="Card number" autocomplete="cc-number" value="4111111111111111"><input type="image" alt="Continue" src="${PIXEL}"></form>
    <form id="ext"><textarea aria-label="Comment">Nice</textarea><input id="who" aria-label="Name" value="Ada"><input id="mail" aria-label="Email" value="ada@example.com"></form><button form="ext" id="outside">Send</button>`),
  "/frame": doc("Frame", `<iframe id="frame" title="Tip jar" width="300" height="80" srcdoc="<button onclick=&quot;parent.note('paid:frame')&quot;>Pay</button>"></iframe>`),
  "/auto-select": doc("Auto select", `<form id="quick"><textarea aria-label="Message">Running late</textarea><select id="when" aria-label="When" onchange="this.form.requestSubmit()"><option>later<option>now</select></form>`),
  "/clobbered": doc("Clobbered", `<form id="clob"><input name="tagName" value="1"><input name="elements" value="2"><input name="action" value="3"><input name="id" value="4"><input name="closest" value="5"><input name="querySelectorAll" value="6">
    <textarea aria-label="Feedback">Great</textarea><button id="go">Send</button></form>`),
  "/shop": doc("Shop", `<ul id="list"><li>Sticker $1 <button type="button" onclick="note('bought:sticker')">Buy now</button></li><li>Laptop $18,000 <button type="button" onclick="note('bought:laptop')">Buy now</button></li></ul>
    <button id="resort" type="button">Sort by price in a moment</button>
    <script>document.getElementById("resort").addEventListener("click", () => setTimeout(() => {
      const list = document.getElementById("list"); list.innerHTML = list.lastElementChild.outerHTML + list.firstElementChild.outerHTML;
      document.getElementById("state").textContent = "changed";
    }, 1500));</script>`),
  "/dm": doc("Direct message", `<div role="dialog" aria-label="New message"><input id="to" aria-label="To" value="ada@example.com"><div id="body" contenteditable="true" role="textbox" aria-label="Message body">Lunch at one?</div><div id="send" role="button" tabindex="0">Send</div></div>
    <button id="swap" type="button">Swap the draft in a moment</button>
    <script>document.getElementById("send").addEventListener("click", () => window.note("sent:" + document.getElementById("to").value + ":" + document.getElementById("body").textContent));
    document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("to").value = "mallory@example.com"; document.getElementById("body").textContent = "Wire the money"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/long-form": doc("Long form", `<form id="long"><textarea aria-label="Essay">${"long ".repeat(600)}</textarea>
    ${Array.from({ length: 35 }, (_, index) => `<input id="f${index + 1}" aria-label="Field ${index + 1}" value="value ${index + 1}">`).join("")}<button>Send</button></form><button id="edit" type="button">Edit field 33 in a moment</button>
    <script>document.getElementById("edit").addEventListener("click", () => setTimeout(() => { document.getElementById("f33").value = "CHANGED"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/secrets": doc("Secrets", `<form id="checkout"><input name="cardnumber" aria-label="Number" value="4242424242424242"><input id="cvc" placeholder="CVC" value="9173">
    <input aria-label="Code from your phone" autocomplete="one-time-code" value="246810"><input type="text" id="password" aria-label="Sign-in secret" value="correct-horse-battery">
    <input aria-label="Reference" value="5555 5555 5555 4444"><input aria-label="PIN" value="4821"><input aria-label="Name on card" autocomplete="cc-name" value="ADA LOVELACE">
    <input aria-label="City" value="Baramati"><button>Pay</button></form>`),
  // ── The tuning pass: ordinary pages, and what must pass on them ──
  "/ordinary-links": doc("Ordinary links", `<nav><a href="/elsewhere">Share prices</a> <a href="/elsewhere?blog">Blog post</a> <a href="/elsewhere?buy">Buy tickets</a></nav>
    <p><a id="hash" href="#">Send</a></p><script>document.getElementById("hash").addEventListener("click", (event) => { event.preventDefault(); window.note("sent:link"); });</script>`),
  "/ordinary-forms": doc("Ordinary forms", `<form id="profile"><input aria-label="Name" value="Ada"><textarea aria-label="About you">I write software.</textarea><button>Save changes</button></form>
    <form id="filters"><select aria-label="Sort by"><option>Newest</option><option>Price</option></select><label><input type="checkbox" checked> In stock</label><button>Apply</button></form>
    <form id="login"><input aria-label="Email" value="ada@example.com"><input type="password" aria-label="Password" value="correct-horse"><button>Submit</button></form>
    <form id="signup"><input aria-label="Work email" value="ada@example.com"><input type="password" aria-label="Choose a password" value="correct-horse"><button>Continue</button></form>
    <form id="notes"><input aria-label="Title" value="Tuesday"><textarea id="note" aria-label="Notes">Bring the charger</textarea><button>Save</button></form>`),
  "/ordinary-sends": doc("Ordinary sends", `<section aria-label="Chat"><div id="chat" contenteditable="true" role="textbox" aria-label="Message #general">On my way</div><button type="button" aria-label="Send now" onclick="note('sent:chat')">➤</button></section>
    <form id="comment"><textarea aria-label="Add a comment">Looks good</textarea><button>Comment</button></form>
    <form id="mail"><input aria-label="To" value="ada@example.com"><input aria-label="Subject" value="Lunch"><textarea aria-label="Body">At one?</textarea><button>Send</button></form>
    <form id="job"><input aria-label="Full name" value="Ada Lovelace"><input type="file" aria-label="CV"><button>Apply</button></form>
    <script>document.getElementById("chat").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); window.note("sent:chat"); } });</script>`),
  "/ordinary-money": doc("Ordinary money", `<section><form id="cart"><input aria-label="Email" value="ada@example.com"><button>Pay now</button></form></section>
    <section><button type="button" onclick="note('upgraded')">Upgrade</button> <button type="button" onclick="note('confirmed')">Confirm</button></section>`),
  "/ordinary-card": doc("Ordinary card", `<form id="card"><input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc"><button type="button" onclick="note('continued')">Continue</button></form>`),
  // ── Round seven ──
  // The Pay now button is enabled a moment after typing stops: between the gate's look at the page and its key press, at some delays.
  ...Object.fromEntries([0, 50, 150].map((delay) => [`/tip-later-${delay}`, doc("Tip", `<form id="tip"><input id="amount" aria-label="Amount"><button id="pay" disabled>Pay now</button></form>
    <script>let timer; document.getElementById("amount").addEventListener("input", (event) => { clearTimeout(timer); const on = Boolean(event.target.value);
      timer = setTimeout(() => { document.getElementById("pay").disabled = !on; }, ${delay}); });</script>`)])),
  // The same kind of button on forms that send nothing and pay for nothing.
  "/gated-plain": doc("Gated", `<form id="find" role="search"><input id="q" type="search" aria-label="Search"><button id="go" disabled>Search</button></form>
    <form id="login"><input aria-label="Email" value="ada@example.com"><input id="pw" type="password" aria-label="Password"><button id="in" disabled>Log in</button></form>
    <script>for (const [field, button] of [["q", "go"], ["pw", "in"]]) document.getElementById(field).addEventListener("input", (event) => { setTimeout(() => { document.getElementById(button).disabled = !event.target.value; }, 50); });</script>`),
  // A frame that calls itself a checkout, whose address only mentions a wallet button's address.
  "/borrowed-address": doc("Order", `<main><h1>Your order</h1><button type="button" onclick="note('continued')">Continue</button>
    <iframe title="Checkout" src="${frameOrigin}/message-frame?next=https://pay.google.com/gp/p/ui/pay&from=https://www.paypal.com/smart/buttons" width="320" height="60"></iframe></main>`),
  // ── Round six ──
  // A button that is disabled until its field has text: what Enter does there cannot be told before the text is in.
  "/tip": doc("Tip", `<form id="tip"><input id="amount" aria-label="Amount"><button id="pay" disabled>Pay now</button></form>
    <script>document.getElementById("amount").addEventListener("input", (event) => { document.getElementById("pay").disabled = !event.target.value; });</script>`),
  "/ask": doc("Ask", `<form id="ask"><input id="q" aria-label="Ask anything"><button id="send" disabled>Send</button></form>
    <script>document.getElementById("q").addEventListener("input", (event) => { document.getElementById("send").disabled = !event.target.value; });</script>`),
  "/wallet-frames": doc("Desk lamp", `<main><h1>Desk lamp</h1><p>$40.00</p><button type="button" onclick="note('added')">Add to cart</button> <a href="/elsewhere">Buy tickets for the launch</a>
    <iframe title="Shop Pay" src="${frameOrigin}/continue-frame" width="320" height="50"></iframe>
    <iframe title="Donate with PayPal" src="${frameOrigin}/message-frame" width="320" height="40"></iframe>
    <iframe title="Reviews" src="${frameOrigin}/pay/widget" width="320" height="40"></iframe>
    <iframe title="Advertisement" src="${frameOrigin}/checkout/advert" width="320" height="40"></iframe></main>`),
  // ── Round five ──
  "/typed-apart": doc("Typed apart", `<form id="find" role="search"><input id="q" type="search" aria-label="Search"></form>
    <form id="login"><input id="user" aria-label="Email" value="ada@example.com"><input id="pw" type="password" aria-label="Password"><button>Log in</button></form>
    <section aria-label="Chat"><div id="chat" contenteditable="true" role="textbox" aria-label="Message #general"></div></section>
    <fieldset disabled><form id="dis"><input id="disabled-in" aria-label="Disabled field"></form></fieldset>
    <form id="pay"><input id="amount" aria-label="Amount" value="5"><button>Pay now</button></form>
    <button id="open" type="button" onclick="document.getElementById('dlg').showModal()">Open the offer</button>
    <dialog id="dlg"><form id="buy"><input id="coupon" aria-label="Coupon"><button id="buynow">Buy now</button></form></dialog>
    <script>document.getElementById("chat").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); window.note("sent:chat:" + event.target.textContent); } });</script>`),
  ...Object.fromEntries(STRICT_FRAMES.map((title, index) => [`/unknown-frame-${index}`, doc("Order", `<main><h1>Your order</h1><p>Lamp, $40.00</p>
    <button type="button" onclick="note('continued')">Continue</button><iframe title="${title}" src="${frameOrigin}/message-frame" width="320" height="60"></iframe></main>`)])),
  // A click that keeps the page busy for longer than a browser call may take (120 s).
  "/freeze": doc("Slow report", `<button id="freeze" type="button" onclick="const end = Date.now() + 125000; while (Date.now() < end) {} note('thawed')">Show details</button>
    <form id="message"><textarea aria-label="Message">Hello</textarea><button>Send</button></form>`),
  "/tab-scheme": doc("Tab scheme", `<p><a id="pay" href="java&#9;script:note('paid')">Pay now</a> <a id="data" href="data:text/html,<p>sent</p>">Send</a></p>`),
  "/header-search": doc("Messages", `<header><input type="search" aria-label="Search the site"> <nav><input aria-label="Jump to a page"></nav></header>
    <div id="box" contenteditable="true" role="textbox" aria-label="Write a message">Hello</div><footer><input aria-label="Newsletter email"></footer>
    <script>document.getElementById("box").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); window.note("sent"); } });</script>`),
  "/mail-form": doc("Mail", `<header><input type="search" aria-label="Search mail"></header><form id="mail"><input aria-label="To" value="ada@example.com"><input aria-label="Subject" value="Lunch"><textarea id="body" aria-label="Body">At one?</textarea><button>Send</button></form>`),
  // ── Round four: one page per reviewer finding A to L ──
  "/typed-unfocused": doc("Typed, not focused", `<form id="find" role="search"><input id="q" type="search" aria-label="Search"></form>
    <fieldset disabled><form id="dis"><input id="disabled-in" aria-label="Disabled field"></form></fieldset>
    <div inert><form id="in"><input id="inert-in" aria-label="Inert field"></form></div>
    <form id="hid"><input id="hidden-in" aria-label="Hidden field" style="visibility:hidden"></form>
    <form id="pay"><input id="amount" aria-label="Amount" value="5"><button>Pay now</button></form>
    <button id="open" type="button" onclick="document.getElementById('dlg').showModal()">Open the offer</button>
    <dialog id="dlg"><form id="buy"><p>Buy it?</p><button id="buynow">Buy now</button></form></dialog>`),
  "/search-card": doc("Search and card", `<form id="addr"><input type="search" id="finder" aria-label="Find your address"><input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc"><button>Pay now</button></form>
    <form id="promo"><input role="searchbox" id="code" aria-label="Promo code"><input aria-label="Card number" autocomplete="cc-number"><button>Continue</button></form>
    <div role="search"><form id="inside"><input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc"><button>Continue</button></form></div>
    <form id="only"><input type="search" id="product" aria-label="Find a product"><button>Buy now</button></form>`),
  "/shop-frames": doc("Desk lamp", `<main><h1>Desk lamp</h1><p>$40.00</p>
    <select id="size" aria-label="Size" onchange="note('size:' + this.value)"><option>Small</option><option>Large</option></select>
    <button type="button" aria-label="Increase quantity" onclick="note('plus')">+</button>
    <button type="button" onclick="note('added')">Add to cart</button>
    <div role="button" tabindex="0" onclick="note('opened')">Shipping details</div>
    <p><a href="/elsewhere">Read the reviews</a></p>
    <iframe title="Klarna On-site messaging" src="${frameOrigin}/message-frame" width="320" height="40"></iframe>
    <iframe title="Shop Pay" src="${frameOrigin}/continue-frame" width="320" height="50"></iframe></main>`),
  "/klarna-only": doc("Checkout", `<main><h1>Checkout</h1><p>Choose how to pay.</p><iframe name="klarna-payments-main" src="${frameOrigin}/continue-frame" width="320" height="50"></iframe></main>`),
  "/links-frame": doc("News", `<article><h2><a style="display:block" href="/elsewhere?story">${LONG_HEADLINE}</a></h2>
    <p><a href="/elsewhere?subscribe">Subscribe<span aria-hidden="true"> to the newsletter</span></a></p>
    <p><a href="/elsewhere?tip"><img alt="Send icon" width="10" height="10" src="${PIXEL}"> Send us a tip</a></p></article>
    <iframe title="Advertisement" src="${frameOrigin}/message-frame" width="320" height="60"></iframe>`),
  "/same-page": doc("Contents", `<nav><a href="#transfer">Transfer of power</a> <a href="#trade">Trade</a> <a href="#/blog">Blog post</a> <a href="#!/share">Share prices</a> <a href="#" id="bare">Send</a> <a href="#nowhere" id="lost">Post</a></nav>
    <h2 id="transfer">Transfer of power</h2><h2 id="trade">Trade</h2>
    <script>for (const id of ["bare", "lost"]) document.getElementById(id).addEventListener("click", (event) => { event.preventDefault(); window.note("sent:" + id); });</script>`),
  "/shadow": doc("Components", `<section><card-box></card-box></section>
    <form id="mail"><text-field label="To" value="ada@example.com"></text-field><text-field label="Subject" value="Lunch"></text-field><sealed-note></sealed-note><button>Send</button></form>
    <footer><button id="swap" type="button">Swap in a moment</button></footer>
    <script>
      customElements.define("card-box", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" });
        root.innerHTML = '<input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc"><button type="button">Continue</button>';
        root.querySelector("button").addEventListener("click", () => window.note("continued")); } });
      customElements.define("text-field", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "open" });
        root.innerHTML = "<input>"; const input = root.querySelector("input"); input.setAttribute("aria-label", this.getAttribute("label")); input.value = this.getAttribute("value"); } });
      customElements.define("sealed-note", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "closed" }).innerHTML = '<input aria-label="Bcc" value="boss@example.com">'; } });
      document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.querySelector("text-field").shadowRoot.querySelector("input").value = "mallory@example.com"; document.getElementById("state").textContent = "changed"; }, 1500));
    </script>`),
  "/label-wrap": doc("Wallet", `<form id="wallet"><label>Recovery phrase <textarea>abandon ability able about above absent</textarea></label>
    <label>Password hint <input value="first dog's name"></label><label>Network <select><option>Mainnet</option><option>Testnet</option></select></label><button>Send</button></form>`),
  "/growing-list": doc("Feed", `<ul id="list"><li>Invoice 7 <button id="go" type="button" onclick="note('sent')">Send</button></li></ul>
    <script>const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]; let count = 0;
      setInterval(() => { count += 1; const row = document.createElement("li"); row.textContent = "New row " + names[count % names.length]; document.getElementById("list").prepend(row); }, 300);</script>`),
  "/role-box": doc("Role box", `<section><div id="all" role="checkbox" aria-checked="false" tabindex="0">Everyone in the company</div><input aria-label="Note" value="See you soon">
    <div id="send" role="button" tabindex="0" onclick="note('sent:' + document.getElementById('all').getAttribute('aria-checked'))">Send</div></section><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("all").setAttribute("aria-checked", "true"); document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/card-roles": doc("Saved cards", `<form id="card"><input aria-label="Card number" autocomplete="cc-number"><input aria-label="CVC" autocomplete="cc-csc">
    <div role="listbox" aria-label="Saved cards"><div role="option" tabindex="0" onclick="note('paid:option')">Use this card</div></div>
    <div role="tablist"><div role="tab" tabindex="0" onclick="note('paid:tab')">Card ending 4242</div></div>
    <div role="switch" aria-checked="false" tabindex="0" onclick="note('paid:switch')">One-click</div></form>`),
  "/everyday-forms": doc("Everyday forms", EVERYDAY.map((label, index) => `<form id="f${index}"><input aria-label="Title" value="Tuesday"><textarea aria-label="Text">Some text</textarea><button>${label}</button></form>`).join("\n")),
  "/german-form": doc("Notizen", `<form id="notiz"><input aria-label="Titel" value="Dienstag"><textarea aria-label="Text">Etwas Text</textarea><button>Speichern</button></form>`).replace('<html lang="en">', '<html lang="de">'),
  // ── Round three: one page per reviewer scenario R1 to R12 ──
  "/typed-focus": doc("Typed focus", `<p id="para">Just a paragraph</p><img id="pic" alt="A picture" width="20" height="20" src="${PIXEL}">
    <form id="pay"><input id="amount" aria-label="Amount" placeholder="Amount" value="5"><button>Pay now</button></form>`),
  "/card-region": doc("Card region", `<form id="c1"><input aria-label="Card number" value="1234 5678 9012 3456"><input aria-label="Expiry" value="12/30"><input aria-label="CVC" value="123">
    <button id="jsbtn" type="button" onclick="note('continued')">Continue</button> <a id="confirm" href="#" onclick="note('confirmed'); return false">Confirm</a>
    <div id="next" role="button" tabindex="0" onclick="note('next')">Next</div>
    <select id="plan" aria-label="Plan" onchange="changePlan(this)"><option>basic</option><option>pro</option></select></form>
    <form id="hosted"><iframe title="Secure card number input frame" src="${frameOrigin}/card-number-frame" width="300" height="40"></iframe><button>Confirm</button></form>
    <script>function changePlan(list) { window.note("plan:" + list.value); }</script>`),
  "/frame-click": doc("Frame click", `<iframe id="inner" title="Billing" src="/inner-continue" width="420" height="60"></iframe>
    <iframe id="payframe" title="Secure payment" src="${frameOrigin}/continue-frame" width="420" height="60"></iframe>
    <object id="obj" data="/inner-continue" type="text/html" width="420" height="60"></object>`),
  "/inner-continue": `<!doctype html><html lang="en"><meta charset="utf-8"><title>Billing frame</title><form id="pay" onsubmit="event.preventDefault()">
    <input aria-label="Card number" value="1234 5678 9012 3456"><input aria-label="CVC" value="123"><button type="button" onclick="parent.note('inner:continued')">Continue</button></form></html>`,
  // Each part in a section of its own: with no region around it, the Send
  // button's region would be the page, and the page holds a payment frame.
  "/space": doc("Space", `<section><input id="first" aria-label="Name" value="Ada"><button id="send" type="button" onclick="note('sent')">Send</button></section>
    <section><textarea id="notes" aria-label="Notes"></textarea></section><section><iframe title="Secure payment" src="${frameOrigin}/pay-frame" width="420" height="60"></iframe></section>`),
  "/elsewhere-back": doc("Elsewhere", `<a id="back" href="#" onclick="history.back(); return false">Back to the last page</a>`),
  "/bind-section": doc("Bind section", `<section><input id="to" aria-label="To" value="ada@example.com"></section>
    <section><div id="send" role="button" tabindex="0" onclick="note('sent:' + document.getElementById('to').value)">Send</div></section><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("to").value = "mallory@example.com"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/bind-frame": doc("Bind frame", `<form id="post"><iframe id="editor" title="Body" src="/rte" width="300" height="60"></iframe><button>Publish</button></form><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("editor").contentDocument.body.textContent = "Something else entirely"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/rte": `<!doctype html><html lang="en"><meta charset="utf-8"><title>Editor</title><body contenteditable="true">First draft</body></html>`,
  "/bind-hidden": doc("Bind hidden", `<form id="share"><textarea aria-label="Post">Hello</textarea><input type="hidden" id="visibility" name="visibility" value="private"><button>Share</button></form><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("visibility").value = "public"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/bind-wizard": doc("Bind wizard", `<form id="wizard"><div id="step1" style="display:none"><input id="payee" aria-label="Payee" value="Ada"><input id="amount" aria-label="Amount" value="5"></div>
    <div id="step2"><p>Review and confirm.</p><button>Transfer</button></div></form><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("payee").value = "Mallory"; document.getElementById("amount").value = "5000"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/bind-tick": doc("Bind tick", `<label><input id="all" type="checkbox"> Everyone in the company</label> <div id="send" role="button" tabindex="0" onclick="note('sent:' + document.getElementById('all').checked)">Send</div><button id="swap" type="button">Swap in a moment</button>
    <script>document.getElementById("swap").addEventListener("click", () => setTimeout(() => { document.getElementById("all").checked = true; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/private-names": doc("Private names", `<form id="account"><input aria-label="Code" value="731942"><input aria-label="Security answer" value="Fluffy the cat"><input aria-label="Social security number" value="078-05-1120">
    <input name="pass" aria-label="Contraseña" value="mi-secreto-123"><input aria-label="Secret key" value="sk_live_abcdefg12345"><input aria-label="Número de tarjeta" value="4242 42">
    <input aria-label="Recovery phrase" value="apple brave candle"><input aria-label="Backup code" value="8842-1190"><input aria-label="City" value="Baramati">
    <p>Your new password is Tr0ub4dor and your recovery code is 5519-2207. <button>Send</button></p></form>`),
  "/private-page": doc("Private page", `<input aria-label="Full name" value="Ada Lovelace"><input aria-label="Address" value="12 Analytical Row"><input aria-label="Date of birth" value="1815-12-10">
    <input aria-label="IBAN" value="DE89370400440532013000"><input aria-label="Tax number" value="12/345/67890">
    <section><input aria-label="Note" value="See you soon"><div id="send" role="button" tabindex="0" onclick="note('sent')">Send</div></section>
    <form id="memo"><textarea aria-label="Message">The launch plan</textarea><button>Send</button></form>`),
  "/restyled": doc("Restyled", `<div role="row"><span id="ago">3s ago</span> Invoice 7 <button id="pay" type="button" onclick="note('paid')">Pay</button></div>
    <script>let seconds = 3; setInterval(() => { seconds += 1; document.getElementById("ago").textContent = seconds + "s ago"; document.getElementById("pay").style.opacity = String(0.9 + (seconds % 5) / 100); }, 250);</script>`),
  "/shifting": doc("Shifting", `<div role="row"><span id="word">alpha</span> <button id="go" type="button" onclick="note('sent')">Send</button></div>
    <script>const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]; let at = 0; setInterval(() => { at += 1; document.getElementById("word").textContent = words[at % words.length]; }, 250);</script>`),
  "/closed": doc("Closed", `<div><input id="first" aria-label="Name" value="Ada"></div><closed-pay></closed-pay>
    <script>customElements.define("closed-pay", class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: "closed" });
      root.innerHTML = '<form><input aria-label="Card number" value="4242424242424242"><button>Pay</button></form>';
      root.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); window.note("submitted:closed"); }); } });</script>`),
  "/big-page": doc("Big page", `<button id="details" type="button" onclick="note('details')">Show details</button>
    <section><input aria-label="Note" value="See you soon"><div id="send" role="button" tabindex="0" onclick="note('sent')">Send</div></section>
    ${Array.from({ length: 6_000 }, (_, index) => `<input aria-label="Cell ${index}" value="value ${index}">`).join("")}`),
  "/lookups": doc("Lookups", `<form id="find" role="search"><input type="search" aria-label="Search" value="4242424242424242"><button>Search</button></form>
    <form id="imei"><input aria-label="IMEI" value="356938035643809"><button>Check</button></form>`),
};
let paid = 0;
const site = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (path === "/paid") {
    if (req.method === "POST") paid += 1;
    req.resume();
    res.end(doc("Paid", `<p id="receipt">Paid ${paid} time(s), last by ${req.method}.</p>`));
  } else res.end(CASE_PAGES[path] ?? PAGE);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
const pageUrl = `${origin}/compose`;
const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "hang" }, undefined, undefined, { binaryPath, executablePath });
const evidence: Array<Record<string, unknown>> = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let failure: unknown;
try {
  const api = async (method: string, path: string, body?: unknown, bearer?: string) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  assert.equal((await api("PATCH", "/api/config", { features: { browser: true } })).status, 200);
  const created = await api("POST", "/api/bots", { name: "Pepper", browser: true, computer: "browser", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id: botId, threadId } = created.body.bot;
  assert.equal((await api("POST", `/api/bots/${botId}/messages`, { text: "commit hold check", threadId })).status, 202);
  let token = "";
  for (let attempt = 0; attempt < 100 && !token; attempt += 1) {
    await sleep(150);
    try { token = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.browser?.env?.OMB_MCP_TOKEN ?? ""; }
    catch { /* the fake engine has not started its turn yet */ }
  }
  assert.ok(token, "the turn did not mount the browser tools");

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = await api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name, arguments: args } }, token);
    const text = (answer.body.result?.content ?? []).map((part: any) => part.text ?? "").join("\n") || String(answer.body.error ?? "");
    return { status: answer.status, isError: answer.body.result?.isError === true, text };
  };
  const cards = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).filter((row) => row.card?.browserCommit);
  const pending = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const card = (await cards()).findLast((row) => !row.card.answered);
      if (card) return card.card;
      await sleep(100);
    }
    throw new Error("no commit card appeared");
  };
  const respond = (card: any, behavior: "allow" | "deny") => api("POST", `/api/threads/${threadId}/respond`, { requestId: card.requestId, behavior });
  /** What the page says was submitted or sent; the engine prints "(no output)" for nothing. */
  const log = async () => (await tool("agent_browser_get_text", { selector: "#log" })).text.replace("(no output)", "");

  const opened = await tool("agent_browser_open", { url: pageUrl });
  assert.equal(opened.isError, false, opened.text);
  const ref = (line: string) => `@${(opened.text.split("\n").find((row) => row.includes(line)) ?? "").match(/ref=(e\d+)/)?.[1]}`;

  // Clicks that commit nothing go straight through.
  for (const line of ['button "Show details"', 'button "Search"', 'textbox "Message"']) {
    const clicked = await tool("agent_browser_click", { selector: ref(line) });
    assert.equal(clicked.isError, false, `${line}: ${clicked.text}`);
  }
  assert.equal((await cards()).length, 0, "an ordinary click raised a card");
  evidence.push({ step: "ordinary clicks and a search pass without a card", log: await log() });

  // A send waits; the card shows the site, the button and the message; Allow clicks.
  await tool("agent_browser_eval", { script: "document.getElementById('log').textContent" });
  const sending = tool("agent_browser_click", { selector: ref('button "Send"') });
  const send = await pending();
  assert.equal(send.title, "Send on your behalf?");
  assert.equal(send.subtitle, `${new URL(pageUrl).host} · Send\nMessage: Hello from the fixture`);
  assert.deepEqual(send.outboundRequest.calls, [{ app: new URL(pageUrl).host, label: "Send" }]);
  const picture = await fetch(`${fixture.info.url}/api/attachments/${String(send.browserCommit.shot).split("/").pop()}`, { headers: { origin: fixture.info.url } });
  assert.equal(picture.headers.get("content-type"), "image/jpeg");
  assert.equal((await tool("agent_browser_snapshot")).status, 200, "a read was refused during the hold");
  assert.match((await tool("agent_browser_fill", { selector: "#body", text: "changed" })).text, /approval for this browser waits on the person/);
  await respond(send, "allow");
  const sentResult = await sending;
  assert.equal(sentResult.isError, false);
  // Once allowed the click goes out like any other: the page is read around it, and the bot is told what it changed.
  assert.match(sentResult.text, /\nText that appeared on the page: "[^"]*submitted:message"\.[^\n]*$/);
  assert.equal(await log(), "submitted:message");
  evidence.push({ step: "send held, evidence shown, Allow clicked it", card: { title: send.title, subtitle: send.subtitle, screenshotBytes: (await picture.arrayBuffer()).byteLength } });

  // A page with a sign-in and a card form. Signing in passes. Money asks,
  // shows only the length of the card number, takes no picture of a page
  // that shows one, and Deny clicks nothing.
  const account = await tool("agent_browser_open", { url: `${origin}/account` });
  assert.equal(account.isError, false, account.text);
  const onAccount = (line: string) => `@${(account.text.split("\n").find((row) => row.includes(line)) ?? "").match(/ref=(e\d+)/)?.[1]}`;
  const before = (await cards()).length;
  assert.equal((await tool("agent_browser_click", { selector: onAccount('button "Log in"') })).isError, false);
  assert.equal((await cards()).length, before, "signing in raised a card");
  assert.equal(await log(), "submitted:login");
  await tool("agent_browser_open", { url: `${origin}/account` });
  const paying = tool("agent_browser_click", { selector: "#pay button" });
  const money = await pending();
  assert.equal(money.title, "Spend money?");
  assert.match(money.subtitle, /Card number: 16 characters, not shown/);
  assert.ok(!JSON.stringify(money).includes("4111111111111111"), "the card number reached the card");
  assert.equal(money.browserCommit.shot, undefined, "a page showing a card number was pictured");
  assert.equal(money.browserCommit.noShot, true);
  await respond(money, "deny");
  assert.match((await paying).text, /the user declined/);
  assert.equal(await log(), "");
  evidence.push({ step: "a login passes; money held, card number never on the card, no picture, Deny clicked nothing", card: { title: money.title, subtitle: money.subtitle } });

  // Back on the first page. Opened, not reloaded: a reload after an approved send is itself held (case A4).
  assert.equal((await tool("agent_browser_open", { url: pageUrl })).isError, false);
  const page = await tool("agent_browser_snapshot");
  const fresh = (line: string) => `@${(page.text.split("\n").find((row) => row.includes(line)) ?? "").match(/ref=(e\d+)/)?.[1]}`;

  // Enter in a message box is a send; typed as a line break, the text goes in and the Enter waits on a card; Shift+Enter is a new line.
  await tool("agent_browser_click", { selector: fresh('textbox "Write a message"') });
  assert.equal((await tool("agent_browser_press", { key: "Shift+Enter" })).isError, false);
  const typing = tool("agent_browser_type", { selector: "#composer", text: "more\n" });
  const typedCard = await pending();
  assert.match(typedCard.subtitle, /· Enter in Write a message\nWrite a message: [^]*more/);
  assert.equal(await log(), "", "the typed Enter was pressed before the answer");
  await respond(typedCard, "deny");
  assert.match((await typing).text, /typed the text and did not press Enter/);
  assert.equal(await log(), "");

  // The page changes under the approval (its own script edits the draft a
  // moment after the card is up): the approval is void, and a new card is
  // raised for what is there now.
  await tool("agent_browser_click", { selector: fresh('button "Change the draft in a moment"') });
  await tool("agent_browser_click", { selector: fresh('textbox "Write a message"') });
  const entering = tool("agent_browser_press", { key: "Enter" });
  const enter = await pending();
  assert.match(enter.subtitle, /· Enter in Write a message\nWrite a message: /);
  for (let attempt = 0; attempt < 50 && !(await tool("agent_browser_get_text", { selector: "#composer" })).text.includes("Edited while the card was open"); attempt += 1) await sleep(100);
  await respond(enter, "allow");
  const again = await pending();
  assert.notEqual(again.requestId, enter.requestId);
  assert.match(again.subtitle, /Write a message: Edited while the card was open/);
  assert.equal((await cards()).find((row) => row.card.requestId === enter.requestId).card.browserCommit.pageChanged, true);
  assert.equal(await log(), "", "the voided approval pressed Enter");
  await respond(again, "allow");
  assert.equal((await entering).isError, false);
  assert.equal(await log(), "sent:composer");
  evidence.push({ step: "Enter held; the edited page voided the approval and re-asked", first: enter.subtitle, second: again.subtitle });

  // Scripts that act are refused; scripts that read run.
  assert.match((await tool("agent_browser_eval", { script: "document.forms[0].submit()" })).text, /did not run this script/);
  assert.equal((await tool("agent_browser_eval", { script: "document.title" })).text, '"Commit hold test"');

  const decisions = ((await api("GET", "/api/decisions?limit=50")).body.decisions as any[]).map((row) => `${row.decision} ${row.rule ?? ""}`.trim());
  const activity = ((await api("GET", `/api/bots/${botId}/activity`)).body.rows as any[]).filter((row) => row.app === "Browser").map((row) => `${row.label}: ${row.outcome}`);
  evidence.push({ step: "records", decisions, activity });

  // ── Cases: one reviewer scenario each, on its own page. Every case runs
  // even when an earlier one failed, so one run shows all of them. ──
  type Result = Awaited<ReturnType<typeof tool>>;
  const visit = async (path: string) => {
    const page = await tool("agent_browser_open", { url: origin + path });
    assert.equal(page.isError, false, page.text);
    return page.text;
  };
  const refIn = (text: string, line: string, nth = 0) => {
    const found = text.split("\n").filter((row) => row.includes(line))[nth]?.match(/ref=(e\d+)/)?.[1];
    assert.ok(found, `no ${line} in the snapshot`);
    return `@${found}`;
  };
  /** Make a call that must be held: resolves with its card, or says the call went through. */
  const ask = async (name: string, args: Record<string, unknown> = {}) => {
    const known = new Set((await cards()).map((row) => row.card.requestId));
    let done: Result | undefined;
    const result = tool(name, args).then((value) => (done = value));
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const card = (await cards()).find((row) => !row.card.answered && !known.has(row.card.requestId))?.card;
      if (card) return { card, result };
      if (done) throw new Error(`no card: ${name} was not held (${done.isError ? "refused: " : "it ran: "}${done.text.replace(/\s+/g, " ").slice(0, 160)}; page log: ${JSON.stringify(await log())})`);
      await sleep(100);
    }
    throw new Error(`no card appeared for ${name}`);
  };
  /** Hold, check the card, deny, and prove nothing happened on the page. */
  const heldThenDenied = async (name: string, args: Record<string, unknown>, expect: { title: string; label?: RegExp }) => {
    const { card, result } = await ask(name, args);
    assert.equal(card.title, expect.title, card.subtitle);
    if (expect.label) assert.match(card.browserCommit.label, expect.label);
    await respond(card, "deny");
    assert.match((await result).text, /the user declined/);
    assert.equal(await log(), "", "the denied action still happened");
    return card;
  };
  /** A call that must run with no card. A card that appears is denied and reported at once. */
  const passes = async (name: string, args: Record<string, unknown> = {}) => {
    const known = new Set((await cards()).map((row) => row.card.requestId));
    let done: Result | undefined;
    const result = tool(name, args).then((value) => (done = value));
    for (let attempt = 0; attempt < 300 && !done; attempt += 1) {
      const card = (await cards()).find((row) => !row.card.answered && !known.has(row.card.requestId))?.card;
      if (card) {
        await respond(card, "deny");
        await result;
        throw new Error(`${name} raised a card: ${card.title} ${JSON.stringify(card.subtitle).slice(0, 140)}`);
      }
      await sleep(50);
    }
    const settled = await result;
    assert.equal(settled.isError, false, `${name}: ${settled.text.replace(/\s+/g, " ").slice(0, 200)}`);
    return settled;
  };
  /** A call that must be refused outright: no card, nothing on the page. */
  const refused = async (name: string, args: Record<string, unknown>, why: RegExp) => {
    const open = (await cards()).length;
    const result = await tool(name, args);
    assert.equal(await log(), "", `${name} was not refused: it ran`);
    assert.equal(result.isError, true, `${name} was not refused: ${result.text.slice(0, 160)}`);
    assert.match(result.text, why);
    assert.equal((await cards()).length, open, `${name} raised a card`);
  };
  const focus = (id: string) => tool("agent_browser_eval", { script: `document.getElementById(${JSON.stringify(id)}).focus()` });
  const changed = async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if ((await tool("agent_browser_get_text", { selector: "#state" })).text.includes("changed")) return;
      await sleep(100);
    }
    throw new Error("the page never made its change");
  };
  /** Allow a card whose page changed underneath: the approval must be void and a new card raised. */
  const voided = async (first: { card: any; result: Promise<Result> }) => {
    const known = new Set((await cards()).map((row) => row.card.requestId));
    let done: Result | undefined;
    void first.result.then((value) => (done = value));
    await respond(first.card, "allow");
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const next = (await cards()).find((row) => !row.card.answered && !known.has(row.card.requestId))?.card;
      if (next) {
        assert.equal((await cards()).find((row) => row.card.requestId === first.card.requestId).card.browserCommit.pageChanged, true);
        return next;
      }
      if (done) throw new Error(`the approval was used although the page had changed (page log: ${JSON.stringify(await log())}; result: ${done.text.replace(/\s+/g, " ").slice(0, 120)})`);
      await sleep(100);
    }
    throw new Error("no second card appeared");
  };

  const cases: Array<{ id: string; title: string; run(): Promise<Record<string, unknown> | void> }> = [
    // ── A: a send or a payment with no card ──
    { id: "A1", title: "Enter on a checkbox, radio, select or range submits its form", run: async () => {
      await visit("/enter-on-controls");
      for (const id of ["agree", "gift", "size", "qty"]) {
        await focus(id);
        await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Buy now$/ });
      }
    } },
    { id: "A2", title: "check and uncheck click, so they are judged like a click", run: async () => {
      const page = await visit("/check");
      await heldThenDenied("agent_browser_check", { selector: refIn(page, 'button "Send"') }, { title: "Send on your behalf?", label: /^Send$/ });
      await heldThenDenied("agent_browser_uncheck", { selector: "#notify" }, { title: "Send on your behalf?" });
    } },
    { id: "A3", title: "Enter anywhere in a chord is Enter; Shift excuses it only where a line break is typed", run: async () => {
      await visit("/chords");
      await passes("agent_browser_click", { selector: "#title" });
      await heldThenDenied("agent_browser_press", { key: "Enter+Shift" }, { title: "Send on your behalf?", label: /^Post$/ });
      await passes("agent_browser_click", { selector: "#composer" });
      await heldThenDenied("agent_browser_press", { key: "Enter+Control" }, { title: "Send on your behalf?", label: /Enter in Write a message/ });
      await passes("agent_browser_press", { key: "Enter+Shift" });
      assert.equal(await log(), "");
      assert.match((await tool("agent_browser_snapshot")).text, /Write a message/);
    } },
    { id: "A4", title: "reload after a commitment is held, here and after opening another address and coming back", run: async () => {
      const page = await visit("/pay");
      const before = paid;
      const paying = await ask("agent_browser_click", { selector: refIn(page, 'button "Pay"') });
      await respond(paying.card, "allow");
      assert.equal((await paying.result).isError, false);
      // The click returns before the form's POST has reached the site.
      for (let attempt = 0; attempt < 50 && paid === before; attempt += 1) await sleep(100);
      assert.equal(paid, before + 1);
      const again = await ask("agent_browser_reload");
      assert.equal(again.card.title, "Spend money?");
      // The card says the site and whether it was a send or a payment, and repeats nothing that was sent.
      assert.match(again.card.subtitle, /Reload, which can repeat an earlier payment$/);
      assert.equal(again.card.browserCommit.fields.length, 0);
      await respond(again.card, "deny");
      await again.result;
      await sleep(500);
      assert.equal(paid, before + 1, "the payment was repeated");
      await visit("/elsewhere");
      const elsewhere = await ask("agent_browser_reload");
      await respond(elsewhere.card, "deny");
      await elsewhere.result;
      await tool("agent_browser_back");
      const back = await ask("agent_browser_reload");
      await respond(back.card, "deny");
      await back.result;
      await sleep(500);
      assert.equal(paid, before + 1, "the payment was repeated after going back");
      return { paid: paid - before };
    } },
    { id: "A5", title: "a selector too long to check, and an element with no area, are not clicked blind", run: async () => {
      const page = await visit("/odd-targets");
      await refused("agent_browser_click", { selector: `#send${",#nope".repeat(400)}` }, /shorter selector/);
      await refused("agent_browser_click", { selector: "-x,#send" }, /selector/);
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Send C"') }, { title: "Send on your behalf?", label: /^Send C$/ });
      await refused("agent_browser_click", { selector: "#zero" }, /could not (?:check|describe)/);
    } },
    { id: "A6", title: "two elements in one box: the one the click lands on is judged", run: async () => {
      await visit("/stacked");
      await heldThenDenied("agent_browser_click", { selector: "#vis" }, { title: "Send on your behalf?", label: /^Send$/ });
    } },
    { id: "A7", title: "an image button, or one tied by the form attribute, is the form's submit", run: async () => {
      await visit("/image-submit");
      await passes("agent_browser_click", { selector: "#name" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Continue$/ });
      await passes("agent_browser_click", { selector: "#who" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Send on your behalf?", label: /^Send$/ });
    } },
    { id: "A8a", title: "a ref with stray whitespace is the same ref", run: async () => {
      const page = await visit("/frame");
      await heldThenDenied("agent_browser_click", { selector: `${refIn(page, 'button "Pay"')} ` }, { title: "Spend money?", label: /^Pay$/ });
    } },
    { id: "A8b", title: "a select that submits its form on change", run: async () => {
      await visit("/auto-select");
      await heldThenDenied("agent_browser_select", { selector: "#when", values: ["now"] }, { title: "Send on your behalf?" });
    } },
    { id: "A8c", title: "controls named tagName, elements, action, id, closest, querySelectorAll hide nothing", run: async () => {
      await visit("/clobbered");
      const card = await heldThenDenied("agent_browser_click", { selector: "#go" }, { title: "Send on your behalf?", label: /^Send$/ });
      assert.match(card.subtitle, /Feedback: Great/);
    } },
    { id: "A9", title: "Enter with the focus inside a frame that cannot be read is refused; the frame's button, by its ref, is judged", run: async () => {
      const page = await visit("/frame-checkout");
      const before = framedPaid;
      // Tab from the field before the frame moves the focus into the frame's card field.
      await passes("agent_browser_click", { selector: "#before" });
      await passes("agent_browser_press", { key: "Tab" });
      for (const key of ["Enter", "Control+Enter", "Enter+Shift"]) await refused("agent_browser_press", { key }, /Click the button for this step instead/);
      await refused("agent_browser_type", { selector: refIn(page, 'textbox "Card number"'), text: "1\n" }, /agent_browser_fill/);
      await refused("agent_browser_type", { selector: "#payframe", text: "\n" }, /agent_browser_fill/);
      await refused("agent_browser_click", { selector: "#payframe" }, /inside a frame/);
      await sleep(700);
      assert.equal(framedPaid, before, "a payment inside the frame went through");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Pay"') }, { title: "Spend money?", label: /^Pay$/ });
      await sleep(300);
      assert.equal(framedPaid, before, "the denied click paid");
      // A frame of the page's own origin can be read, so Enter in it is judged like any other.
      await visit("/inner-checkout");
      await passes("agent_browser_click", { selector: "#before" });
      await passes("agent_browser_press", { key: "Tab" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Pay$/ });
      return { paidInFrame: framedPaid - before };
    } },
    { id: "A10", title: "a card form with no autofill hints is money: two signs by name, or one value that is a card number", run: async () => {
      const page = await visit("/plain-card-form");
      const card = await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      assert.match(card.subtitle, /Card number: 19 characters, not shown/);
      assert.match(card.subtitle, /CVC: 3 characters, not shown/);
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Look up"') }, { title: "Spend money?", label: /^Look up$/ });
      // One sign alone is not a card form: a library card number and a PIN sign in with no card.
      await passes("agent_browser_click", { selector: refIn(page, 'button "Log in"') });
      assert.equal(await log(), "submitted:library");
      return { subtitle: card.subtitle };
    } },
    // ── Round three ──
    { id: "R1", title: "text typed with a line break runs only into a text field that will itself take it", run: async () => {
      await visit("/typed-focus");
      await passes("agent_browser_click", { selector: "#amount" });
      // The engine types at the focus when its selector cannot take it, or resolves to nothing.
      for (const selector of ["#para", "#pic", "text=Just a paragraph", "placeholder=Amount", "label=Amount", "role=button", "@x"]) {
        await refused("agent_browser_type", { selector, text: "1\n" }, /agent_browser_fill/);
      }
    } },
    { id: "R2", title: "inside a card region any button-like control is money, whatever its type or label", run: async () => {
      await visit("/card-region");
      await heldThenDenied("agent_browser_click", { selector: "#jsbtn" }, { title: "Spend money?", label: /^Continue$/ });
      await heldThenDenied("agent_browser_click", { selector: "#confirm" }, { title: "Spend money?", label: /^Confirm$/ });
      await heldThenDenied("agent_browser_click", { selector: "#next" }, { title: "Spend money?", label: /^Next$/ });
      await heldThenDenied("agent_browser_select", { selector: "#plan", values: ["pro"] }, { title: "Spend money?" });
      // Card fields in a processor's frames, inside the shop's own form.
      await heldThenDenied("agent_browser_click", { selector: "#hosted button" }, { title: "Spend money?", label: /^Confirm$/ });
    } },
    { id: "R3", title: "a click by ref inside a frame is read in the frame, or is money in a payment frame it cannot read", run: async () => {
      const page = await visit("/frame-click");
      const before = framedPaid;
      const inner = await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"', 0) }, { title: "Spend money?", label: /^Continue$/ });
      assert.match(inner.subtitle, /Card number: 19 characters, not shown/, "the frame's own fields were not read");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"', 1) }, { title: "Spend money?", label: /^Continue$/ });
      await refused("agent_browser_click", { selector: "#obj" }, /inside a frame/);
      await sleep(400);
      assert.equal(framedPaid, before, "a payment inside the frame went through");
    } },
    { id: "R4", title: "Space on the focused element is an activation of it", run: async () => {
      await visit("/space");
      await passes("agent_browser_click", { selector: "#first" });
      await passes("agent_browser_press", { key: "Tab" });
      for (const key of ["Space", " ", "Shift+Space"]) await heldThenDenied("agent_browser_press", { key }, { title: "Send on your behalf?", label: /^Send$/ });
      // In a text box a space is a space.
      await passes("agent_browser_click", { selector: "#notes" });
      await passes("agent_browser_press", { key: "Space" });
      // Tab from there goes into the payment frame, which cannot be read.
      await passes("agent_browser_press", { key: "Tab" });
      const before = framedPaid;
      await refused("agent_browser_press", { key: "Space" }, /Click the button for this step instead/);
      assert.equal(framedPaid, before);
    } },
    { id: "R5", title: "once something was sent, every reload is held, wherever the page has been since", run: async () => {
      const page = await visit("/pay");
      const before = paid;
      const paying = await ask("agent_browser_click", { selector: refIn(page, 'button "Pay"') });
      await respond(paying.card, "allow");
      await paying.result;
      for (let attempt = 0; attempt < 50 && paid === before; attempt += 1) await sleep(100);
      // Elsewhere, then back by the page's own link: the posted page is in front again.
      await visit("/elsewhere-back");
      await passes("agent_browser_click", { selector: "#back" });
      await sleep(500);
      const again = await ask("agent_browser_reload");
      assert.equal(again.card.title, "Spend money?");
      await respond(again.card, "deny");
      await again.result;
      await sleep(500);
      assert.equal(paid, before + 1, "the payment was repeated");
    } },
    { id: "R6", title: "the approval covers every control of the form or region, shown or not", run: async () => {
      const seen: Record<string, string> = {};
      for (const [path, selector] of [["/bind-section", "#send"], ["/bind-frame", "#post button"], ["/bind-hidden", "#share button"], ["/bind-wizard", "#wizard button"], ["/bind-tick", "#send"]] as const) {
        await visit(path);
        await passes("agent_browser_click", { selector: "#swap" });
        let outcome = "voided";
        try {
          const first = await ask("agent_browser_click", { selector });
          await changed();
          const second = await voided(first);
          await respond(second, "deny");
          await first.result;
        } catch (error) { outcome = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 110) : String(error); }
        for (const row of await cards()) if (!row.card.answered) await respond(row.card, "deny");
        seen[path] = outcome;
      }
      assert.deepEqual(seen, { "/bind-section": "voided", "/bind-frame": "voided", "/bind-hidden": "voided", "/bind-wizard": "voided", "/bind-tick": "voided" });
    } },
    { id: "R7", title: "private values stay off the card: unmarked names, the text around the button, the rest of the page, the reload card", run: async () => {
      await visit("/private-names");
      const first = await ask("agent_browser_click", { selector: "#account button" });
      await respond(first.card, "deny");
      await first.result;
      const rows = ((await api("GET", "/api/decisions?limit=300")).body.decisions as any[]).filter((row) => row.requestId === first.card.requestId);
      const told = `${first.card.subtitle}\n${JSON.stringify(first.card.browserCommit)}\n${JSON.stringify(rows)}`;
      for (const secret of ["731942", "Fluffy the cat", "078-05-1120", "mi-secreto-123", "sk_live_abcdefg12345", "4242 42", "apple brave candle", "8842-1190", "Tr0ub4dor", "5519-2207"]) {
        assert.ok(!told.includes(secret), `${secret} is in clear on the card or in the log`);
      }
      assert.match(first.card.subtitle, /City: Baramati/);
      assert.equal(first.card.browserCommit.shot, undefined, "a page saying a password out loud was pictured");
      // On a page with no form, only the fields of the button's own region are listed.
      await visit("/private-page");
      const second = await ask("agent_browser_click", { selector: "#send" });
      await respond(second.card, "deny");
      await second.result;
      assert.match(second.card.subtitle, /Note: See you soon/);
      for (const personal of ["Ada Lovelace", "12 Analytical Row", "1815-12-10", "DE89370400440532013000", "12/345/67890"]) {
        assert.ok(!JSON.stringify(second.card).includes(personal), `${personal} was listed from elsewhere on the page`);
      }
      // A reload card names the site and the class. It repeats nothing that was sent.
      const sending = await ask("agent_browser_click", { selector: "#memo button" });
      await respond(sending.card, "allow");
      await sending.result;
      const reload = await ask("agent_browser_reload");
      await respond(reload.card, "deny");
      await reload.result;
      assert.ok(!JSON.stringify(reload.card).includes("The launch plan"), "the reload card repeated what was sent");
      assert.equal(reload.card.browserCommit.fields.length, 0);
      return { names: first.card.subtitle, page: second.card.subtitle, reload: reload.card.subtitle };
    } },
    { id: "R8", title: "an approval can be used on a page that restyles itself, and after two voids the card says the page keeps changing", run: async () => {
      await visit("/restyled");
      const known = (await cards()).length;
      const paying = await ask("agent_browser_click", { selector: "#pay" });
      await sleep(900);
      await respond(paying.card, "allow");
      const settled = await Promise.race([paying.result, sleep(6_000).then(() => null)]);
      for (const row of await cards()) if (!row.card.answered) await respond(row.card, "deny");
      assert.ok(settled, `the approval was never used: ${(await cards()).length - known} cards were raised`);
      assert.equal(settled.isError, false, settled.text);
      assert.equal(await log(), "paid");
      // A row that really changes: two approvals are void, the third is bound to less.
      await visit("/shifting");
      const first = await ask("agent_browser_click", { selector: "#go" });
      await sleep(400);
      const second = await voided(first);
      await sleep(400);
      const third = await voided({ card: second, result: first.result });
      assert.match(third.subtitle, /keeps changing/);
      await sleep(400);
      await respond(third, "allow");
      const sent = await Promise.race([first.result, sleep(6_000).then(() => null)]);
      for (const row of await cards()) if (!row.card.answered) await respond(row.card, "deny");
      assert.ok(sent && !sent.isError, "the third approval was not used");
      assert.equal(await log(), "sent");
      return { third: third.subtitle };
    } },
    { id: "R9", title: "Enter and Space with the focus inside a closed part of the page are refused", run: async () => {
      await visit("/closed");
      await passes("agent_browser_click", { selector: "#first" });
      await passes("agent_browser_press", { key: "Tab" });
      await refused("agent_browser_press", { key: "Enter" }, /closed part of the page/);
      await refused("agent_browser_press", { key: "Space" }, /closed part of the page/);
    } },
    { id: "R11", title: "a click that commits nothing is not refused or slowed by 6,000 filled fields", run: async () => {
      await visit("/big-page");
      const started = Date.now();
      await passes("agent_browser_click", { selector: "#details" });
      const took = Date.now() - started;
      assert.equal(await log(), "details");
      assert.ok(took < 1_500, `the click took ${took} ms`);
      // A commitment on the same page: only its own region's fields are listed.
      await visit("/big-page");
      const card = await heldThenDenied("agent_browser_click", { selector: "#send" }, { title: "Send on your behalf?", label: /^Send$/ });
      assert.match(card.subtitle, /Note: See you soon/);
      assert.ok(!card.subtitle.includes("Cell 17:"), "fields from the rest of the page were listed");
      return { tookMs: took, subtitle: card.subtitle };
    } },
    { id: "R12", title: "a search is never a commitment, and a checksum alone is not a card number", run: async () => {
      const page = await visit("/lookups");
      await passes("agent_browser_click", { selector: refIn(page, 'button "Search"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Check"') });
      assert.equal(await log(), "submitted:find submitted:imei");
    } },
    { id: "T7", title: "ordinary operations have the outcome they must: links, harmless labels, filters, a sign-in and notes pass; sends and payments are held", run: async () => {
      // A link that loads another page is never a commitment by its text; one that acts as a button is.
      let page = await visit("/ordinary-links");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'link "Send"') }, { title: "Send on your behalf?", label: /^Send$/ });
      for (const text of ["Blog post", "Buy tickets", "Share prices"]) {
        page = await visit("/ordinary-links");
        await passes("agent_browser_click", { selector: refIn(page, `link "${text}"`) });
        assert.match((await tool("agent_browser_get_url")).text, /\/elsewhere/, `the ${text} link did not open its page`);
      }
      // A profile, filters, a sign-in and a sign-up: each submits with no card.
      page = await visit("/ordinary-forms");
      await passes("agent_browser_click", { selector: refIn(page, 'button "Save changes"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Apply"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Submit"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Continue"') });
      assert.equal(await log(), "submitted:profile submitted:filters submitted:login submitted:signup");
      // Enter in a notes box is a new line, and several lines typed into it run.
      await passes("agent_browser_click", { selector: "#note" });
      await passes("agent_browser_press", { key: "Enter" });
      await passes("agent_browser_type", { selector: "#note", text: "and the cable\nand the plug\n" });
      const notes = (await tool("agent_browser_eval", { script: "JSON.stringify(document.getElementById('note').value.split('\\n').length)" })).text;
      assert.match(notes, /[3-9]/, `the notes box did not take the lines: ${notes}`);
      assert.equal(await log(), "submitted:profile submitted:filters submitted:login submitted:signup", "Enter in the notes box submitted something");
      // Sends: Enter in a chat composer, a comment, a mail, an application with a file.
      page = await visit("/ordinary-sends");
      await passes("agent_browser_click", { selector: "#chat" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Send on your behalf?", label: /^Enter in Message #general$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Comment"') }, { title: "Send on your behalf?", label: /^Comment$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Send"') }, { title: "Send on your behalf?", label: /^Send$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Apply"') }, { title: "Send on your behalf?", label: /^Apply$/ });
      // Money: by what the button says, and anything in a card region. "Confirm" alone is neither.
      page = await visit("/ordinary-money");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Pay now"') }, { title: "Spend money?", label: /^Pay now$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Upgrade"') }, { title: "Spend money?", label: /^Upgrade$/ });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Confirm"') });
      assert.equal(await log(), "confirmed");
      page = await visit("/ordinary-card");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
    } },
    { id: "4A", title: "text typed with a line break never lands on another element: a field that cannot take the focus gets nothing", run: async () => {
      const valueOf = async (id: string) => JSON.parse((await tool("agent_browser_eval", { script: `document.getElementById(${JSON.stringify(id)}).value` })).text) as string;
      await visit("/typed-unfocused");
      await passes("agent_browser_click", { selector: "#amount" });
      // The engine cannot give these the focus: its text and its Enter would both go to the Amount field, in a form that pays.
      for (const selector of ["#disabled-in", "#inert-in", "#hidden-in"]) await refused("agent_browser_type", { selector, text: "1\n" }, /cannot take the focus/);
      assert.equal(await valueOf("amount"), "5", "the text went into the field that had the focus");
      // A field that can take the focus, typed at without a click first: the text goes in, and Enter is pressed there (round five).
      await passes("agent_browser_type", { selector: "#q", text: "lamps\n" });
      assert.equal(await log(), "submitted:find");
      // A modal's Buy now button has the focus, and the search box is behind the modal.
      await visit("/typed-unfocused");
      await passes("agent_browser_click", { selector: "#open" });
      await refused("agent_browser_type", { selector: "#q", text: "lamps\n" }, /cannot take the focus/);
      assert.equal(await valueOf("q"), "");
    } },
    { id: "4B", title: "a search field is no way round a money label or a card region", run: async () => {
      await visit("/search-card");
      await passes("agent_browser_click", { selector: "#finder" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Pay now$/ });
      await passes("agent_browser_click", { selector: "#code" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Continue$/ });
      await heldThenDenied("agent_browser_click", { selector: "#inside button" }, { title: "Spend money?", label: /^Continue$/ });
      await passes("agent_browser_click", { selector: "#product" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Spend money?", label: /^Buy now$/ });
    } },
    { id: "4C", title: "a payment brand's message or button frame does not make a shop page a card region; a click inside it is still money", run: async () => {
      let page = await visit("/shop-frames");
      const before = framedPaid;
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      await passes("agent_browser_select", { selector: "#size", values: ["Large"] });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Increase quantity"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Add to cart"') });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Shipping details"') });
      assert.equal(await log(), "size:Large plus added opened");
      await passes("agent_browser_click", { selector: refIn(page, 'link "Read the reviews"') });
      assert.match((await tool("agent_browser_get_url")).text, /\/elsewhere/);
      // A frame known only by the name "klarna-payments-main" is a payment frame too.
      page = await visit("/klarna-only");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      await sleep(300);
      assert.equal(framedPaid, before, "a payment inside a frame went through");
    } },
    { id: "4D", title: "a link clicked by ref passes on a page with a frame, although the snapshot names it differently from its text", run: async () => {
      for (const line of ['link "How to share', 'link "Subscribe"', 'link "Send icon']) {
        const page = await visit("/links-frame");
        await passes("agent_browser_click", { selector: refIn(page, line) });
        assert.match((await tool("agent_browser_get_url")).text, /\/elsewhere\?/, `${line} did not open its page`);
      }
    } },
    { id: "4E", title: "a link to a place on the same page, and a #/ route, are plain links; a bare # is a button", run: async () => {
      let page = await visit("/same-page");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'link "Send"') }, { title: "Send on your behalf?", label: /^Send$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'link "Post"') }, { title: "Send on your behalf?", label: /^Post$/ });
      for (const [text, hash] of [["Transfer of power", "#transfer"], ["Trade", "#trade"], ["Blog post", "#/blog"], ["Share prices", "#!/share"]] as const) {
        page = await visit("/same-page");
        await passes("agent_browser_click", { selector: refIn(page, `link "${text}"`) });
        assert.ok((await tool("agent_browser_get_url")).text.includes(hash), `${text} did not go to ${hash}`);
      }
    } },
    { id: "4F", title: "fields inside open shadow roots are read: card fields make a card region, a form's fields are listed and bound, and a closed part is named on the card", run: async () => {
      const page = await visit("/shadow");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      await passes("agent_browser_click", { selector: "#swap" });
      const first = await ask("agent_browser_click", { selector: refIn(page, 'button "Send"') });
      assert.match(first.card.subtitle, /To: ada@example\.com/, "the fields inside the components were not read");
      assert.match(first.card.subtitle, /could not be read/, "the card did not say part of the form could not be read");
      await changed();
      const second = await voided(first);
      assert.match(second.subtitle, /To: mallory@example\.com/);
      await respond(second, "deny");
      await first.result;
      return { first: first.card.subtitle };
    } },
    { id: "4G", title: "a field's name is its label's own words, never the text or value of a control inside the label", run: async () => {
      const page = await visit("/label-wrap");
      const sending = await ask("agent_browser_click", { selector: refIn(page, 'button "Send"') });
      await respond(sending.card, "deny");
      await sending.result;
      const rows = ((await api("GET", "/api/decisions?limit=300")).body.decisions as any[]).filter((row) => row.requestId === sending.card.requestId);
      const told = `${sending.card.subtitle}\n${JSON.stringify(sending.card.browserCommit)}\n${JSON.stringify(rows)}`;
      for (const secret of ["abandon", "ability", "first dog"]) assert.ok(!told.includes(secret), `"${secret}" is on the card or in the log`);
      assert.match(sending.card.subtitle, /Recovery phrase: \d+ characters, not shown/);
      assert.match(sending.card.subtitle, /Password hint: \d+ characters, not shown/);
      assert.match(sending.card.subtitle, /^Network: Mainnet$/m);
      return { subtitle: sending.card.subtitle };
    } },
    { id: "4H", title: "a list that keeps gaining rows above the button can be approved on the third card", run: async () => {
      await visit("/growing-list");
      const first = await ask("agent_browser_click", { selector: "#go" });
      await sleep(500);
      const second = await voided(first);
      await sleep(500);
      const third = await voided({ card: second, result: first.result });
      assert.match(third.subtitle, /keeps changing/);
      await sleep(500);
      await respond(third, "allow");
      const sent = await Promise.race([first.result, sleep(6_000).then(() => null)]);
      for (const row of await cards()) if (!row.card.answered) await respond(row.card, "deny");
      assert.ok(sent && !sent.isError, "the third approval was not used");
      assert.equal(await log(), "sent");
    } },
    { id: "4I", title: "a tick box that is a role, not an input, is part of what an approval covers", run: async () => {
      await visit("/role-box");
      await passes("agent_browser_click", { selector: "#swap" });
      const first = await ask("agent_browser_click", { selector: "#send" });
      await changed();
      const second = await voided(first);
      await respond(second, "deny");
      await first.result;
      assert.equal(await log(), "");
    } },
    { id: "4J", title: "on an English page a form with a text area and an everyday label passes; on a page in another language it asks", run: async () => {
      const page = await visit("/everyday-forms");
      for (const label of EVERYDAY) await passes("agent_browser_click", { selector: refIn(page, `button "${label}"`) });
      assert.equal(await log(), EVERYDAY.map((_label, index) => `submitted:f${index}`).join(" "));
      const german = await visit("/german-form");
      await heldThenDenied("agent_browser_click", { selector: refIn(german, 'button "Speichern"') }, { title: "Send on your behalf?", label: /^Speichern$/ });
    } },
    { id: "4K", title: "in a card region an option, a tab and a switch pay like a button", run: async () => {
      const page = await visit("/card-roles");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'option "Use this card"') }, { title: "Spend money?" });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'tab "Card ending 4242"') }, { title: "Spend money?" });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'switch "One-click"') }, { title: "Spend money?" });
    } },
    { id: "4L", title: "a script that writes a field through a name it made from a page query is refused", run: async () => {
      await visit("/typed-unfocused");
      await refused("agent_browser_eval", { script: "const el = [document.querySelector('#amount')][0]; el.value = '999'" }, /did not run this script/);
      assert.match((await tool("agent_browser_eval", { script: "document.getElementById('amount').value" })).text, /"5"|: ?5\b|\b5\b/);
      // A script that only fills an object of its own still runs.
      assert.equal((await tool("agent_browser_eval", { script: "const out = {}; out.value = document.getElementById('amount').value; JSON.stringify(out)" })).isError, false);
    } },
    { id: "5A", title: "text with a line break typed at a field that was not clicked first: the text goes in, then the Enter is judged as its own press", run: async () => {
      const valueOf = async (id: string) => JSON.parse((await tool("agent_browser_eval", { script: `document.getElementById(${JSON.stringify(id)}).value` })).text) as string;
      await visit("/typed-apart");
      // A search box and a sign-in password: the text is typed, Enter is pressed, each form is submitted once.
      await passes("agent_browser_type", { selector: "#q", text: "lamps\n" });
      assert.equal(await valueOf("q"), "lamps", "the text was not typed once");
      await passes("agent_browser_type", { selector: "#pw", text: "correct-horse\n" });
      assert.equal(await valueOf("pw"), "correct-horse", "the text was not typed once");
      assert.equal(await log(), "submitted:find submitted:login");
      // A chat composer: the text is typed, the Enter waits on a card, and nothing is sent before Allow.
      await visit("/typed-apart");
      const sending = await ask("agent_browser_type", { selector: "#chat", text: "On my way\n" });
      assert.equal(sending.card.title, "Send on your behalf?");
      assert.match(sending.card.subtitle, /Message #general: On my way$/m, "the card does not show the text that was typed");
      assert.equal(await log(), "", "something was sent before the answer");
      await respond(sending.card, "allow");
      assert.equal((await sending.result).isError, false);
      assert.equal(await log(), "sent:chat:On my way", "the message is not the text, typed once");
      // A field in a disabled group, while a form that pays has the focus: nothing is typed anywhere, and no Enter is pressed.
      await visit("/typed-apart");
      await passes("agent_browser_click", { selector: "#amount" });
      await refused("agent_browser_type", { selector: "#disabled-in", text: "9\n" }, /cannot take the focus/);
      assert.equal(await valueOf("amount"), "5", "the text went into the field that had the focus");
      // A field behind a modal, whose own field has the focus.
      await passes("agent_browser_click", { selector: "#open" });
      await passes("agent_browser_click", { selector: "#coupon" });
      await refused("agent_browser_type", { selector: "#q", text: "lamps\n" }, /cannot take the focus/);
      assert.equal(await valueOf("coupon"), "", "the text went into the modal's field");
      assert.equal(await valueOf("q"), "");
    } },
    { id: "5B", title: "a frame that speaks of payment or checkout, and is no known brand's message or button, makes the page around it a card region", run: async () => {
      for (const index of [0, 1, 2]) {
        const page = await visit(`/unknown-frame-${index}`);
        await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      }
    } },
    { id: "5C", title: "a link whose address hides its scheme behind a tab, and a data: link, are buttons", run: async () => {
      const page = await visit("/tab-scheme");
      await heldThenDenied("agent_browser_click", { selector: "#pay" }, { title: "Spend money?", label: /^Pay now$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'link "Pay now"') }, { title: "Spend money?", label: /^Pay now$/ });
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'link "Send"') }, { title: "Send on your behalf?", label: /^Send$/ });
    } },
    { id: "5D", title: "a message box is a composer although the page has a search in its header; the body of a mail form is not", run: async () => {
      await visit("/header-search");
      await passes("agent_browser_click", { selector: "#box" });
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Send on your behalf?", label: /^Enter in Write a message$/ });
      await visit("/mail-form");
      await passes("agent_browser_click", { selector: "#body" });
      await passes("agent_browser_press", { key: "Enter" });
      assert.equal(await log(), "");
    } },
    { id: "6A", title: "text and its Enter never go to the engine in one call: the Enter is judged after the text is in, focused field or not", run: async () => {
      const valueOf = async (id: string) => JSON.parse((await tool("agent_browser_eval", { script: `document.getElementById(${JSON.stringify(id)}).value` })).text) as string;
      // A button disabled until its field has text. Before the text, Enter there does nothing; after it, it pays or sends.
      for (const [path, field, named, title, done] of [["/tip", "amount", "Amount", "Spend money?", "submitted:tip"], ["/ask", "q", "Ask anything", "Send on your behalf?", "submitted:ask"]] as const) {
        for (const clickFirst of [true, false]) {
          for (const answer of ["deny", "allow"] as const) {
            await visit(path);
            if (clickFirst) await passes("agent_browser_click", { selector: `#${field}` });
            const held = await ask("agent_browser_type", { selector: `#${field}`, text: "hello\n" });
            const what = `${path}, ${clickFirst ? "clicked first" : "not clicked first"}, ${answer}`;
            assert.equal(held.card.title, title, what);
            // While the card is open the browser can be read, not acted in: a snapshot shows the field.
            const during = (await tool("agent_browser_snapshot")).text.split("\n").find((row) => row.includes(`textbox "${named}"`)) ?? "";
            assert.match(during, /: hello$/, `${what}: the text is not in the field once (${during.trim()})`);
            assert.equal(await log(), "", `${what}: something was submitted before the answer`);
            await respond(held.card, answer);
            const result = await held.result;
            if (answer === "deny") {
              assert.match(result.text, /typed the text and did not press Enter/, what);
              assert.equal(await log(), "", `${what}: Deny still submitted`);
            } else {
              assert.equal(result.isError, false, `${what}: ${result.text.slice(0, 120)}`);
              assert.equal(await log(), done, `${what}: not submitted once`);
            }
            assert.equal(await valueOf(field), "hello", `${what}: the text was typed again`);
          }
        }
      }
      // A carriage return is an Enter to the engine, and a carriage return with a line feed is two: here it is one line break.
      await visit("/typed-apart");
      await passes("agent_browser_type", { selector: "#q", text: "lamps\r\n" });
      assert.equal(await log(), "submitted:find", "the search was not submitted exactly once");
      await visit("/typed-apart");
      await passes("agent_browser_type", { selector: "#q", text: "lamps\r" });
      assert.equal(await log(), "submitted:find");
    } },
    { id: "6B", title: "a wallet or pay-later frame does not make the page ask; a frame that calls itself payment or checkout does; an address alone does neither", run: async () => {
      // A wallet frame, a donate frame, and two frames with a payment word only in their address.
      let page = await visit("/wallet-frames");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      await passes("agent_browser_click", { selector: refIn(page, 'button "Add to cart"') });
      assert.equal(await log(), "added");
      await passes("agent_browser_click", { selector: refIn(page, 'link "Buy tickets for the launch"') });
      assert.match((await tool("agent_browser_get_url")).text, /\/elsewhere/);
      // A frame that calls itself payment or checkout, whatever else it says, and a brand's frame for paying in.
      for (const index of [3, 4, 5, 6]) {
        page = await visit(`/unknown-frame-${index}`);
        await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
      }
    } },
    { id: "7A", title: "Enter in a field is judged by the form's submit button even while that is disabled: a button enabled a moment after typing never pays without a card", run: async () => {
      for (const delay of [0, 50, 150]) {
        for (const attempt of [1, 2, 3, 4]) {
          await visit(`/tip-later-${delay}`);
          if (attempt % 2 === 0) await passes("agent_browser_click", { selector: "#amount" });
          const what = `enabled ${delay} ms after typing, try ${attempt}`;
          const held = await ask("agent_browser_type", { selector: "#amount", text: "hello\n" });
          assert.equal(held.card.title, "Spend money?", what);
          await sleep(350);
          assert.equal(await log(), "", `${what}: paid before the answer`);
          await respond(held.card, attempt === 4 ? "allow" : "deny");
          const result = await held.result;
          await sleep(250);
          if (attempt === 4) {
            assert.equal(result.isError, false, `${what}: ${result.text.slice(0, 120)}`);
            assert.equal(await log(), "submitted:tip", `${what}: not paid once after Allow`);
          } else assert.equal(await log(), "", `${what}: paid after Deny`);
        }
      }
      // A search and a sign-in whose buttons are disabled until there is text still run with no card.
      await visit("/gated-plain");
      await passes("agent_browser_type", { selector: "#q", text: "lamps\n" });
      await passes("agent_browser_type", { selector: "#pw", text: "correct-horse\n" });
    } },
    { id: "7B", title: "a known address counts by a frame's host, not by a mention of it elsewhere in the address", run: async () => {
      const page = await visit("/borrowed-address");
      await heldThenDenied("agent_browser_click", { selector: refIn(page, 'button "Continue"') }, { title: "Spend money?", label: /^Continue$/ });
    } },
    // ── B: an approval that covers more than was shown ──
    { id: "B9", title: "the approval is for one element: a renumbered ref is another", run: async () => {
      const page = await visit("/shop");
      await passes("agent_browser_click", { selector: "#resort" });
      const first = await ask("agent_browser_click", { selector: refIn(page, 'button "Buy now"') });
      const shown = String(first.card.subtitle);
      await changed();
      assert.equal((await tool("agent_browser_snapshot")).isError, false);
      const second = await voided(first);
      await respond(second, "deny");
      await first.result;
      assert.equal(await log(), "");
      assert.match(shown, /Sticker \$1/, "the card did not say which item");
      assert.match(second.subtitle, /Laptop \$18,000/);
      return { first: shown, second: second.subtitle };
    } },
    { id: "B10", title: "with no form, the fields around the button are shown and bound", run: async () => {
      const page = await visit("/dm");
      await passes("agent_browser_click", { selector: "#swap" });
      const first = await ask("agent_browser_click", { selector: refIn(page, 'button "Send"') });
      const shown = String(first.card.subtitle);
      await changed();
      const second = await voided(first);
      await respond(second, "deny");
      await first.result;
      assert.equal(await log(), "");
      assert.match(shown, /To: ada@example\.com/);
      assert.match(shown, /Message body: Lunch at one\?/);
      assert.match(second.subtitle, /To: mallory@example\.com/);
      return { first: shown, second: second.subtitle };
    } },
    { id: "B11", title: "every field is bound at full length; the card says what it left out", run: async () => {
      const page = await visit("/long-form");
      await passes("agent_browser_click", { selector: "#edit" });
      const first = await ask("agent_browser_click", { selector: refIn(page, 'button "Send"') });
      const shown = String(first.card.subtitle);
      await changed();
      const second = await voided(first);
      await respond(second, "deny");
      await first.result;
      assert.equal(await log(), "");
      assert.match(shown, /\nand 24 more fields, not shown here$/);
      assert.match(shown, /… \(3,000 characters in all\)\n/);
      assert.ok(!shown.includes("Field 33"), "field 33 was meant to be off the card");
      return { first: shown };
    } },
    // ── C: secrets ──
    { id: "C13", title: "card numbers, codes, PINs and unmasked passwords are length-only, and the page is not pictured", run: async () => {
      const page = await visit("/secrets");
      const { card, result } = await ask("agent_browser_click", { selector: refIn(page, 'button "Pay"') });
      await respond(card, "deny");
      await result;
      const rows = ((await api("GET", "/api/decisions?limit=200")).body.decisions as any[]).filter((row) => row.requestId === card.requestId);
      const seen = `${card.subtitle}\n${JSON.stringify(card.browserCommit)}\n${JSON.stringify(rows)}`;
      for (const secret of ["4242424242424242", "9173", "246810", "correct-horse-battery", "5555 5555 5555 4444", "4821", "ADA LOVELACE"]) {
        assert.ok(!seen.includes(secret), `${secret} is in clear on the card or in the log`);
      }
      assert.match(card.subtitle, /City: Baramati/);
      assert.equal(card.browserCommit.shot, undefined, "a page with secret fields was pictured");
      assert.equal(card.browserCommit.noShot, true);
      return { subtitle: card.subtitle };
    } },
    // ── M: beside the runtime's own work on a call (what an action changed; a call the engine lost) ──
    { id: "M1", title: "what an action changed is read around every call the gate sends, and a refusal carries none of it", run: async () => {
      const CHANGE = /Text that appeared on the page|Text that disappeared|visible text of the page did not change|The page is now/;
      await visit("/typed-apart");
      // Typed text and its Enter are two calls to the engine, and the bot is told what the last one changed.
      const searched = await passes("agent_browser_type", { selector: "#q", text: "lamps\n" });
      assert.match(searched.text, /\nText that appeared on the page: "[^"]*submitted:find"\.[^\n]*$/);
      // A script that would act is refused in the gate's own words.
      const script = await tool("agent_browser_eval", { script: "document.forms.pay.submit()" });
      assert.equal(script.isError, true);
      assert.doesNotMatch(script.text, CHANGE);
      // An Enter that would send waits with the text in the box. Declined, the bot gets the refusal and nothing of the page.
      await visit("/typed-apart");
      const declined = await ask("agent_browser_type", { selector: "#chat", text: "On my way\n" });
      await respond(declined.card, "deny");
      const refusal = await declined.result;
      assert.equal(refusal.isError, true);
      assert.match(refusal.text, /typed the text and did not press Enter/);
      assert.doesNotMatch(refusal.text, CHANGE, "a refusal carried what typing changed on the page");
      assert.equal(await log(), "");
      // Allowed, the Enter goes out as its own call, and the result says what the text and the Enter each changed.
      await visit("/typed-apart");
      const sending = await ask("agent_browser_type", { selector: "#chat", text: "On my way\n" });
      await respond(sending.card, "allow");
      const sent = await sending.result;
      assert.equal(sent.isError, false, sent.text);
      assert.match(sent.text, /Text that appeared on the page: "On my way"\./);
      assert.match(sent.text, /\nText that appeared on the page: "[^"]*sent:chat:On my way"\.[^\n]*$/);
      assert.equal(await log(), "sent:chat:On my way", "the message is not the text, typed once");
      // A click that pays: declined, the gate's words only; allowed, what the click changed.
      const page = await visit("/typed-apart");
      const pay = refIn(page, 'button "Pay now"');
      const denied = await ask("agent_browser_click", { selector: pay });
      await respond(denied.card, "deny");
      assert.doesNotMatch((await denied.result).text, CHANGE);
      assert.equal(await log(), "");
      const paying = await ask("agent_browser_click", { selector: pay });
      await respond(paying.card, "allow");
      const paidFor = await paying.result;
      assert.equal(paidFor.isError, false, paidFor.text);
      assert.match(paidFor.text, /\nText that appeared on the page: "[^"]*submitted:pay"\.[^\n]*$/);
      return { typed: sent.text.slice(-260), click: paidFor.text.slice(-130) };
    } },
    // Last, and slow: it waits out the 120 seconds a browser call may take.
    { id: "M2", title: "a call the engine does not answer in time is recovered without a restart, and what the bot does next is still judged", run: async () => {
      const page = await visit("/freeze");
      const send = refIn(page, 'button "Send"');
      const open = (await cards()).length;
      const started = Date.now();
      // The click keeps the page busy for 125 seconds: the call is given up as lost at 120.
      const lost = await tool("agent_browser_click", { selector: "#freeze" });
      const lostAfterMs = Date.now() - started;
      assert.equal(lost.isError, true, lost.text);
      assert.match(lost.text, /did not answer this agent_browser_click call\. It may still be running, or it may already have taken effect/);
      // The bot's next call would send. It is not read, judged or held: the
      // runtime waits for the engine, and tells the bot the lost call has ended.
      let next = await tool("agent_browser_click", { selector: send });
      for (let attempt = 0; attempt < 4 && /still busy with an earlier agent_browser_click call/.test(next.text); attempt += 1) next = await tool("agent_browser_click", { selector: send });
      assert.equal(next.status, 200, next.text);
      assert.equal(next.isError, false, next.text);
      assert.match(next.text, /the earlier agent_browser_click call that did not answer has ended, and it may have taken effect\. This call did not run\./);
      assert.equal((await cards()).length, open, "a card was raised for a call that did not run");
      assert.equal(await log(), "thawed", "the page is not as the lost click left it");
      // A ref from before the lost call is not acted on: the engine may have numbered its refs anew.
      const stale = await tool("agent_browser_click", { selector: send });
      assert.equal(stale.isError, true, stale.text);
      assert.match(stale.text, /an earlier browser call was lost/);
      assert.equal((await cards()).length, open, "a card was raised for a ref that could not be checked");
      // A selector is no ref: read and judged as ever, held, and Deny sends nothing.
      const bySelector = await ask("agent_browser_click", { selector: "#message button" });
      assert.equal(bySelector.card.title, "Send on your behalf?");
      await respond(bySelector.card, "deny");
      assert.match((await bySelector.result).text, /the user declined/);
      assert.equal(await log(), "thawed");
      // After a snapshot the ref is judged again: held, and Allow sends once.
      const again = await tool("agent_browser_snapshot");
      const held = await ask("agent_browser_click", { selector: refIn(again.text, 'button "Send"') });
      assert.equal(held.card.title, "Send on your behalf?");
      await respond(held.card, "allow");
      assert.equal((await held.result).isError, false);
      assert.equal(await log(), "thawed submitted:message");
      return { lostAfterMs, recovered: next.text.slice(0, 200) };
    } },
  ];
  // OMB_VERIFY_CASES=A4,B9 runs only those cases.
  const only = (process.env.OMB_VERIFY_CASES ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const failed: string[] = [];
  for (const item of cases) {
    if (only.length && !only.includes(item.id)) continue;
    try {
      evidence.push({ case: item.id, title: item.title, ok: true, ...(await item.run()) });
    } catch (error) {
      failed.push(item.id);
      evidence.push({ case: item.id, title: item.title, ok: false, error: error instanceof Error ? `${error.message}${error.cause ? ` (${String(error.cause)})` : ""}` : String(error) });
    }
    // Leave nothing waiting for the next case.
    for (const row of await cards()) if (!row.card.answered) await respond(row.card, "deny");
    await sleep(200);
  }
  if (failed.length) throw new Error(`cases failed: ${failed.join(", ")}`);

} catch (error) {
  failure = error;
} finally {
  // close --all is scoped to this fixture's HOME, never the operator's.
  await promisify(execFile)(binaryPath, ["close", "--all"], { env: { HOME: fixture.info.dataDir, USERPROFILE: fixture.info.dataDir, PATH: process.env.PATH }, timeout: 15_000 }).catch(() => {});
  await fixture.close();
  await new Promise<void>((resolve) => site.close(() => resolve()));
  await new Promise<void>((resolve) => frameSite.close(() => resolve()));
}
console.log(JSON.stringify({ ok: !failure, logPath: fixture.info.logPath, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), evidence }, null, 2));
if (failure) process.exitCode = 1;
