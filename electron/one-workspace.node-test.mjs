import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aheadCounts, automationCounts, AUTOMATIONS_FRESH_MS, createOneWorkspace, installOneWorkspace, oneWorkspaceMenu, OPEN_FOR_MS, parseRoster, PICTURE_MAX_BYTES, ROSTER_FRESH_MS, rosterBot } from "./one-workspace.mjs";

const CLOUD = "https://omb-u-1.fly.dev";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const memoryStore = (initial = {}) => { let value = initial; return { read: () => value, write: (next) => { value = structuredClone(next); }, get value() { return value; } }; };
const bot = (id, extra = {}) => ({ id, threadId: `t-${id}`, name: id, title: "", color: "blue", unread: false, avatarUrl: null, soul: "secret instructions", modelSelection: { instanceId: "claude" }, messages: [{ text: "hi" }], ...extra });

function harness({ cloudBody = { bots: [bot("atlas")], groups: [], sections: [] }, localBody = { bots: [bot("ember")], groups: [], sections: [] }, ...options } = {}) {
  const calls = { cloud: [], local: [] };
  let clock = 1_000_000;
  const power = { asleepNow: false, held: 0, asleep() { return this.asleepNow; }, hold() { this.held++; } };
  const store = options.store ?? memoryStore();
  const reader = (side, body) => async (route) => {
    calls[side].push(route);
    const answer = typeof body === "function" ? await body(route) : body;
    return answer instanceof Response ? answer : json(answer);
  };
  const one = createOneWorkspace({
    store, power, now: () => clock, readWaitMs: 50,
    cloud: () => (options.noCloud ? null : { origin: CLOUD, name: options.cloudName ?? "My Cloud" }),
    readCloud: reader("cloud", cloudBody), readLocal: reader("local", localBody),
    localDefault: () => options.localDefault ?? true, twinHome: () => options.twinHome ?? "computer", reason: () => options.reason ?? null,
    onChange: options.onChange,
  });
  const roster = (side) => calls[side].filter((route) => route === "/api/bots?messages=0");
  return { one, calls, roster, power, store, tick: (ms) => { clock += ms; } };
}

test("a roster carries what a row shows and never a bot's instructions, model, messages or settings", () => {
  const projected = rosterBot(bot("ember", { section: " Research ", chiefOfStaff: true, busy: true, activity: "working", cwd: "/Users/amit", approvalMode: "full",
    tasks: [{ threadId: "run-1", title: "Morning digest", unread: true, routineRunId: "r1" }, { threadId: "old-1", unread: true, archivedAt: 5 }, { threadId: "t-ember", title: "Hello" }] }));
  assert.deepEqual(projected, { id: "ember", threadId: "t-ember", name: "ember", title: "", color: "blue", avatarUrl: null, section: "Research", chiefOfStaff: true, unread: false, busy: true, activity: "working",
    threads: ["t-ember", "run-1"], unreadThreads: ["run-1"] });
  assert.equal(JSON.stringify(projected).includes("Morning digest"), false);
  assert.equal(rosterBot(bot("old", { hidden: true })), null);
  assert.equal(rosterBot({ id: "../x" }), null);
  assert.equal(rosterBot(bot("u", { tasks: [{ unread: true }] })).unread, true);
  const parsed = parseRoster({ bots: [bot("a"), "nope", null], groups: [{ id: "room1", name: "Launch", memberIds: ["a", 7], unread: true, busyBotId: "a", section: "Ops" }, { id: "dm1", dm: true }], sections: ["Ops", "Ops", " ", 3] });
  assert.deepEqual(parsed.rooms, [{ id: "room1", name: "Launch", memberIds: ["a"], unread: true, working: true, section: "Ops" }]);
  assert.deepEqual(parsed.sections, ["Ops"]);
  assert.deepEqual(parsed.bots.map((entry) => entry.id), ["a"]);
});

