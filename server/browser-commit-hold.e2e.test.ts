// The commit hold through the real harness: real browser route, respond
// route, decision log and attachment store, under the shared disposable
// launcher. The browser is an inert executable that answers the engine's
// commands from a file the test writes, so no page, account or user data
// is opened; the model is the repository's fake engine, parked mid-turn.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { OBSERVE_PAGE_SCRIPT } from "./browser-tool-shape.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const JPEG = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
/** One scripted element: what the first read says of it, and (fields,
 * secrets) what the second would. The inert browser answers each read with
 * its own half. */
const target = (extra: Record<string, unknown> = {}) => ({
  found: true, label: "Show details", role: "button", box: null, submits: false, search: false, card: false, multiline: false,
  button: true, changes: false, typable: true, field: true, reach: true, frames: false, payFrame: false, fields: [], ...extra,
});
const SEND = target({ label: "Send", submits: true, multiline: true, fields: [{ name: "Message", type: "textarea", value: "Hello there" }] });
const PAY = target({ label: "Continue", submits: true, card: true, fields: [{ name: "Card number", type: "card", length: 16 }] });
/** The runtime's own read of the page, before and after an action that
 * reaches the engine: what the result's last line ("what changed") is made
 * from. The inert browser's page text names the last call it ran. */
const OBSERVE = { name: "agent_browser_eval", arguments: { script: OBSERVE_PAGE_SCRIPT, timeoutMs: 5_000 } };
const changedBy = (name: string) => new RegExp(`^Text that appeared on the page: "Call \\d+: ${name}"\\. Text that disappeared: "Call \\d+: `);

