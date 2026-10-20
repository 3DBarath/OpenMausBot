import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { OneWorkspaceView, RosterBot, SideRoster } from "../../shared/one-workspace";
import { mergeWorkspace, setOneWorkspaceForTests } from "@/lib/one-workspace";
import { BOTS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { ElsewhereCard, elsewhereOnMap, OneWorkspaceStatus, OtherSideRows, OwnHomeBadge, ownSectionName } from "./OneWorkspace";

const bot = (id: string, extra: Partial<RosterBot> = {}): RosterBot => ({ id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), title: "", color: "blue", avatarUrl: null, unread: false, ...extra });
const view = (other: Partial<SideRoster> = {}, extra: Partial<OneWorkspaceView> = {}): OneWorkspaceView => ({
  page: "computer", twinHome: "computer", cloudName: "My Cloud", other: { side: "cloud", state: "ready", at: 1, bots: [], rooms: [], sections: [], ...other }, ...extra,
});
const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

afterEach(() => setOneWorkspaceForTests(null));

describe("the other side's rows in the sidebar", () => {
  it("open there, carry their home, and show unread and work only while that side answers", () => {
    const ready = mergeWorkspace(view({ bots: [bot("atlas", { unread: true, title: "Inbox" }), bot("kit", { section: "Ops", busy: true })] }), { bots: [], groups: [] });
    const html = render(createElement(OtherSideRows, { merged: ready, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }));
    expect(html).toContain('data-other-side-bot="atlas"');
    expect(html).toContain('data-home="cloud"');
    expect(html).toContain('aria-label="Open Atlas on My Cloud · On My Cloud · Unread"');
    expect(html).toContain("Inbox");
    expect(html).toContain('data-home-badge="cloud"');
    expect(html).not.toContain("kit");
    expect(render(createElement(OtherSideRows, { merged: ready, sectionId: userSectionId("Ops"), density: "comfortable", place: "after" }))).toContain('data-other-side-bot="kit"');

    const asleep = mergeWorkspace(view({ state: "asleep", bots: [bot("atlas", { unread: true })] }), { bots: [], groups: [] });
    const sleeping = render(createElement(OtherSideRows, { merged: asleep, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }));
    expect(sleeping).toContain('data-other-side-bot="atlas"');
    expect(sleeping).toContain("Asleep · opening wakes it");
    expect(sleeping).not.toContain("Unread");
    expect(sleeping).not.toContain("bg-accent");
  });

  it("say on My Cloud's page that they open on this computer", () => {
    const merged = mergeWorkspace(view({ side: "computer", bots: [bot("ember")] }, { page: "cloud" }), { bots: [], groups: [] });
    const html = render(createElement(OtherSideRows, { merged, sectionId: BOTS_SECTION_ID, density: "icons", place: "before" }));
    expect(html).toContain('aria-label="Open Ember on this computer · On this computer"');
    expect(html).toContain('data-home-badge="computer"');
  });

  it("render nothing while the two are shown apart", () => {
    expect(render(createElement(OtherSideRows, { merged: null, sectionId: BOTS_SECTION_ID, density: "comfortable", place: "after" }))).toBe("");
  });
});

describe("this page's own rows", () => {
  it("get a home badge only while the two show together, and say when the other side has a copy", () => {
    expect(render(createElement(OwnHomeBadge, { id: "ember" }))).toBe("");
    setOneWorkspaceForTests({ view: view({ bots: [bot("ember")] }) });
    expect(render(createElement(OwnHomeBadge, { id: "ember" }))).toContain('aria-label="On this computer · also on My Cloud"');
    expect(render(createElement(OwnHomeBadge, { id: "juno" }))).toContain('aria-label="On this computer"');
    setOneWorkspaceForTests({ view: view({ side: "computer" }, { page: "cloud", cloudName: "Amit's Cloud" }) });
    expect(render(createElement(OwnHomeBadge, { id: "atlas", inline: true }))).toContain("On Amit&#x27;s Cloud");
    expect(render(createElement(OwnHomeBadge, { id: "atlas" }))).toContain("-bottom-1");
    expect(render(createElement(OwnHomeBadge, { id: "atlas", corner: "top" }))).toContain("-top-1");
  });

  it("keep their team menu only for teams this page has", () => {
    const merged = mergeWorkspace(view({ bots: [bot("kit", { section: "Ops" })] }), { bots: [{ id: "ember", section: "Research" }], groups: [], sections: ["Research"] });
    const one = { merged, searched: merged, needs: { bots: false, channels: false } };
    expect(ownSectionName(one, userSectionId("Research"))).toBe("Research");
    expect(ownSectionName(one, userSectionId("Ops"))).toBeNull();
    expect(ownSectionName(null, userSectionId("Ops"))).toBe("Ops");
    expect(ownSectionName(one, BOTS_SECTION_ID)).toBeNull();
  });
});

