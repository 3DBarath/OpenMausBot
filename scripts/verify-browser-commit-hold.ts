// The commit hold against an actual browser, always in a disposable fixture
// HOME: real agent-browser, real Chrome, real harness, fake model CLI parked
// mid-turn. Drives the turn's own browser route the way its MCP proxy does,
// answers the cards through the respond route, prints what happened as JSON
// and exits non-zero on the first thing that is not as documented in
// docs/verification/browser-commit-hold.md.
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

const site = createServer((_req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(PAGE); });
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/compose`;
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
  await tool("agent_browser_reload");
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
