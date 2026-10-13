import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("defaults new Codex bots and tasks to Full access without changing explicit or saved permissions", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const before = (await api("GET", "/api/bots")).bots;
    const instances = (await api("GET", "/api/instances")).instances;
    const codex = instances.find((instance: any) => instance.instanceId === "codex");
    const claude = instances.find((instance: any) => instance.instanceId === "claude");
    const modelSelection = { instanceId: "codex", model: codex.models.default };
    await api("PATCH", "/api/config", { defaultModelSelection: modelSelection });
    const defaults = await api("GET", "/api/bot-defaults");
    expect(defaults.allowsFullAccessDefault).toBe(true);
    expect(defaults.defaults.profile.approvalMode).toBeUndefined();
    expect(defaults.modelSelection).toMatchObject(modelSelection);
    const full = (await api("POST", "/api/bots", { name: "Codex default" }, 201)).bot;
    expect(full).toMatchObject({ modelSelection, approvalMode: "full", autoApprove: false });
    expect(full.tasks[0].approvalMode).toBe("full");
    expect((await api("POST", `/api/bots/${full.id}/tasks`, {}, 201)).task.approvalMode).toBe("full");
    for (const approvalMode of ["ask", "auto"]) {
      const explicit = (await api("POST", "/api/bots", { name: `Explicit ${approvalMode}`, settings: { approvalMode } }, 201)).bot;
      expect(explicit.approvalMode).toBe(approvalMode);
      expect(explicit.tasks[0].approvalMode).toBe(approvalMode);
      expect((await api("POST", `/api/bots/${explicit.id}/tasks`, {}, 201)).task.approvalMode).toBe(approvalMode);
    }
    const other = (await api("POST", "/api/bots", {
      name: "Claude unchanged", modelSelection: { instanceId: "claude", model: claude.models.default },
    }, 201)).bot;
    expect(other.approvalMode).toBe("ask");
    expect(other.tasks[0].approvalMode).toBe("ask");
    const pairing = await api("POST", "/api/auth/pairing", { label: "Fixture member", scopes: ["client"] });
    const member = (await api("POST", "/api/auth/pair", { code: pairing.code })).token;
    await api("GET", "/api/bot-defaults", undefined, 403, member);
    const count = (await api("GET", "/api/bots")).bots.length;
    await api("POST", "/api/bots", { name: "Member cannot create unrestricted bot" }, 403, member);
    await api("POST", "/api/bots", { name: "Member cannot grant Full", settings: { approvalMode: "full" } }, 403, member);
    expect((await api("GET", "/api/bots")).bots).toHaveLength(count);
    await api("PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "ask" } } });
    const savedAsk = (await api("POST", "/api/bots", { name: "Saved Ask default" }, 201)).bot;
    expect(savedAsk.approvalMode).toBe("ask");
    expect(savedAsk.tasks[0].approvalMode).toBe("ask");
    expect((await api("GET", "/api/bot-defaults")).defaults.profile.approvalMode).toBe("ask");
    const after = (await api("GET", "/api/bots")).bots;
    for (const bot of before) expect(after.find((entry: any) => entry.id === bot.id)).toEqual(bot);
    console.info(JSON.stringify({ url: fixture.info.url, logPath: fixture.info.logPath, fullBotId: full.id }));
  } finally { await fixture.close(); }
}, 90_000);