test("each page gets the other side: this computer's page reads My Cloud, My Cloud's page reads this computer", async () => {
  const { one, calls } = harness();
  const fromLocal = await one.view("computer");
  assert.equal(fromLocal.page, "computer");
  assert.equal(fromLocal.other.side, "cloud");
  assert.equal(fromLocal.other.state, "ready");
  assert.deepEqual(fromLocal.other.bots.map((entry) => entry.id), ["atlas"]);
  const fromCloud = await one.view("cloud");
  assert.deepEqual(fromCloud.other.bots.map((entry) => entry.id), ["ember"]);
  // Each side once for its bots and automations; this computer's page also reads this computer's conversation times.
  assert.deepEqual(calls.cloud, ["/api/bots?messages=0", `/api/routines?from=${Number.MAX_SAFE_INTEGER}`, "/api/webhooks"]);
  assert.deepEqual([...new Set(calls.local)], ["/api/bots?messages=0", `/api/routines?from=${Number.MAX_SAFE_INTEGER}`, "/api/webhooks"]);
  assert.equal(await one.view("server"), null);
});

test("nothing is merged while the person keeps them apart, has no My Cloud, or runs another workspace on this computer", async () => {
  for (const options of [{ store: memoryStore({ together: false }) }, { noCloud: true }, { localDefault: false }]) {
    const { one, calls } = harness(options);
    assert.equal(await one.view("computer"), null);
    assert.equal(one.peek("computer"), null);
    assert.deepEqual(calls, { cloud: [], local: [] });
    assert.throws(() => one.open("computer", { side: "cloud", id: "atlas" }), /shown apart/);
  }
});

test("a roster is read again only when older than its freshness, and a change is announced once", async () => {
  let changes = 0;
  const bots = [bot("atlas")];
  const { one, roster, tick } = harness({ cloudBody: () => ({ bots, groups: [], sections: [] }), onChange: () => changes++ });
  await one.view("computer");
  await one.view("computer");
  assert.equal(roster("cloud").length, 1);
  tick(ROSTER_FRESH_MS);
  bots.push(bot("juno"));
  const view = await one.view("computer");
  assert.equal(roster("cloud").length, 2);
  assert.deepEqual(view.other.bots.map((entry) => entry.id), ["atlas", "juno"]);
  assert.equal(changes, 2);
  tick(ROSTER_FRESH_MS);
  await one.view("computer");
  assert.equal(changes, 2);
});

test("an asleep Cloud is never called and keeps its bots; a Cloud going to sleep is held; its bots never vanish", async () => {
  const { one, calls, power, tick } = harness();
  await one.view("computer");
  power.asleepNow = true;
  tick(ROSTER_FRESH_MS);
  const before = calls.cloud.length;
  const asleep = await one.view("computer");
  assert.equal(calls.cloud.length, before);
  assert.equal(asleep.other.state, "asleep");
  assert.deepEqual(asleep.other.bots.map((entry) => entry.id), ["atlas"]);

  const going = harness({ cloudBody: () => new Response("", { status: 503, headers: { "x-omb-cloud-power": "asleep" } }) });
  const view = await going.one.view("computer");
  assert.equal(view.other.state, "asleep");
  assert.equal(going.power.held, 1);
});

test("a signed-out or unreachable Cloud keeps the bots it had, with the Admin's reason", async () => {
  let answer = json({ bots: [bot("atlas")], groups: [], sections: [] });
  const { one, tick } = harness({ cloudBody: () => answer, reason: "The server My Cloud runs on is being restarted." });
  await one.view("computer");
  answer = new Response("", { status: 401 });
  tick(ROSTER_FRESH_MS);
  const signedOut = await one.view("computer");
  assert.equal(signedOut.other.state, "signed-out");
  assert.deepEqual(signedOut.other.bots.map((entry) => entry.id), ["atlas"]);
  answer = Promise.reject(new Error("ECONNRESET"));
  tick(ROSTER_FRESH_MS);
  const unreachable = await one.view("computer");
  assert.equal(unreachable.other.state, "unreachable");
  assert.equal(unreachable.other.reason, "The server My Cloud runs on is being restarted.");
  assert.deepEqual(unreachable.other.bots.map((entry) => entry.id), ["atlas"]);
});