describe.skipIf(process.platform === "win32")("browser commit hold", () => {
  let session: VerificationServer;
  let fixture: string;
  let botId: string;
  let threadId: string;
  let token: string;
  const evidence: unknown[] = [];

  const api = async (method: string, path: string, body?: unknown, bearer?: string) => {
    const response = await fetch(`${session.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: session.info.url, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json() as any };
    if (method !== "GET") evidence.push({ method, path, status: result.status, ...(path.endsWith("/mcp") ? { call: (body as any)?.params?.name, result: result.body } : {}) });
    return result;
  };
  const tool = (name: string, args: Record<string, unknown> = {}) => api("POST", "/api/internal/browser/mcp", { method: "tools/call", params: { name, arguments: args } }, token);
  const click = (selector = "@e4") => tool("agent_browser_click", { selector });
  /** What the inert browser says the page is. */
  const page = (state: { url?: string; target: unknown }) => writeFileSync(join(fixture, "page.json"), JSON.stringify({ url: "https://mail.example.com/compose#top", ...state }));
  /** The tool calls that reached the engine, in order. */
  const engineCalls = (): Array<{ name: string; arguments: unknown }> => existsSync(join(fixture, "calls.ndjson"))
    ? readFileSync(join(fixture, "calls.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const cards = async () => ((await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[]).filter((row) => row.card?.browserCommit);
  const pending = async () => {
    let card: any;
    await expect.poll(async () => {
      card = (await cards()).findLast((row) => !row.card.answered);
      return Boolean(card);
    }, { timeout: 10_000 }).toBe(true);
    return card;
  };
  const respond = (card: any, behavior: "allow" | "deny") => api("POST", `/api/threads/${threadId}/respond`, { requestId: card.card.requestId, behavior });

  beforeAll(async () => {
    fixture = mkdtempSync(join(tmpdir(), "omb-commit-hold-"));
    const browser = join(fixture, "agent-browser");
    writeFileSync(browser, [
      "#!/usr/bin/env node",
      'import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      'import { createInterface } from "node:readline";',
      `const dir = ${JSON.stringify(fixture)};`,
      `const OBSERVE = ${JSON.stringify(OBSERVE_PAGE_SCRIPT)};`,
      "const args = process.argv.slice(2);",
      'const page = () => JSON.parse(readFileSync(dir + "/page.json", "utf8"));',
      "const answer = (data) => process.stdout.write(JSON.stringify({ success: true, data, error: null }));",
      `if (args[0] === "screenshot") writeFileSync(args[1], Buffer.from(${JSON.stringify(JPEG)}, "base64"));`,
      'else if (args[0] === "get" && args[1] === "box") answer({ x: 1, y: 2, width: 3, height: 4 });',
      'else if (args[0] === "get" && args[1] === "url") answer({ url: page().url });',
      // The gate's two reads: what the call would act on, then the evidence for a card.
      'else if (args[0] === "eval") {',
      '  const seen = page().target, asked = readFileSync(0, "utf8");',
      '  const { fields = [], secrets = false, identity = "", context = "", ...first } = seen;',
      '  answer({ result: !/"detail":true\\}\\)$/.test(asked) ? first : { found: true, secrets, parts: [{ fields, others: 0, bound: "", identity, context, around: "" }] } });',
      "}",
      'else if (args[0] === "set") answer({});',
      'else if (args[0] === "session") answer({ sessions: [] });',
      'else if (args[0] === "mcp") {',
      // The page's visible text names the last call that ran, so every action changes it.
      '  let calls = 0, last = "nothing yet";',
      '  createInterface({ input: process.stdin }).on("line", (line) => {',
      "    const message = JSON.parse(line); if (message.id === undefined) return;",
      '    if (message.method === "tools/call") appendFileSync(dir + "/calls.ndjson", JSON.stringify(message.params) + "\\n");',
      // The runtime's read around an action is answered the way the engine answers an eval: JSON, as a string.
      '    const observe = message.method === "tools/call" && message.params.name === "agent_browser_eval" && message.params.arguments.script === OBSERVE;',
      '    if (message.method === "tools/call" && !observe) { calls += 1; last = message.params.name; }',
      // A click the engine never answers, once: its connection goes away mid-call, as when a call times out.
      '    if (message.method === "tools/call" && message.params.name === "agent_browser_click" && existsSync(dir + "/lose-click")) { rmSync(dir + "/lose-click"); process.exit(1); }',
      '    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "inert-browser", version: "1" } }',
      '      : message.method === "tools/list" ? { tools: [{ name: "agent_browser_click", inputSchema: { type: "object" } }] }',
      '      : observe ? { content: [{ type: "text", text: JSON.stringify(JSON.stringify({ url: page().url, title: "Inert page", text: "Call " + calls + ": " + last })) }] }',
      '      : message.params.name === "agent_browser_get_url" ? { content: [{ type: "text", text: page().url }] }',
      // Like the engine, a snapshot answers with its table of refs. This page's is empty: the tests' refs have no names.
      '      : message.params.name === "agent_browser_snapshot" ? { content: [{ type: "text", text: "inert browser did agent_browser_snapshot" }], structuredContent: { response: { data: { refs: {} } } } }',
      '      : { content: [{ type: "text", text: "inert browser did " + message.params.name }] };',
      '    const reply = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");',
      // The runtime's read of the page waits for as long as the slow-observe file is there.
      '    const wait = () => existsSync(dir + "/slow-observe") ? setTimeout(wait, 20) : reply();',
      "    if (observe) wait(); else reply();",
      "  });",
      '} else process.stdout.write("1.0.0\\n");',
    ].join("\n"), { mode: 0o700 });
    page({ target: target() });
    // The fake engine parks mid-turn, so the turn's browser capability stays live.
    session = await launchVerificationServer(
      { ...process.env, FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: join(fixture, "release") },
      undefined, undefined, { binaryPath: browser, executablePath: browser },
    );
    evidence.push({ fixture: session.info });
    expect((await api("PATCH", "/api/config", { features: { browser: true } })).status).toBe(200);
    const created = await api("POST", "/api/bots", { name: "Pepper", browser: true, computer: "browser", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    botId = created.body.bot.id;
    threadId = created.body.bot.threadId;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text: "HOLD_FIXTURE", threadId })).status).toBe(202);
    const deadline = Date.now() + 15_000;
    let mount: Record<string, string> | undefined;
    while (!mount?.OMB_MCP_TOKEN) {
      if (Date.now() > deadline) throw new Error("the fake engine never received the browser tools");
      await new Promise((resolve) => setTimeout(resolve, 50));
      try { mount = JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).mcpConfig?.mcpServers?.browser?.env; }
      catch { /* the dump is not written yet */ }
    }
    token = mount.OMB_MCP_TOKEN;
    // The proxy is told to outlast a hold: nine minutes and a margin, inside the ten-minute default.
    expect(mount.OMB_MCP_CALL_TIMEOUT_MS).toBe("570000");
  }, 60_000);

  afterAll(async () => {
    if (session) {
      writeFileSync(`${session.info.logPath}.browser-commit-hold.json`, JSON.stringify({ evidence, engineCalls: fixture ? engineCalls() : [] }, null, 2));
      console.info(JSON.stringify({ ...session.info, evidencePath: `${session.info.logPath}.browser-commit-hold.json` }));
      await session.close();
    }
    if (fixture) await removeTempDir(fixture);
  });

  it("relays an ordinary click, and holds a send until the person allows it", async () => {
    page({ target: target() });
    const start = engineCalls().length;
    const plain = await click("#details");
    expect(plain.status, JSON.stringify(plain.body)).toBe(200);
    expect(plain.body.result.content[0].text).toBe("inert browser did agent_browser_click");
    // The runtime reads the page around the click and says what it changed.
    expect(plain.body.result.content).toHaveLength(2);
    expect(plain.body.result.content[1].text).toMatch(changedBy("agent_browser_click"));
    expect(engineCalls().slice(start)).toEqual([OBSERVE, { name: "agent_browser_click", arguments: { selector: "#details" } }, OBSERVE]);
    expect(await cards()).toEqual([]);

    page({ target: SEND });
    const before = engineCalls().length;
    const held = click("@e4");
    const card = await pending();
    expect(card.card).toMatchObject({
      title: "Send on your behalf?",
      subtitle: "mail.example.com · Send\nMessage: Hello there",
      options: ["Allow", "Deny"],
      tool: "agent_browser_click",
      heldCode: "approval.held.outbound",
      outboundRequest: { tool: "agent_browser_click", app: "mail.example.com", calls: [{ app: "mail.example.com", label: "Send" }] },
      browserCommit: { class: "send", host: "mail.example.com", label: "Send", fields: [{ name: "Message", type: "textarea", value: "Hello there" }] },
    });
    // The server's own screenshot is served while the card is open.
    const shot = `/api/attachments/${String(card.card.browserCommit.shot).split("/").pop()}`;
    const picture = await fetch(session.info.url + shot, { headers: { origin: session.info.url } });
    expect(picture.status).toBe(200);
    expect(picture.headers.get("content-type")).toBe("image/jpeg");
    // It is listed while the card is open, so a server that stops now deletes it at its next start.
    const listed = () => JSON.parse(readFileSync(join(session.info.dataDir, "browser-hold-shots.json"), "utf8"));
    expect(listed()).toEqual([String(card.card.browserCommit.shot).split("/").pop()]);
    expect((await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === botId).tasks.find((task: any) => task.threadId === threadId).activity).toBe("waiting-on-you");
    // While it waits, the bot may read the page but not change it.
    expect((await tool("agent_browser_snapshot")).status).toBe(200);
    const blocked = await tool("agent_browser_fill", { selector: "@e3", text: "something else" });
    expect(blocked.status).not.toBe(200);
    expect(blocked.body.error).toMatch(/approval for this browser waits on the person/);
    // Nothing of the held click or of the refused fill has reached the
    // engine, not even the runtime's read of the page ahead of an action.
    expect(engineCalls().slice(before)).toEqual([{ name: "agent_browser_snapshot", arguments: {} }]);

    expect((await respond(card, "allow")).body).toMatchObject({ ok: true, outcome: "allowed-once" });
    const result = await held;
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.result.content[0].text).toBe("inert browser did agent_browser_click");
    // Once allowed, the click goes out like any other: read, click, read,
    // and the bot is told what the click changed.
    expect(result.body.result.content.at(-1).text).toMatch(changedBy("agent_browser_click"));
    expect(engineCalls().slice(before + 1)).toEqual([OBSERVE, { name: "agent_browser_click", arguments: { selector: "@e4" } }, OBSERVE]);
    const settled = (await cards()).find((row) => row.card.requestId === card.card.requestId);
    expect(settled.card.answered).toBe("allow");
    expect(settled.card.browserCommit.shot).toBeUndefined();
    expect((await fetch(session.info.url + shot, { headers: { origin: session.info.url } })).status).toBe(404);
    expect(listed()).toEqual([]);

    const decisions = ((await api("GET", "/api/decisions?limit=50")).body.decisions as any[]).filter((row) => row.requestId === card.card.requestId);
    expect(decisions.map((row) => [row.decision, row.source, row.rule, row.tool])).toEqual([
      ["card-shown", "outbound", "browser-commit:send", "agent_browser_click"],
      ["user-approved", "user", "browser-commit:send", "agent_browser_click"],
    ]);
    expect(decisions[0].summary).toBe("mail.example.com · Send\nMessage: Hello there");
    const activity = (await api("GET", `/api/bots/${botId}/activity`)).body.rows as any[];
    expect(activity.find((row) => row.requestId === card.card.requestId)).toMatchObject({ app: "Browser", label: "Send on your behalf", outcome: "allowed" });
  }, 60_000);

  it("clicks nothing on Deny, and re-asks when the page changed under an approval", async () => {
    page({ target: SEND });
    const before = engineCalls().length;
    const denied = click();
    await respond(await pending(), "deny");
    const refusal = await denied;
    expect(refusal.status).toBe(200);
    expect(refusal.body.result.isError).toBe(true);
    expect(refusal.body.result.content[0].text).toMatch(/the user declined\. Do not retry it/);

    const held = click();
    const first = await pending();
    page({ target: { ...SEND, fields: [{ name: "Message", type: "textarea", value: "Edited after the card was shown" }] } });
    await respond(first, "allow");
    const second = await pending();
    expect(second.card.requestId).not.toBe(first.card.requestId);
    expect(second.card.subtitle).toContain("Edited after the card was shown");
    expect((await cards()).find((row) => row.card.requestId === first.card.requestId).card).toMatchObject({ answered: "unavailable", dismissed: true, browserCommit: { pageChanged: true } });
    await respond(second, "deny");
    expect((await held).body.result.isError).toBe(true);
    expect(engineCalls().slice(before)).toEqual([]);
  }, 60_000);

  it("spends the daily allowance for sends, asks past it, and always asks before money", async () => {
    expect((await api("PATCH", `/api/bots/${botId}`, { outbound: { policy: "allow", dailyCap: 1 } })).status).toBe(200);
    page({ target: SEND });
    const open = (await cards()).length;
    const allowed = await click();
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.result.isError).not.toBe(true);
    expect(await cards()).toHaveLength(open);
    expect((await api("GET", `/api/bots/${botId}/outbound`)).body.today).toBe(1);

    const past = click();
    const asked = await pending();
    expect(asked.card.title).toBe("Send on your behalf?");
    await respond(asked, "deny");
    await past;

    expect((await api("PATCH", `/api/bots/${botId}`, { outbound: { policy: "allow", dailyCap: 100 } })).status).toBe(200);
    // The page shows a card field, so the server takes no picture of it.
    page({ url: "https://shop.example.com/checkout", target: { ...PAY, secrets: true } });
    const paying = click("@e11");
    const money = await pending();
    expect(money.card).toMatchObject({
      title: "Spend money?",
      subtitle: "shop.example.com · Continue\nCard number: 16 characters, not shown",
      heldCode: "approval.held.money",
      browserCommit: { class: "money", host: "shop.example.com", noShot: true },
    });
    expect(money.card.browserCommit.shot).toBeUndefined();
    expect(JSON.parse(readFileSync(join(session.info.dataDir, "browser-hold-shots.json"), "utf8"))).toEqual([]);
    await respond(money, "deny");
    await paying;
    expect((await api("GET", `/api/bots/${botId}/outbound`)).body.today).toBe(1);
    expect((await api("PATCH", `/api/bots/${botId}`, { outbound: { policy: "ask", dailyCap: 25 } })).status).toBe(200);
  }, 60_000);

  it("refuses a script that would act, without a card; types a line of text and holds its Enter on one", async () => {
    const before = engineCalls().length;
    const open = (await cards()).length;
    const script = await tool("agent_browser_eval", { script: "document.querySelector('form').submit()" });
    expect(script.status).toBe(200);
    expect(script.body.result.isError).toBe(true);
    expect(script.body.result.content[0].text).toMatch(/did not run this script: it clicks or submits something/);
    expect(await cards()).toHaveLength(open);
    // Text ending in a line break, at a message box: the text goes to the
    // engine without the line break, and the Enter waits on a card.
    page({ target: target({ label: "Write a message", role: "textbox", box: "multiline", multiline: true }) });
    const typing = tool("agent_browser_type", { selector: "#composer", text: "On my way\n" });
    const card = await pending();
    expect(card.card).toMatchObject({ title: "Send on your behalf?", browserCommit: { label: "Enter in Write a message" } });
    // The text is typed as its own call, with the runtime's reads around
    // it. Nothing of the Enter is there: no press, and no read ahead of one.
    const typedText = [OBSERVE, { name: "agent_browser_type", arguments: { selector: "#composer", text: "On my way" } }, OBSERVE];
    expect(engineCalls().slice(before)).toEqual(typedText);
    await respond(card, "deny");
    const typed = await typing;
    expect(typed.body.result.isError).toBe(true);
    // The refusal is the gate's own words: what typing changed on the page is not passed on with it.
    expect(typed.body.result.content).toHaveLength(1);
    expect(typed.body.result.content[0].text).toMatch(/typed the text and did not press Enter/);
    expect(typed.body.result.content[0].text).not.toMatch(/Call \d+|appeared on the page/);
    expect((await tool("agent_browser_eval", { script: "document.title" })).body.result.isError).not.toBe(true);
    expect(engineCalls().slice(before)).toEqual([...typedText, { name: "agent_browser_eval", arguments: { script: "document.title" } }]);
  }, 60_000);

  it("judges a check like a click, sends the selector it judged, and holds a reload after the send", async () => {
    page({ target: SEND });
    const checking = tool("agent_browser_check", { selector: "@e4 \n" });
    const card = await pending();
    expect(card.card).toMatchObject({ title: "Send on your behalf?", tool: "agent_browser_check" });
    await respond(card, "allow");
    expect((await checking).body.result.isError).not.toBe(true);
    expect(engineCalls().slice(-3)).toEqual([OBSERVE, { name: "agent_browser_check", arguments: { selector: "@e4" } }, OBSERVE]);

    const before = engineCalls().length;
    const reloading = tool("agent_browser_reload");
    const again = await pending();
    expect(again.card).toMatchObject({ title: "Send on your behalf?", tool: "agent_browser_reload", browserCommit: { label: "Reload, which can repeat an earlier send", fields: [] } });
    expect(again.card.subtitle).toBe("mail.example.com · Reload, which can repeat an earlier send");
    expect(again.card.browserCommit.shot).toBeUndefined();
    await respond(again, "deny");
    expect((await reloading).body.result.content[0].text).toMatch(/the user declined/);
    expect(engineCalls().slice(before)).toEqual([]);
    // Opening another address does not end it: a reload is held for as long as this browser lives.
    page({ target: target() });
    expect((await tool("agent_browser_open", { url: "https://mail.example.com/inbox" })).status).toBe(200);
    const elsewhere = tool("agent_browser_reload");
    const third = await pending();
    expect(third.card.tool).toBe("agent_browser_reload");
    await respond(third, "deny");
    await elsewhere;
    expect(engineCalls().slice(before).map((call) => call.name)).toEqual(["agent_browser_open", "agent_browser_snapshot"]);
  }, 60_000);

  it("refuses Enter while the focus is inside a frame the page read cannot look into", async () => {
    const before = engineCalls().length;
    const open = (await cards()).length;
    page({ target: { found: false, framed: true } });
    for (const key of ["Enter", "Control+Enter", "Enter+Shift"]) {
      const pressed = await tool("agent_browser_press", { key });
      expect(pressed.status).toBe(200);
      expect(pressed.body.result.isError).toBe(true);
      expect(pressed.body.result.content[0].text).toMatch(/did not press Enter: the focus is inside a frame it cannot read/);
    }
    expect((await tool("agent_browser_click", { selector: "#pay-frame" })).body.result.content[0].text).toMatch(/would land inside a frame it cannot read/);
    expect(engineCalls().slice(before)).toEqual([]);
    expect(await cards()).toHaveLength(open);
    page({ target: target() });
  }, 60_000);

  // A call the engine never answered leaves the browser uncertain until the
  // engine answers again (the runtime's recovery). The next call is the
  // runtime's to answer, also when it is one the gate would judge.
  it("recovers from a call the engine lost before it judges the next one, and holds that one as usual once the bot has looked again", async () => {
    page({ target: target() });
    const before = engineCalls().length;
    const open = (await cards()).length;
    writeFileSync(join(fixture, "lose-click"), "");
    const lost = await click("#details");
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(lost.body.result.isError).toBe(true);
    expect(lost.body.result.content[0].text).toMatch(/did not answer this agent_browser_click call\. It may still be running, or it may already have taken effect/);
    // The bot's next call would send. It does not run: not read, not
    // judged, no card. The bot hears that the lost call has ended.
    page({ target: SEND });
    const next = await click("@e4");
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.result.isError).not.toBe(true);
    expect(next.body.result.content).toHaveLength(1);
    expect(next.body.result.content[0].text).toMatch(/the earlier agent_browser_click call that did not answer has ended, and it may have taken effect\. This call did not run\. The current page is https:\/\/mail\.example\.com\/compose#top\./);
    expect(await cards()).toHaveLength(open);
    const sofar = [OBSERVE, { name: "agent_browser_click", arguments: { selector: "#details" } }, { name: "agent_browser_get_url", arguments: {} }];
    expect(engineCalls().slice(before)).toEqual(sofar);
    // The engine numbers its refs anew with every snapshot, and one may
    // have been lost with that call: a ref from before it is not acted on.
    const stale = await click("@e4");
    expect(stale.status, JSON.stringify(stale.body)).toBe(200);
    expect(stale.body.result.isError).toBe(true);
    expect(stale.body.result.content[0].text).toMatch(/an earlier browser call was lost, and the browser may have renumbered its refs since your last snapshot.*Take a new snapshot and use the @ref it gives\./);
    expect(await cards()).toHaveLength(open);
    expect(engineCalls().slice(before)).toEqual(sofar);
    // With a snapshot seen, the same click is judged like any other that would send, and held.
    expect((await tool("agent_browser_snapshot")).status).toBe(200);
    const held = click("@e4");
    const card = await pending();
    expect(card.card).toMatchObject({ title: "Send on your behalf?", tool: "agent_browser_click", browserCommit: { label: "Send" } });
    await respond(card, "deny");
    expect((await held).body.result.content[0].text).toMatch(/the user declined/);
    expect(engineCalls().slice(before)).toEqual([...sofar, { name: "agent_browser_snapshot", arguments: {} }]);
  }, 60_000);

  /** The engine's side of a browser call: the real stdio proxy, in front of the real route. */
  const engineProxy = () => {
    const proxy = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "browser"], {
      env: { OMB_HARNESS_URL: session.info.url, OMB_MCP_TOKEN: token, OMB_MCP_CALL_TIMEOUT_MS: "570000" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const out = { answered: "" };
    proxy.stdout.on("data", (chunk) => { out.answered += chunk; });
    const send = (message: unknown) => proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...(message as object) })}\n`);
    const stop = async () => {
      if (proxy.exitCode !== null || proxy.signalCode !== null) return;
      proxy.kill();
      await new Promise<void>((resolve) => proxy.once("close", () => resolve()));
    };
    return { proxy, out, send, stop };
  };

  // After Allow the click goes out, and the runtime reads the page first.
  // A call the engine cancels during that read is one nobody waits for.
  it("makes no click when the call is cancelled after Allow, while the page is read ahead of it", async () => {
    page({ target: SEND });
    const before = engineCalls().length;
    const engine = engineProxy();
    const slow = join(fixture, "slow-observe");
    try {
      writeFileSync(slow, "");
      engine.send({ id: 43, method: "tools/call", params: { name: "agent_browser_click", arguments: { selector: "@e4" } } });
      const card = await pending();
      expect(engineCalls().slice(before)).toEqual([]);
      expect((await respond(card, "allow")).body).toMatchObject({ ok: true, outcome: "allowed-once" });
      // The approved click is on its way: the read ahead of it is at the engine, the click is not.
      await expect.poll(() => engineCalls().slice(before), { timeout: 5_000 }).toEqual([OBSERVE]);
      engine.send({ method: "notifications/cancelled", params: { requestId: 43, reason: "the engine stopped waiting" } });
      // The proxy takes its input in order: once it answers this, it has closed the cancelled call's request.
      engine.send({ id: 44, method: "ping" });
      await expect.poll(() => engine.out.answered, { timeout: 5_000 }).toContain('"id":44');
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(slow);
      // Time for that read to be answered, and for a click to follow it were one still coming.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect((await tool("agent_browser_snapshot")).status).toBe(200);
      expect(engineCalls().slice(before)).toEqual([OBSERVE, { name: "agent_browser_snapshot", arguments: {} }]);
      expect(engine.out.answered).not.toContain('"id":43');
      // The browser is the bot's again.
      page({ target: target() });
      expect((await click("#details")).status).toBe(200);
    } finally {
      rmSync(slow, { force: true });
      await engine.stop();
    }
  }, 60_000);

  // The engine itself goes away mid-hold: its proxy's input closes.
  it("ends the hold when the proxy's input closes, and a late Allow sends nothing", async () => {
    page({ target: SEND });
    const before = engineCalls().length;
    const engine = engineProxy();
    try {
      engine.send({ id: 45, method: "tools/call", params: { name: "agent_browser_click", arguments: { selector: "@e4" } } });
      const card = await pending();
      engine.proxy.stdin.end();
      await expect.poll(async () => (await cards()).find((row) => row.card.requestId === card.card.requestId).card.answered, { timeout: 5_000 }).toBe("unavailable");
      expect((await respond(card, "allow")).body).toMatchObject({ outcome: "unavailable" });
      // The browser is the bot's again, and the click whose caller went away was never made.
      page({ target: target() });
      expect((await click("#details")).status).toBe(200);
      expect(engineCalls().slice(before)).toEqual([OBSERVE, { name: "agent_browser_click", arguments: { selector: "#details" } }, OBSERVE]);
      expect(engine.out.answered).toBe("");
    } finally {
      await engine.stop();
    }
  }, 60_000);

  // The engine reaches the route through the stdio proxy, and abandons a
  // call by sending notifications/cancelled. The real proxy, the real route.
  it("ends the hold when the engine cancels the call through its MCP proxy, and a late Allow sends nothing", async () => {
    page({ target: SEND });
    const before = engineCalls().length;
    const proxy = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "browser"], {
      env: { OMB_HARNESS_URL: session.info.url, OMB_MCP_TOKEN: token, OMB_MCP_CALL_TIMEOUT_MS: "570000" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let answered = "";
    proxy.stdout.on("data", (chunk) => { answered += chunk; });
    try {
      proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "agent_browser_click", arguments: { selector: "@e4" } } })}\n`);
      const card = await pending();
      proxy.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41, reason: "the engine stopped waiting" } })}\n`);
      await expect.poll(async () => (await cards()).find((row) => row.card.requestId === card.card.requestId).card.answered, { timeout: 5_000 }).toBe("unavailable");
      expect((await respond(card, "allow")).body).toMatchObject({ outcome: "unavailable" });
      // The browser is the bot's again, and the cancelled call was never made.
      page({ target: target() });
      expect((await click("#details")).status).toBe(200);
      expect(engineCalls().slice(before)).toEqual([OBSERVE, { name: "agent_browser_click", arguments: { selector: "#details" } }, OBSERVE]);
      expect(answered).toBe("");
    } finally {
      proxy.kill();
      await new Promise<void>((resolve) => proxy.once("close", () => resolve()));
    }
  }, 60_000);

  it("closes the card and frees the browser when the turn is stopped mid-hold", async () => {
    page({ target: SEND });
    const before = engineCalls().length;
    const held = click();
    const card = await pending();
    expect((await api("POST", `/api/bots/${botId}/interrupt`, { threadId })).status).toBe(200);
    expect((await held).status).toBe(401);
    await expect.poll(async () => (await cards()).find((row) => row.card.requestId === card.card.requestId).card.answered, { timeout: 5_000 }).toBe("unavailable");
    expect((await respond(card, "allow")).body).toMatchObject({ outcome: "unavailable" });
    // Nothing of the held click reached the engine, before the stop or after the late Allow.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(engineCalls().slice(before)).toEqual([]);
    expect((await cards()).find((row) => row.card.requestId === card.card.requestId).card.answered).toBe("unavailable");
  }, 60_000);
});
