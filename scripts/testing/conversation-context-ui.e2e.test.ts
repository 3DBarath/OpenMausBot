import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { agentBrowser, sessionEnv, UI_TOOLS_DIR, type UiHandle } from "./control-omb-ui.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
if (!enabled) console.log("skipping conversation context UI: set OMB_UI_E2E=1 to install the pinned browser");

(enabled ? it : it.skip)("attaches, removes and sends a frozen visible conversation with failure and cancellation recovery", async () => {
  let child: ChildProcess | undefined;
  try {
    let output = "", errors = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(root, "scripts/control-omb.ts"), "ui", "launch"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk) => { output += String(chunk); });
    child.stderr!.on("data", (chunk) => { errors += String(chunk); });
    let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(errors);
      try { info = JSON.parse(output); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 600_000 }).toBe(true);
    const handle = info!;
    const browser = JSON.parse(readFileSync(handle.ui, "utf8")) as UiHandle;
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", handle.ui, ...args]) as Promise<any>;
    const cli = (...args: string[]) => runControlOmb([...args, "--url", handle.url]) as Promise<any>;
    const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
    // Opening the browser is not hydration. Keep the seeded recipient
    // selected before another bot can become the initial default selection.
    await expect.poll(() => evaluate("document.querySelector('textarea[aria-label=\"Message Pepper\"]') !== null"), { timeout: 15_000 }).toBe(true);
    const source = (await cli("new-bot", "--name", "Context source")).bot;
    await cli("send", "--bot", source.id, "--task", source.activeTaskId, "--text", "Source evidence from the fixture");
    expect((await cli("wait", "--bot", source.id, "--task", source.activeTaskId, "--timeout", "25")).status).toBe("settled");
    const sourceRow = `[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.includes('Context source'))`;
    const open = async () => {
      await ui("click", "--name", "Attach context");
      await ui("click", "--name", "Add conversation");
      await expect.poll(() => evaluate(`${sourceRow}?.textContent ?? ''`), { timeout: 15_000 }).toContain("Context source");
    };
    await open();
    await evaluate(`window.contextFetch = window.fetch; window.fetch = async (url, init) => String(url).includes('${source.activeTaskId}/messages') ? new Response('{}', {status:403}) : window.contextFetch(url,init); true`);
    await evaluate(`${sourceRow}.click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog] [role=alert]')?.textContent")).toContain("access has changed");
    expect(await evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') === null")).toBe(true);
    await ui("press", "--keys", "Escape");
    await evaluate("window.fetch=window.contextFetch; true");

    await open();
    await evaluate(`window.fetch = (url, init) => String(url).includes('${source.activeTaskId}/messages') ? new Promise(resolve=>{window.releaseContext=()=>resolve(new Response(JSON.stringify({messages:[{role:'user',text:'Late response'}]})));}) : window.contextFetch(url,init); ${sourceRow}.click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[role=dialog]')?.getAttribute('aria-busy')")).toBe("true");
    await ui("press", "--keys", "Escape");
    await evaluate("window.releaseContext(); window.fetch=window.contextFetch; true");
    await expect.poll(() => evaluate("document.querySelector('textarea[aria-label=\"Message Pepper\"]')?.placeholder")).not.toContain("Attaching");
    expect(await evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') === null")).toBe(true);

    await open();
    await ui("screenshot", "--out", `${handle.logPath}.context-picker.png`);
    await evaluate(`${sourceRow}.click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') !== null")).toBe(true);
    await ui("click", "--name", "Remove conversation context");
    expect(await evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') === null")).toBe(true);
    await open();
    await evaluate(`${sourceRow}.click(); true`);
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') !== null")).toBe(true);
    await evaluate("location.reload(); true");
    await expect.poll(() => evaluate("document.querySelector('[aria-label=\"Remove conversation context\"]') !== null"), { timeout: 15_000 }).toBe(true);
    await cli("send", "--bot", source.id, "--task", source.activeTaskId, "--text", "A later source message that must not enter the snapshot");
    await cli("wait", "--bot", source.id, "--task", source.activeTaskId, "--timeout", "25");
    for (const width of [1100, 390]) {
      await agentBrowser(browser.binary, sessionEnv(browser), ["set", "viewport", String(width), "844"]);
      // ResizeObserver aligns the existing mention mirror on the next frame.
      await expect.poll(() => evaluate("document.documentElement.scrollWidth <= innerWidth"), { timeout: 15_000 }).toBe(true);
      await ui("screenshot", "--out", `${handle.logPath}.context-${width}.png`);
    }
    await ui("type", "--name", "Message Pepper", "--text", "Use the attached chat");
    await ui("press", "--keys", "Enter");
    expect((await ui("wait-settle", "--timeout", "60")).ok).toBe(true);
    const bot = (await fetch(`${handle.url}/api/bots`).then(r => r.json())).bots.find((item: any) => item.id === handle.botId);
    const messages = (await fetch(`${handle.url}/api/threads/${bot.threadId}/messages?limit=50`).then(r => r.json())).messages;
    const sent = messages.find((message: any) => message.role === "user" && message.text.includes("Use the attached chat"));
    expect(sent.text).toContain("Source evidence from the fixture");
    expect(sent.text).toContain(`openmausbot://thread/${source.activeTaskId}?bot=${source.id}`);
    expect(sent.text).not.toContain("A later source message");
    expect(sent.text).not.toContain("Late response");
    expect((await ui("console")).messages.filter((message: any) => message.type === "error")).toEqual([]);
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
  }
}, 660_000);