test("My Cloud's last roster is saved for its origin without pictures, so an asleep Cloud's bots are there at launch", async () => {
  const store = memoryStore();
  const first = harness({ store, cloudBody: (route) => route.startsWith("/api/attachments/")
    ? new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "3" } })
    : { bots: [bot("atlas", { avatarUrl: "/api/attachments/a.png", section: "Ops" })], groups: [], sections: ["Ops"] } });
  const seen = await first.one.view("computer");
  assert.equal(seen.other.bots[0].avatarUrl, "data:image/png;base64,AQID");
  assert.equal(store.value.cloud.origin, CLOUD);
  assert.equal(store.value.cloud.roster.bots[0].avatarUrl, null);

  const later = harness({ store });
  later.power.asleepNow = true;
  const launch = await later.one.view("computer");
  assert.equal(launch.other.state, "asleep");
  assert.deepEqual(launch.other.bots.map((entry) => [entry.id, entry.section, entry.avatarUrl]), [["atlas", "Ops", null]]);
  assert.deepEqual(later.calls.cloud, []);
  assert.deepEqual(later.one.peek("computer").other.bots.map((entry) => entry.id), ["atlas"]);

  const otherCloud = harness({ store: memoryStore({ cloud: { origin: "https://omb-u-2.fly.dev", roster: store.value.cloud.roster } }) });
  otherCloud.power.asleepNow = true;
  assert.deepEqual((await otherCloud.one.view("computer")).other.bots, []);
});

test("a picture is inlined once, and only an image small enough", async () => {
  const big = new Uint8Array(PICTURE_MAX_BYTES + 1);
  const answers = {
    "/api/attachments/ok.png": () => new Response(new Uint8Array([9]), { headers: { "content-type": "image/png" } }),
    "/api/attachments/big.png": () => new Response(big, { headers: { "content-type": "image/png" } }),
    "/api/attachments/page.html": () => new Response("<script>", { headers: { "content-type": "text/html" } }),
  };
  const { one, calls, tick } = harness({ cloudBody: (route) => answers[route]?.() ?? {
    bots: [bot("a", { avatarUrl: "/api/attachments/ok.png" }), bot("b", { avatarUrl: "/api/attachments/big.png" }), bot("c", { avatarUrl: "/api/attachments/page.html" }), bot("d", { avatarUrl: "https://elsewhere.test/x.png" })],
    groups: [], sections: [] } });
  const view = await one.view("computer");
  assert.deepEqual(view.other.bots.map((entry) => entry.avatarUrl), ["data:image/png;base64,CQ==", null, null, null]);
  tick(ROSTER_FRESH_MS);
  await one.view("computer");
  assert.equal(calls.cloud.filter((route) => route === "/api/attachments/ok.png").length, 1);
  assert.equal(calls.cloud.filter((route) => route === "/api/attachments/page.html").length, 1);
  assert.equal(calls.cloud.some((route) => route.startsWith("https:")), false);
});

test("a first read that takes long gives the page what main holds, then announces the answer", async () => {
  let release;
  let changes = 0;
  const { one } = harness({ cloudBody: (route) => route.startsWith("/api/bots")
    ? new Promise((resolve) => { release = () => resolve({ bots: [bot("atlas")], groups: [], sections: [] }); }) : { routines: [], webhooks: [] }, onChange: () => changes++ });
  const early = await one.view("computer");
  assert.equal(early.other.state, "unreachable");
  assert.deepEqual(early.other.bots, []);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(changes, 1);
  assert.deepEqual(one.peek("computer").other.bots.map((entry) => entry.id), ["atlas"]);
});

test("opening goes only to the other side, only for a bot or room main read there, and its link is taken once by that side's page", async () => {
  const { one, tick } = harness({ cloudBody: { bots: [bot("atlas")], groups: [{ id: "launch-room", name: "Launch", memberIds: [] }], sections: [] } });
  await one.view("computer");
  assert.throws(() => one.open("computer", { side: "computer", id: "ember" }), /Choose a bot or room/);
  assert.throws(() => one.open("computer", { side: "cloud", id: "nobody" }), /no longer on My Cloud/);
  assert.throws(() => one.open("computer", { side: "cloud", id: "../../etc" }), /Choose a bot or room/);
  assert.throws(() => one.open("computer", "atlas"), /Choose a bot or room/);
  assert.deepEqual(one.open("computer", { side: "cloud", id: "atlas" }), { side: "cloud" });
  assert.equal(one.take("computer"), null);
  assert.equal(one.take("cloud"), "openmausbot://bot/atlas");
  assert.equal(one.take("cloud"), null);
  one.open("computer", { side: "cloud", id: "launch-room" });
  tick(OPEN_FOR_MS + 1);
  assert.equal(one.take("cloud"), null);
});

