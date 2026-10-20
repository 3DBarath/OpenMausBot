// This computer and My Cloud as one workspace, end to end: two real servers (this computer's and a Cloud home, bots sent
// between them by the real Send to My Cloud) with main's own wiring reading each for the other's page
// (one-workspace-fixture.ts). Disposable homes; no network.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { OneWorkspaceView } from "../../shared/one-workspace.ts";
import { openChatLink } from "../../src/components/ThreadRefs.tsx";
import { mergeWorkspace } from "../../src/lib/one-workspace.ts";
import { initialState, type Action, type AppState, type Bot, type Group } from "../../src/state/store.tsx";
import { launchCloudSendFixture, type CloudSendFixture } from "./cloud-send-fixture.ts";
import { seedOneWorkspace, wireOneWorkspace, type OneWorkspaceWiring } from "./one-workspace-fixture.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { hostTimeout } from "../../server/testing/host-timeout.ts";

const DOT = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
let fx: CloudSendFixture;
let one: OneWorkspaceWiring;
let ids: Awaited<ReturnType<typeof seedOneWorkspace>>;

beforeAll(async () => {
  fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-one-${randomBytes(12).toString("hex")}` });
  ids = await seedOneWorkspace(fx, DOT);
  one = wireOneWorkspace(fx);
}, hostTimeout(90_000));
afterAll(async () => { await fx?.close(); });

const storeOf = async (side: "local" | "onCloud"): Promise<{ bots: Bot[]; groups: Group[]; sections: string[] }> => (await fx[side]("GET", "/api/bots?messages=0")).body;
/** What a page shows: its own store's rows plus the other side's, by id. */
function rows(view: OneWorkspaceView, own: { bots: Bot[]; groups: Group[]; sections: string[] }) {
  const merged = mergeWorkspace(view, own);
  const shown = [...own.bots.filter((bot) => !bot.hidden && !merged.hidden.has(bot.id)), ...own.groups.filter((group) => !group.dm && !merged.hidden.has(group.id)), ...merged.bots, ...merged.rooms];
  return { merged, ids: shown.map((item) => item.id), homes: Object.fromEntries(shown.map((item) => [item.id, merged.homes.get(item.id)?.side])) };
}

it("shows every bot and room of both sides once, each with its home, on this computer's page and on My Cloud's", async () => {
  const fromLocal = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(fromLocal.other).toMatchObject({ side: "cloud", state: "ready" });
  expect(fromLocal.other.bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Ember", "Kit", "Miso"]);
  const here = rows(fromLocal, await storeOf("local"));
  const everything = Object.values(ids).sort();
  expect([...here.ids].sort()).toEqual(everything);
  expect(new Set(here.ids).size).toBe(here.ids.length);
  expect(here.homes).toEqual({ [ids.ember]: "computer", [ids.juno]: "computer", [ids.miso]: "cloud", [ids.atlas]: "cloud", [ids.kit]: "cloud", [ids.launch]: "cloud" });
  expect(here.merged.homes.get(ids.ember)).toEqual({ side: "computer", twin: true });
  expect(here.merged.sections).toEqual(["Ops"]);

  const fromCloud = await one.call<OneWorkspaceView>("one-workspace:view", "cloud");
  expect(fromCloud.other).toMatchObject({ side: "computer", state: "ready" });
  const there = rows(fromCloud, await storeOf("onCloud"));
  expect([...there.ids].sort()).toEqual(everything);
  expect(new Set(there.ids).size).toBe(there.ids.length);
  expect(there.homes).toEqual(here.homes);
});

it("reads My Cloud in the background with the window's own sign-in, and hands a page only what a row shows", async () => {
  const view = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(one.cloudCalls.length).toBeGreaterThan(0);
  for (const call of one.cloudCalls) {
    expect(call.headers["x-omb-background"]).toBe("1");
    expect(call.headers.authorization).toBeUndefined();
  }
  const ember = view.other.bots.find((bot) => bot.id === ids.ember)!;
  expect(ember.avatarUrl).toBe(`data:image/png;base64,${DOT.toString("base64")}`);
  const text = JSON.stringify(view);
  for (const secret of ["You are Atlas", "You are Miso", "You are Ember", "modelSelection", "soul", fx.owner, fx.ownerCapability]) expect(text).not.toContain(secret);
});

it("opening a Cloud bot moves the window to My Cloud, whose page opens it from My Cloud's own server; this computer's page opens its own the same way", async () => {
  await one.call("one-workspace:view", "local");
  await expect(one.call("one-workspace:open", "local", { side: "cloud", id: ids.juno })).rejects.toThrow(/no longer on My Cloud/);
  await expect(one.call("one-workspace:open", null, { side: "cloud", id: ids.atlas })).rejects.toThrow(/only available/);
  expect(one.went).toEqual([]);

  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.atlas });
  expect(one.went).toEqual(["cloud"]);
  expect(await one.call("one-workspace:take", "local")).toBeNull();
  const link = await one.call<string>("one-workspace:take", "cloud");
  expect(link).toBe(`openmausbot://bot/${ids.atlas}`);
  // My Cloud's page opens the link against My Cloud's own bots, as useExternalChatLinks does after hydrating.
  const cloud = await storeOf("onCloud");
  const actions: Action[] = [];
  const page: AppState = { ...initialState, bots: cloud.bots.map((bot) => ({ ...bot, messages: [] })), groups: cloud.groups.map((group) => ({ ...group, messages: [] })), hydrated: true };
  expect(openChatLink((action) => actions.push(action), link, page, false)).toBe(true);
  expect(actions[0]).toEqual({ type: "select", id: ids.atlas });
  expect((await storeOf("local")).bots.some((bot) => bot.id === ids.atlas)).toBe(false);

  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.launch });
  expect(await one.call("one-workspace:take", "cloud")).toBe(`openmausbot://bot/${ids.launch}`);

  await one.call("one-workspace:view", "cloud");
  await one.call("one-workspace:open", "cloud", { side: "computer", id: ids.juno });
  expect(one.went).toEqual(["cloud", "cloud", "local"]);
  expect(await one.call("one-workspace:take", "local")).toBe(`openmausbot://bot/${ids.juno}`);
});

