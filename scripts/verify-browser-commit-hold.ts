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
<form id="login"><label for="user">Username</label><input id="user" value="ada"><label for="pw">Password</label><input id="pw" type="password" value="not-a-real-secret"><button>Log in</button></form>
<form id="find" role="search"><input type="search" aria-label="Search" value="shoes"><button>Search</button></form>
<form id="pay"><label for="cc">Card number</label><input id="cc" autocomplete="cc-number" value="4111111111111111"><button>Continue</button></form>
<div id="composer" contenteditable="true" role="textbox" aria-label="Write a message">On my way</div>
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
/** One local page per reviewer scenario (docs/verification/browser-commit-hold.md, "Cases"). */
const CASE_PAGES: Record<string, string> = {
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
    <form id="ext"><textarea aria-label="Comment">Nice</textarea><input id="who" aria-label="Name" value="Ada"><input id="mail" aria-label="Email" value="ada@example.com"></form><button form="ext" id="outside">Go</button>`),
  "/frame": doc("Frame", `<iframe id="frame" title="Tip jar" width="300" height="80" srcdoc="<button onclick=&quot;parent.note('paid:frame')&quot;>Pay</button>"></iframe>`),
  "/auto-select": doc("Auto select", `<form id="quick"><textarea aria-label="Message">Running late</textarea><select id="when" aria-label="When" onchange="this.form.requestSubmit()"><option>later<option>now</select></form>`),
  "/clobbered": doc("Clobbered", `<form id="clob"><input name="tagName" value="1"><input name="elements" value="2"><input name="action" value="3"><input name="id" value="4"><input name="closest" value="5"><input name="querySelectorAll" value="6">
    <textarea aria-label="Feedback">Great</textarea><button id="go">Go</button></form>`),
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
  "/long-form": doc("Long form", `<form id="long">${Array.from({ length: 35 }, (_, index) => `<input id="f${index + 1}" aria-label="Field ${index + 1}" value="value ${index + 1}">`).join("")}
    <textarea aria-label="Essay">${"long ".repeat(600)}</textarea><button>Send</button></form><button id="edit" type="button">Edit field 33 in a moment</button>
    <script>document.getElementById("edit").addEventListener("click", () => setTimeout(() => { document.getElementById("f33").value = "CHANGED"; document.getElementById("state").textContent = "changed"; }, 1500));</script>`),
  "/secrets": doc("Secrets", `<form id="checkout"><input name="cardnumber" aria-label="Number" value="4242424242424242"><input id="cvc" placeholder="CVC" value="9173">
    <input aria-label="Code from your phone" autocomplete="one-time-code" value="246810"><input type="text" id="password" aria-label="Sign-in secret" value="correct-horse-battery">
    <input aria-label="Reference" value="5555 5555 5555 4444"><input aria-label="PIN" value="4821"><input aria-label="Name on card" autocomplete="cc-name" value="ADA LOVELACE">
    <input aria-label="City" value="Baramati"><button>Pay</button></form>`),
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
  for (const line of ['button "Show details"', 'button "Log in"', 'button "Search"', 'textbox "Message"']) {
    const clicked = await tool("agent_browser_click", { selector: ref(line) });
    assert.equal(clicked.isError, false, `${line}: ${clicked.text}`);
  }
  assert.equal((await cards()).length, 0, "an ordinary click raised a card");
  evidence.push({ step: "ordinary clicks, a login and a search pass without a card", log: await log() });

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
  assert.equal((await sending).isError, false);
  assert.equal(await log(), "submitted:message");
  evidence.push({ step: "send held, evidence shown, Allow clicked it", card: { title: send.title, subtitle: send.subtitle, screenshotBytes: (await picture.arrayBuffer()).byteLength } });

  // Money asks, shows only the length of the card number, and Deny clicks nothing.
  // Opened again, not reloaded: a reload after an approved send is itself held (case A4).
  assert.equal((await tool("agent_browser_open", { url: pageUrl })).isError, false);
  const page = await tool("agent_browser_snapshot");
  const fresh = (line: string) => `@${(page.text.split("\n").find((row) => row.includes(line)) ?? "").match(/ref=(e\d+)/)?.[1]}`;
  const paying = tool("agent_browser_click", { selector: fresh('button "Continue"') });
  const money = await pending();
  assert.equal(money.title, "Spend money?");
  assert.match(money.subtitle, /Card number: 16 characters, not shown/);
  assert.ok(!JSON.stringify(money).includes("4111111111111111"), "the card number reached the card");
  await respond(money, "deny");
  assert.match((await paying).text, /the user declined/);
  assert.equal(await log(), "");
  evidence.push({ step: "money held, card number never read, Deny clicked nothing", card: { title: money.title, subtitle: money.subtitle } });

  // Enter in a message box is a send; typed as a line break it is refused; Shift+Enter is a new line.
  await tool("agent_browser_click", { selector: fresh('textbox "Write a message"') });
  assert.equal((await tool("agent_browser_press", { key: "Shift+Enter" })).isError, false);
  assert.match((await tool("agent_browser_type", { selector: "#composer", text: "more\n" })).text, /agent_browser_fill/);

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
  /** A call that must run with no card. */
  const passes = async (name: string, args: Record<string, unknown> = {}) => {
    const open = (await cards()).length;
    const result = await tool(name, args);
    assert.equal(result.isError, false, `${name}: ${result.text}`);
    assert.equal((await cards()).length, open, `${name} raised a card`);
    return result;
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
    { id: "A4", title: "reload after a commitment is held until the bot opens another address", run: async () => {
      const page = await visit("/pay");
      const before = paid;
      const paying = await ask("agent_browser_click", { selector: refIn(page, 'button "Pay"') });
      await respond(paying.card, "allow");
      assert.equal((await paying.result).isError, false);
      assert.equal(paid, before + 1);
      const again = await ask("agent_browser_reload");
      assert.equal(again.card.title, "Spend money?");
      assert.match(again.card.subtitle, /Reload/);
      assert.match(again.card.subtitle, /Pay/);
      await respond(again.card, "deny");
      await again.result;
      assert.equal(paid, before + 1, "the payment was repeated");
      await visit("/elsewhere");
      await passes("agent_browser_reload");
      await tool("agent_browser_back");
      const back = await ask("agent_browser_reload");
      await respond(back.card, "deny");
      await back.result;
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
      await heldThenDenied("agent_browser_press", { key: "Enter" }, { title: "Send on your behalf?", label: /^Go$/ });
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
      const card = await heldThenDenied("agent_browser_click", { selector: "#go" }, { title: "Send on your behalf?", label: /^Go$/ });
      assert.match(card.subtitle, /Feedback: Great/);
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
}
console.log(JSON.stringify({ ok: !failure, logPath: fixture.info.logPath, ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}), evidence }, null, 2));
if (failure) process.exitCode = 1;