test("an asleep Cloud's saved bots can still be opened, which is what wakes it", async () => {
  const store = memoryStore({ cloud: { origin: CLOUD, roster: { at: 1, bots: [bot("atlas")], rooms: [], sections: [] } } });
  const { one } = harness({ store });
  one.power = undefined;
  assert.deepEqual(one.open("computer", { side: "cloud", id: "atlas" }), { side: "cloud" });
});

test("the switcher offers one entry for both and the setting while this computer has My Cloud", () => {
  const { one } = harness({ cloudName: "Amit's Cloud" });
  const entry = { id: "c1", name: "Amit's Cloud", origin: CLOUD };
  let toggled = 0;
  const menu = oneWorkspaceMenu(one, entry, () => toggled++);
  assert.deepEqual({ ...menu.together, onToggle: undefined }, { cloudId: "c1", label: "All bots", detail: "This computer and Amit's Cloud", on: true, onToggle: undefined });
  menu.together.onToggle();
  assert.equal(toggled, 1);
  one.setTogether(false);
  assert.equal(oneWorkspaceMenu(one, entry, () => {}).together.on, false);
  assert.deepEqual(oneWorkspaceMenu(one, null, () => {}), {});
  assert.deepEqual(oneWorkspaceMenu(harness({ noCloud: true }).one, entry, () => {}), {});
});

function installed(overrides = {}) {
  const fileOptions = overrides.file ? { file: overrides.file } : {
    file: () => "/nonexistent/one-workspace.json",
    files: { readFileSync: () => { throw new Error("none"); }, writeFileSync: () => {}, renameSync: () => {}, rmSync: () => {} },
  };
  const handlers = new Map();
  const sent = [];
  const went = [];
  const fetches = [];
  let signedIn = overrides.signedIn ?? true;
  const win = { isDestroyed: () => false, webContents: { mainFrame: { url: overrides.url ?? "http://127.0.0.1:8799/" }, send: (channel, value) => sent.push([channel, value]) } };
  const api = installOneWorkspace({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    page: (event) => event?.page ?? null,
    window: () => win,
    localOrigin: () => "http://127.0.0.1:8799",
    ...fileOptions,
    cloud: () => ({ origin: CLOUD, name: "My Cloud" }),
    cookieFetch: async (url, init) => {
      fetches.push([url, init]);
      if (!signedIn) return new Response("", { status: 401 });
      return json({ bots: [bot("atlas")], groups: [], sections: [] });
    },
    reconnect: async (origin) => { assert.equal(origin, CLOUD); signedIn = true; return overrides.reconnects ?? true; },
    power: { asleep: () => false },
    local: async () => json({ bots: [bot("ember")], groups: [], sections: [] }),
    localDefault: () => true,
    twinHome: () => "computer",
    goCloud: async () => { went.push("cloud"); if (overrides.goCloudFails) throw new Error("My Cloud is not ready to connect yet."); },
    goLocal: async () => { went.push("local"); },
  });
  const call = (channel, page, ...args) => Promise.resolve().then(() => handlers.get(channel)({ page }, ...args));
  return { api, call, sent, went, fetches };
}