describe("the status line", () => {
  it("says plainly when My Cloud sleeps, can't be reached or needs a sign-in, and nothing while it answers", () => {
    const merged = (other: Partial<SideRoster>, page: "computer" | "cloud" = "computer") => mergeWorkspace(view(other, { page }), { bots: [], groups: [] });
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({}), density: "comfortable" }))).toBe("");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "asleep" }), density: "comfortable" }))).toContain("My Cloud is asleep. Opening one of its bots wakes it.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "unreachable" }), density: "comfortable" }))).toContain("Can&#x27;t reach My Cloud right now.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "unreachable", reason: "The server My Cloud runs on is being restarted." }), density: "comfortable" }))).toContain("being restarted");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "signed-out" }), density: "comfortable" }))).toContain("needs you to sign in again");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ side: "computer", state: "unreachable" }, "cloud"), density: "comfortable" }))).toContain("This computer isn&#x27;t answering.");
    expect(render(createElement(OneWorkspaceStatus, { merged: merged({ state: "asleep" }), density: "icons" }))).toBe("");
  });

  it("shows an open on its way, and why one was refused", () => {
    const merged = mergeWorkspace(view({}), { bots: [], groups: [] });
    setOneWorkspaceForTests({ opening: { side: "cloud", id: "atlas" } });
    expect(render(createElement(OneWorkspaceStatus, { merged, density: "comfortable" }))).toContain("Opening on My Cloud…");
    setOneWorkspaceForTests({ error: "My Cloud is not ready to connect yet." });
    const refused = render(createElement(OneWorkspaceStatus, { merged, density: "comfortable" }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("My Cloud is not ready to connect yet.");
  });
});

describe("the other side on the Team map", () => {
  it("draws its bots as cards that open there, with their computers, and nothing stale while it sleeps", () => {
    const merged = mergeWorkspace(view({ bots: [bot("atlas", { computer: "cloud", busy: true, unread: true }), bot("kit", { computer: "local" }), bot("vm", { computer: "vm" })] }), { bots: [], groups: [] });
    const map = elsewhereOnMap(merged)!;
    expect([...map.ids]).toEqual(["atlas", "kit", "vm"]);
    expect(map.computers.map((computer) => [computer.id, computer.state, computer.frame])).toEqual([["atlas", "working", undefined], ["vm", "idle", undefined]]);
    const card = render(createElement(ElsewhereCard, { bot: map.bots[0]!, merged }));
    expect(card).toContain('data-elsewhere-card="atlas"');
    expect(card).toContain("Open Atlas on My Cloud");
    expect(card).not.toContain("data-bot-id");

    const asleep = elsewhereOnMap(mergeWorkspace(view({ state: "asleep", bots: [bot("atlas", { computer: "cloud", busy: true, unread: true })] }), { bots: [], groups: [] }))!;
    expect(asleep.computers[0]!.state).toBe("asleep");
    expect([asleep.bots[0]!.busy, asleep.bots[0]!.unread]).toEqual([false, false]);
    expect(render(createElement(ElsewhereCard, { bot: asleep.bots[0]!, merged: asleep.merged }))).toContain("Asleep · opening wakes it");
    expect(elsewhereOnMap(null)).toBeNull();
  });
});