it("an unreachable or asleep My Cloud keeps its bots (an asleep one is never called), then and after a restart", async () => {
  await one.call("one-workspace:view", "local");
  one.network.down = true;
  await new Promise((resolve) => setTimeout(resolve, 5_100));
  const offline = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(offline.other.state).toBe("unreachable");
  expect(offline.other.bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Ember", "Kit", "Miso"]);
  expect(mergeWorkspace(offline, await storeOf("local")).bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Kit", "Miso"]);

  one.network.down = false;
  one.power.asleepNow = true;
  const before = one.cloudCalls.length;
  const asleep = await one.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(one.cloudCalls.length).toBe(before);
  expect(asleep.other.state).toBe("asleep");
  expect(asleep.other.bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Ember", "Kit", "Miso"]);
  // Opening one is what wakes it.
  await one.call("one-workspace:open", "local", { side: "cloud", id: ids.kit });
  expect(one.went.at(-1)).toBe("cloud");

  const restarted = wireOneWorkspace(fx);
  restarted.power.asleepNow = true;
  const atLaunch = await restarted.call<OneWorkspaceView>("one-workspace:view", "local");
  expect(restarted.cloudCalls).toEqual([]);
  expect(atLaunch.other.state).toBe("asleep");
  expect(atLaunch.other.bots.map((bot) => bot.name).sort()).toEqual(["Atlas", "Ember", "Kit", "Miso"]);

  const never = wireOneWorkspace(fx, { cloudOrigin: `http://127.0.0.1:${await freePortBlock([0])}`, file: join(fx.root, "never-read.json") });
  expect((await never.call<OneWorkspaceView>("one-workspace:view", "local")).other).toMatchObject({ state: "unreachable", bots: [] });
}, hostTimeout(30_000));