it("applies independent creation templates through the real isolated HTTP routes", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json() as any;
    expect(response.status, JSON.stringify(data)).toBe(status);
    return data;
  };
  try {
    const original = (await api("GET", "/api/bots")).bots;
    const skill = { name: "fixture-skill", description: "Synthetic", source: "fixture", enabled: false,
      warnings: [], text: "---\nname: fixture-skill\ndescription: Synthetic\n---\nFixture instructions." };
    const defaults = {
      profile: { name: "", title: "Template", description: "Description", soul: "Standing instructions",
        notifications: false, computer: "off", approvalMode: "ask", mascotExpression: null },
      memory: { "MEMORY.md": "Synthetic default memory" }, skills: [skill],
      routines: [{ name: "Review", prompt: "Review status", enabled: false,
        schedule: { type: "daily", time: "09:00", weekdays: [1] } }],
    };
    await api("PATCH", "/api/config", { newBotDefaults: defaults });
    expect((await api("GET", "/api/bots")).bots).toEqual(original);
    expect((await api("GET", "/api/bot-defaults")).defaults).toEqual(defaults);
    const first = (await api("POST", "/api/bots", {}, 201)).bot;
    const second = (await api("POST", "/api/bots", { name: "Second" }, 201)).bot;
    expect(first.name.length).toBeGreaterThan(0);
    for (const bot of [first, second]) {
      expect(bot).toMatchObject({ title: "Template", soul: "Standing instructions", notifications: false, computer: "off" });
      const memory = await api("GET", `/api/bots/${bot.id}/memory/file?path=MEMORY.md`);
      expect(JSON.stringify(memory)).toContain("Synthetic default memory");
      expect((await api("GET", `/api/bots/${bot.id}/skills`)).skills).toHaveLength(1);
    }
    const routines = (await api("GET", "/api/routines")).routines;
    expect(routines.filter((routine: any) => [first.id, second.id].includes(routine.botId))).toHaveLength(2);
    expect(routines.every((routine: any) => !routine.enabled)).toBe(true);
    const explicit = (await api("POST", "/api/bots", { title: "", settings: { description: "", computer: null, notifications: true } }, 201)).bot;
    expect(explicit).toMatchObject({ title: "", description: "", notifications: true });
    expect(explicit.computer ?? null).toBe(null);
    const optOut = (await api("POST", "/api/bots", { useDefaults: false, name: "Resolved draft" }, 201)).bot;
    expect(optOut.title).toBe("");
    expect((await api("GET", `/api/bots/${optOut.id}/skills`)).skills).toHaveLength(0);
    const restricted = (await api("POST", "/api/bots", { useDefaults: false, name: "Restricted draft", visibility: "admins" }, 201)).bot;
    expect(restricted.visibility).toBe("admins");
    const beforeInvalid = (await api("GET", "/api/bots")).bots.length;
    await api("POST", "/api/bots", { name: "Invalid audience", visibility: { people: 42 } }, 400);
    expect((await api("GET", "/api/bots")).bots.length).toBe(beforeInvalid);
    await api("POST", "/api/bots", { useDefaults: "false" }, 400);
    await api("POST", "/api/bots", { name: 42 }, 400);
    await api("POST", "/api/bots", { settings: null }, 400);
    await api("POST", "/api/bots", { settings: { approvalMode: "unknown" } }, 400);
    const blank = (await api("POST", "/api/bots", { name: "", section: null }, 201)).bot;
    expect(blank.name).not.toBe("");
    expect(blank.section ?? "").toBe("");
    for (const body of [null, [], {}, { source: 42 }, { source: "x".repeat(2001) }]) {
      await api("POST", "/api/bot-defaults/skills/preview", body, 400);
      await api("POST", `/api/bots/${first.id}/skill-template`, body, 400);
    }
    for (const body of [null, [], {}, { profile: {}, prompt: 42 }]) {
      await api("POST", "/api/bot-defaults/avatar", body, 400);
    }
    await api("PATCH", "/api/config", { browserProfiles: [{ id: "fixture-profile", name: "Fixture profile" }] });
    await api("PATCH", "/api/config", { newBotDefaults: { profile: { browserProfile: "fixture-profile" } } });
    await api("PATCH", "/api/config", { browserProfiles: [] });
    expect((await api("GET", "/api/bot-defaults")).defaults.profile.browserProfile).toBeUndefined();
    expect((await api("POST", "/api/bots", { name: "After profile removal" }, 201)).bot.browserProfile).toBeUndefined();
    // A saved Full default creates bots at Full, with no other step (#2701).
    await api("PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "full" } } });
    expect((await api("POST", "/api/bots", {}, 201)).bot.approvalMode).toBe("full");
    // Custom still belongs to the desktop app: a Custom default is refused here.
    await api("PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "custom" } } });
    const count = (await api("GET", "/api/bots")).bots.length;
    await api("POST", "/api/bots", {}, 403);
    expect((await api("GET", "/api/bots")).bots).toHaveLength(count);
    expect((await api("POST", "/api/bots", { settings: { approvalMode: "ask" } }, 201)).bot.approvalMode).toBe("ask");
  } finally { await fixture.close(); }
}, 90_000);
