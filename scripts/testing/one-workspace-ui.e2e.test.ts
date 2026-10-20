// This computer and My Cloud as one workspace in the real renderer: two real servers (scripts/verify-one-workspace.ts),
// main's own wiring behind the bridge, the pinned headless browser. Screenshots at 1280 px go to OMB_ONE_WORKSPACE_SHOTS
// (else the fixture's own folder).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { closeBrowserSession, resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, UI_TOOLS_DIR } from "./control-omb-ui.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { seedOneWorkspace } from "./one-workspace-fixture.ts";
import { mountOneWorkspacePages, PICTURE, welcomed, type OneWorkspacePages } from "../verify-one-workspace.ts";

const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = process.env.OMB_UI_E2E === "1" || Boolean(binary);
if (!enabled) console.info("skipping one-workspace UI e2e: set OMB_UI_E2E=1 to install the pinned browser");

const ROWS = "[data-sidebar-bot-row], [data-sidebar-group-row], [data-other-side-bot], [data-other-side-room]";

(enabled ? it : it.skip)("shows This computer's and My Cloud's bots once each in one sidebar and Team map, opens a Cloud bot on My Cloud, and keeps an asleep Cloud's bots", async () => {
  let fx: CloudSendFixture | undefined;
  let pages: OneWorkspacePages | undefined;
  let env: NodeJS.ProcessEnv | undefined;
  let tools: { binary: string; chrome: string | null } | undefined;
  const home = mkdtempSync(join(tmpdir(), "omb1w-"));
  try {
    fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-ui-${randomBytes(12).toString("hex")}` });
    await welcomed(fx);
    const ids = await seedOneWorkspace(fx, PICTURE);
    await fx.onCloud("PATCH", `/api/bots/${ids.miso}`, { computer: "cloud" });
    pages = await mountOneWorkspacePages(fx);
    const shots = resolve(process.env.OMB_ONE_WORKSPACE_SHOTS ?? join(fx.root, "shots"));
    mkdirSync(shots, { recursive: true });

    tools = await ensureUiBrowser(process.env);
    env = sessionEnv({ home, session: `o1-${randomBytes(3).toString("hex")}`, chrome: tools.chrome });
    const ab = (...args: string[]) => agentBrowser(tools!.binary, env!, args, 120_000);
    const evaluate = async <T>(js: string) => (await ab("eval", js)).result as T;
    const shot = (name: string) => ab("screenshot", join(shots, `${name}.png`));
    const until = async <T>(js: string, ok: (value: T) => boolean, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = await evaluate<T>(js).catch(() => undefined as T);
        if (value !== undefined && ok(value)) return value;
        if (Date.now() > deadline) {
          await shot("failure").catch(() => {});
          const page = await evaluate<string>("location.href + ' ' + document.body.innerText.slice(0, 400)").catch(() => "");
          throw new Error(`timed out waiting for ${js}: ${JSON.stringify(value)} on ${page}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    };
    const rows = () => evaluate<Array<{ id: string; home: string | null; twin: boolean; other: boolean; label: string }>>(`[...document.querySelectorAll(${JSON.stringify(ROWS)})].map((row) => ({
      id: row.dataset.sidebarBotRow ?? row.dataset.sidebarGroupRow ?? row.dataset.otherSideBot ?? row.dataset.otherSideRoom,
      home: row.querySelector("[data-home-badge]")?.dataset.homeBadge ?? null, twin: Boolean(row.querySelector("[data-home-twin]")),
      other: Boolean(row.dataset.otherSideBot ?? row.dataset.otherSideRoom), label: row.querySelector("[data-home-badge]")?.getAttribute("aria-label") ?? "" }))`);
    const local = (query = "") => `${pages!.local.previewUrl}?page=local${query}`;
    await ab("set", "viewport", "1280", "800");

    // This computer's page: its own Ember and Juno, My Cloud's Miso, Atlas, Kit and Launch, each once; Ember (sent to
    // My Cloud, the same id there) shows as this computer's copy.
    const everything = Object.values(ids).sort();
    await ab("open", local());
    await until<number>("document.querySelectorAll('[data-other-side-bot], [data-other-side-room]').length", (count) => count === 4);
    const here = await rows();
    expect(here.map((row) => row.id).sort()).toEqual(everything);
    const byId = Object.fromEntries(here.map((row) => [row.id, row]));
    expect([byId[ids.ember]!.home, byId[ids.ember]!.twin, byId[ids.ember]!.other]).toEqual(["computer", true, false]);
    expect(byId[ids.ember]!.label).toBe("On this computer · also on My Cloud");
    expect([byId[ids.juno]!.home, byId[ids.atlas]!.home, byId[ids.launch]!.home]).toEqual(["computer", "cloud", "cloud"]);
    expect(await evaluate("document.querySelector('[data-workspace-switcher] button')?.getAttribute('aria-label')")).toBe("Switch server: This computer and My Cloud");
    await shot("1-sidebar-this-computer-light");
    await ab("open", local("&skin=midnight"));
    await until<number>("document.querySelectorAll('[data-other-side-bot]').length", (count) => count === 3);
    await shot("2-sidebar-this-computer-dark");

    // The switcher: one entry for both, other servers as before, and the setting.
    await ab("open", local());
    await until<number>("document.querySelectorAll('[data-other-side-bot]').length", (count) => count === 3);
    await evaluate("document.querySelector('[data-workspace-switcher] button').click(); true");
    const menu = await until<string[]>("[...document.querySelectorAll('[data-menu-stand-in] [role=menuitem]')].map((item) => item.textContent)", (items) => items.length > 0);
    expect(menu).toEqual(["✓This computer and My CloudAlways on", "Office serveroffice.example.test", "✓Show This computer and My Cloud together", "Connect to a server…"]);
    await shot("3-switcher-menu-light");

    // Opening a Cloud bot moves the window to My Cloud's page, which opens it from My Cloud's own server; a message sent
    // there reaches My Cloud's server and never this computer's.
    await ab("open", local());
    await until<number>("document.querySelectorAll('[data-other-side-bot]').length", (count) => count === 3);
    await evaluate(`document.querySelector('[data-other-side-bot="${ids.atlas}"]').click(); true`);
    await until<string>("location.href", (href) => href.startsWith(pages!.cloud.previewUrl));
    await until<string | null>(`document.querySelector('[data-sidebar-bot-row="${ids.atlas}"]')?.getAttribute("aria-current") ?? null`, (current) => current === "page");
    expect(await evaluate("fetch('/api/auth/session').then((response) => response.json()).then((session) => session.cloudHome === true)")).toBe(true);
    const there = await rows();
    expect(there.map((row) => row.id).sort()).toEqual(everything);
    expect(Object.fromEntries(there.map((row) => [row.id, row.home]))).toEqual(Object.fromEntries(here.map((row) => [row.id, row.home])));
    await shot("4-sidebar-my-cloud-light");
    const said = `hello from one workspace ${randomBytes(3).toString("hex")}`;
    await ab("fill", "textarea[aria-label='Message Atlas']", said);
    await ab("press", "Enter");
    const cloudHas = async () => JSON.stringify((await fx!.onCloud("GET", "/api/bots?messages=50")).body).includes(said);
    const deadline = Date.now() + 20_000;
    while (!(await cloudHas()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await cloudHas()).toBe(true);
    expect(JSON.stringify((await fx.local("GET", "/api/bots?messages=50")).body)).not.toContain(said);
    await ab("open", `${pages.cloud.previewUrl}?page=cloud&skin=midnight`);
    await until<number>("document.querySelectorAll('[data-other-side-bot]').length", (count) => count === 2);
    await shot("5-sidebar-my-cloud-dark");

    // A row of this computer opens it back on this computer's page.
    await evaluate(`document.querySelector('[data-other-side-bot="${ids.juno}"]').click(); true`);
    await until<string>("location.href", (href) => href.startsWith(pages!.local.previewUrl));
    await until<string | null>(`document.querySelector('[data-sidebar-bot-row="${ids.juno}"]')?.getAttribute("aria-current") ?? null`, (current) => current === "page");

    // The Team map: both sides' teams and bots, My Cloud's with their computers, opening there.
    for (const [skin, name] of [["meadow", "6-team-map-light"], ["midnight", "7-team-map-dark"]] as const) {
      await ab("open", local(`&advanced=1&skin=${skin}`));
      await until<boolean>("Boolean([...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Team map'))", Boolean);
      await evaluate("[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Team map').click(); true");
      await until<number>("document.querySelectorAll('[data-elsewhere-card]').length", (count) => count === 3);
      const showComputers = "[...document.querySelectorAll('button[aria-pressed]')].find((button) => button.textContent.trim() === 'Show computers')";
      if (!await evaluate<boolean>(`${showComputers}?.getAttribute('aria-pressed') === 'true'`)) await evaluate(`${showComputers}.click(); true`);
      const map = await evaluate<{ cards: string[]; elsewhere: string[]; computers: string[] }>(`({
        cards: [...document.querySelectorAll('[data-bot-id]')].map((card) => card.dataset.botId),
        elsewhere: [...document.querySelectorAll('[data-elsewhere-card]')].map((card) => card.dataset.elsewhereCard),
        computers: [...document.querySelectorAll('[data-computer-node]')].map((node) => node.dataset.computerNode) })`);
      expect([...map.cards, ...map.elsewhere].sort()).toEqual([ids.ember, ids.juno, ids.miso, ids.atlas, ids.kit].sort());
      expect(map.elsewhere.sort()).toEqual([ids.miso, ids.atlas, ids.kit].sort());
      expect(map.computers).toContain(ids.miso);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await shot(name);
    }

    // An asleep My Cloud: its bots stay, dimmed, with a plain line; nothing calls it.
    pages.one.power.asleepNow = true;
    const before = pages.one.cloudCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    for (const [skin, name] of [["meadow", "8-sidebar-cloud-asleep-light"], ["midnight", "9-sidebar-cloud-asleep-dark"]] as const) {
      await ab("open", local(`&skin=${skin}`));
      await until<string | null>("document.querySelector('[data-one-workspace-status]')?.dataset.oneWorkspaceStatus ?? null", (status) => status === "asleep");
      expect((await rows()).filter((row) => row.other).map((row) => row.id).sort()).toEqual([ids.miso, ids.atlas, ids.kit, ids.launch].sort());
      expect(await evaluate("[...document.querySelectorAll('[data-other-side-bot]')].every((row) => row.textContent.includes('Asleep'))")).toBe(true);
      expect(await evaluate("document.querySelector('[data-one-workspace-status]').textContent")).toBe("My Cloud is asleep. Opening one of its bots wakes it.");
      await shot(name);
    }
    expect(pages.one.cloudCalls.length).toBe(before);
  } finally {
    if (tools && env) {
      if (!await closeBrowserSession(tools.binary, env)) await agentBrowser(tools.binary, env, ["close"], 15_000).catch(() => {});
    }
    await pages?.close();
    await fx?.close();
    rmSync(home, { recursive: true, force: true });
  }
}, hostTimeout(300_000));