test("main's handlers answer only this computer's page and the verified My Cloud page", async () => {
  const { call } = installed();
  await assert.rejects(call("one-workspace:view", null), /only available in this app's window/);
  await assert.rejects(call("one-workspace:open", "server", { side: "cloud", id: "atlas" }), /only available/);
  assert.equal((await call("one-workspace:view", "local")).other.side, "cloud");
  assert.equal((await call("one-workspace:view", "cloud")).other.side, "computer");
});

test("My Cloud is read with the window's own sign-in, in the background, and signed in again once after a 401", async () => {
  const { call, fetches } = installed({ signedIn: false });
  const view = await call("one-workspace:view", "local");
  assert.equal(view.other.state, "ready");
  assert.equal(fetches.filter(([url]) => url === `${CLOUD}/api/bots?messages=0`).length, 2);
  const [url, init] = fetches[0];
  assert.equal(url, `${CLOUD}/api/bots?messages=0`);
  assert.equal(init.credentials, "include");
  assert.equal(init.redirect, "error");
  assert.equal(init.headers["x-omb-background"], "1");
  assert.equal(init.headers.authorization, undefined);
});

test("opening a Cloud bot moves the window to My Cloud, and a failed move leaves nothing waiting", async () => {
  const ok = installed();
  await ok.call("one-workspace:view", "local");
  await ok.call("one-workspace:open", "local", { side: "cloud", id: "atlas" });
  assert.deepEqual(ok.went, ["cloud"]);
  assert.equal(await ok.call("one-workspace:take", "cloud"), "openmausbot://bot/atlas");

  const back = installed({ url: `${CLOUD}/` });
  await back.call("one-workspace:view", "cloud");
  await back.call("one-workspace:open", "cloud", { side: "computer", id: "ember" });
  assert.deepEqual(back.went, ["local"]);
  assert.equal(await back.call("one-workspace:take", "local"), "openmausbot://bot/ember");

  const failing = installed({ goCloudFails: true });
  await failing.call("one-workspace:view", "local");
  await assert.rejects(failing.call("one-workspace:open", "local", { side: "cloud", id: "atlas" }), /not ready/);
  assert.equal(await failing.call("one-workspace:take", "cloud"), null);
});

test("the setting changes from the menu and tells the page showing, which then shows them apart", async () => {
  const { api, sent } = installed();
  api.menu({ id: "c1", name: "My Cloud", origin: CLOUD }).together.onToggle();
  assert.deepEqual(sent.at(-1), ["one-workspace:view", null]);
  api.menu({ id: "c1", name: "My Cloud", origin: CLOUD }).together.onToggle();
  assert.equal(sent.at(-1)[1].page, "computer");
});

test("the setting and My Cloud's last roster are kept in the app's own file, read only when first needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-one-"));
  let asked = 0;
  const file = () => { asked++; return join(dir, "one-workspace.json"); };
  try {
    const first = installed({ file });
    assert.equal(asked, 0);
    await first.call("one-workspace:view", "local");
    first.api.menu({ id: "c1", name: "My Cloud", origin: CLOUD }).together.onToggle();
    const saved = JSON.parse(readFileSync(join(dir, "one-workspace.json"), "utf8"));
    assert.equal(saved.together, false);
    assert.deepEqual(saved.cloud.roster.bots.map((bot) => bot.id), ["atlas"]);
    assert.equal(JSON.stringify(saved).includes("secret instructions"), false);
    const again = installed({ file });
    assert.equal(again.api.menu({ id: "c1", name: "My Cloud", origin: CLOUD }).together.on, false);
    assert.equal(await again.call("one-workspace:view", "local"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a picture whose read failed is tried again on the next roster, not dropped for the session", async () => {
  let failing = true;
  const { one, calls, tick } = harness({ cloudBody: (route) => route === "/api/attachments/a.png"
    ? (failing ? Promise.reject(new Error("ECONNRESET")) : new Response(new Uint8Array([7]), { headers: { "content-type": "image/png" } }))
    : { bots: [bot("atlas", { avatarUrl: "/api/attachments/a.png" })], groups: [], sections: [] } });
  assert.equal((await one.view("computer")).other.bots[0].avatarUrl, null);
  failing = false;
  tick(ROSTER_FRESH_MS);
  assert.equal((await one.view("computer")).other.bots[0].avatarUrl, "data:image/png;base64,Bw==");
  assert.equal(calls.cloud.filter((route) => route === "/api/attachments/a.png").length, 2);
});

test("each bot carries how many routines and webhooks it has switched on, read at most once a minute", async () => {
  const routes = { routines: `/api/routines?from=${Number.MAX_SAFE_INTEGER}`, webhooks: "/api/webhooks" };
  let routines = [{ botId: "atlas", enabled: true, prompt: "secret prompt" }, { botId: "atlas", enabled: false }, { botId: "kit", enabled: true }];
  const { one, calls, tick } = harness({ cloudBody: (route) => route === routes.routines ? { routines, runs: [] }
    : route === routes.webhooks ? { webhooks: [{ botId: "atlas", enabled: true }], attempts: [] }
    : { bots: [bot("atlas"), bot("kit"), bot("juno")], groups: [], sections: [] } });
  const view = await one.view("computer");
  assert.deepEqual(view.other.bots.map((entry) => [entry.id, entry.automations]), [["atlas", 2], ["kit", 1], ["juno", undefined]]);
  assert.equal(JSON.stringify(view).includes("secret prompt"), false);
  routines = [];
  tick(ROSTER_FRESH_MS);
  await one.view("computer");
  assert.equal(calls.cloud.filter((route) => route === routes.routines).length, 1);
  tick(AUTOMATIONS_FRESH_MS);
  assert.deepEqual((await one.view("computer")).other.bots.map((entry) => entry.automations), [1, undefined, undefined]);
  assert.deepEqual([...automationCounts({ routines: [{ botId: "../x", enabled: true }, "nope"] }, null)], []);
});

test("opening the other copy's own conversation hands that side's page the conversation, never one main did not read", async () => {
  const { one } = harness({ cloudBody: { bots: [bot("ember", { tasks: [{ threadId: "phone-1" }, { threadId: "t-ember" }] })], groups: [], sections: [] } });
  await one.view("computer");
  one.open("computer", { side: "cloud", id: "ember", threadId: "phone-1" });
  assert.equal(one.take("cloud"), "openmausbot://thread/phone-1?bot=ember");
  one.open("computer", { side: "cloud", id: "ember", threadId: "somebody-elses" });
  assert.equal(one.take("cloud"), "openmausbot://bot/ember");
});

test("a message My Cloud has after this computer's newest in a conversation both have is counted, read only when that conversation's times differ", async () => {
  const thread = (id) => `/api/threads/${id}/messages?limit=200`;
  const message = (id, at, kind = "text") => ({ id, at, kind, role: "user" });
  let cloudAt = 20, cloudMessages = [message("m1", 1), message("m2", 2), message("phone", 3), message("reply", 4), message("card", 5, "options")];
  const computerMessages = [message("m1", 1), message("m2", 2)];
  const routes = [];
  const scout = (at) => ({ id: "scout", threadId: "t", name: "Scout", title: "", color: "blue", unread: false, avatarUrl: null, tasks: [{ threadId: "t", updatedAt: at }, { threadId: "same", updatedAt: 7 }] });
  const { one, tick } = harness({
    cloudBody: (route) => { routes.push(`cloud ${route}`); return route === thread("t") ? { messages: cloudMessages } : route.startsWith("/api/bots") ? { bots: [scout(cloudAt)], groups: [], sections: [] } : { routines: [], webhooks: [] }; },
    localBody: (route) => { routes.push(`local ${route}`); return route === thread("t") ? { messages: computerMessages } : route.startsWith("/api/bots") ? { bots: [scout(10)], groups: [], sections: [] } : { routines: [], webhooks: [] }; },
  });
  await one.view("computer");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(one.peek("computer").newer, { scout: [{ threadId: "t", cloud: 2, computer: 0 }] });
  assert.equal(routes.filter((route) => route.includes("/api/threads/same/")).length, 0);
  tick(ROSTER_FRESH_MS);
  await one.view("computer");
  assert.equal(routes.filter((route) => route.includes(thread("t"))).length, 2);
  // Once this computer has the same newest message, nothing is newer.
  cloudAt = 10;
  cloudMessages = computerMessages;
  tick(ROSTER_FRESH_MS);
  await one.view("computer");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(one.peek("computer").newer, undefined);
});

test("two copies of a conversation are compared by the newest message each has; without one in common, by time", () => {
  const m = (id, at) => ({ id, at });
  assert.deepEqual(aheadCounts([m("a", 1), m("b", 2), m("c", 3)], [m("a", 1), m("b", 2)]), { cloud: 1, computer: 0 });
  assert.deepEqual(aheadCounts([m("a", 1)], [m("a", 1), m("x", 5)]), { cloud: 0, computer: 1 });
  assert.deepEqual(aheadCounts([m("p", 9), m("q", 10)], [m("x", 5)]), { cloud: 2, computer: 0 });
  assert.deepEqual(aheadCounts([], []), { cloud: 0, computer: 0 });
});
