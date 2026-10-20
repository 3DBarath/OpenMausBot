import { describe, expect, it } from "vitest";
import type { OneWorkspaceView, RosterBot, RosterRoom, SideRoster } from "../../shared/one-workspace";
import { mergeWorkspace, otherSideIn, otherSideNeeds, searchMerged } from "./one-workspace";
import { BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, CHANNELS_SECTION_ID, PINNED_SECTION_ID, userSectionId } from "./sidebar-layout";

const rosterBot = (id: string, extra: Partial<RosterBot> = {}): RosterBot => ({ id, threadId: `t-${id}`, name: id[0]!.toUpperCase() + id.slice(1), title: "", color: "blue", avatarUrl: null, unread: false, ...extra });
const room = (id: string, extra: Partial<RosterRoom> = {}): RosterRoom => ({ id, name: id, memberIds: [], unread: false, ...extra });
const view = (other: Partial<SideRoster> = {}, extra: Partial<OneWorkspaceView> = {}): OneWorkspaceView => ({
  page: "computer", twinHome: "computer", cloudName: "My Cloud",
  other: { side: "cloud", state: "ready", at: 1, bots: [], rooms: [], sections: [], ...other }, ...extra,
});
const here = (bots: Array<{ id: string; hidden?: boolean; section?: string }>, groups: Array<{ id: string; dm?: boolean; section?: string }> = [], extra: { sections?: string[]; selectedId?: string } = {}) =>
  ({ bots, groups, ...extra });
const ids = (items: ReadonlyArray<{ id: string }>) => items.map((item) => item.id);

describe("one workspace: every bot and room shows once", () => {
  it("shows this page's bots and the other side's, each with its home", () => {
    const merged = mergeWorkspace(view({ bots: [rosterBot("atlas")], rooms: [room("launch")] }), here([{ id: "ember" }], [{ id: "standup" }]));
    expect(ids(merged.bots)).toEqual(["atlas"]);
    expect(ids(merged.rooms)).toEqual(["launch"]);
    expect([...merged.hidden]).toEqual([]);
    expect(Object.fromEntries(merged.homes)).toEqual({
      atlas: { side: "cloud", twin: false }, launch: { side: "cloud", twin: false },
      ember: { side: "computer", twin: false }, standup: { side: "computer", twin: false },
    });
  });

  it("a bot sent to My Cloud (the same id on both sides) shows once, as this computer's copy by default", () => {
    const merged = mergeWorkspace(view({ bots: [rosterBot("ember"), rosterBot("atlas")] }), here([{ id: "ember" }]));
    expect(ids(merged.bots)).toEqual(["atlas"]);
    expect(merged.hidden.has("ember")).toBe(false);
    expect(merged.homes.get("ember")).toEqual({ side: "computer", twin: true });
  });

  it("after the bots moved to My Cloud, a bot on both sides shows as its Cloud copy", () => {
    const merged = mergeWorkspace(view({ bots: [rosterBot("ember")] }, { twinHome: "cloud" }), here([{ id: "ember" }, { id: "juno" }]));
    expect(ids(merged.bots)).toEqual(["ember"]);
    expect([...merged.hidden]).toEqual(["ember"]);
    expect(merged.homes.get("ember")).toEqual({ side: "cloud", twin: true });
    expect(merged.homes.get("juno")).toEqual({ side: "computer", twin: false });
  });

  it("the copy open in this window keeps its row, so the chat you are in never disappears or doubles", () => {
    const merged = mergeWorkspace(view({ bots: [rosterBot("ember")] }, { twinHome: "cloud" }), here([{ id: "ember" }], [], { selectedId: "ember" }));
    expect(ids(merged.bots)).toEqual([]);
    expect(merged.hidden.size).toBe(0);
    expect(merged.homes.get("ember")).toEqual({ side: "computer", twin: true });
  });

  it("an archived bot here is no twin: the other side's copy shows", () => {
    const merged = mergeWorkspace(view({ bots: [rosterBot("ember")] }), here([{ id: "ember", hidden: true }]));
    expect(ids(merged.bots)).toEqual(["ember"]);
    expect(merged.homes.get("ember")).toEqual({ side: "cloud", twin: false });
  });

  it("on My Cloud's page the same rule holds from the other side", () => {
    const fromCloud = view({ side: "computer", bots: [rosterBot("ember"), rosterBot("kit")] }, { page: "cloud", twinHome: "computer" });
    const merged = mergeWorkspace(fromCloud, here([{ id: "ember" }, { id: "atlas" }]));
    expect(merged.other).toBe("computer");
    expect(ids(merged.bots)).toEqual(["ember", "kit"]);
    expect([...merged.hidden]).toEqual(["ember"]);
    expect(merged.homes.get("atlas")).toEqual({ side: "cloud", twin: false });
    expect(merged.homes.get("ember")).toEqual({ side: "computer", twin: true });
  });

  it("rooms follow the same rule; a chat between two bots here never counts as a room", () => {
    const merged = mergeWorkspace(view({ rooms: [room("launch"), room("pair")] }, { twinHome: "cloud" }), here([], [{ id: "launch" }, { id: "pair", dm: true }]));
    expect(ids(merged.rooms)).toEqual(["launch", "pair"]);
    expect([...merged.hidden]).toEqual(["launch"]);
  });
});

describe("one workspace: teams and sections", () => {
  const merged = mergeWorkspace(view({
    bots: [rosterBot("atlas", { section: "Ops" }), rosterBot("boss", { section: "Ops", chiefOfStaff: true }), rosterBot("kit", { section: "Research" }), rosterBot("nova")],
    rooms: [room("launch", { section: "Ops" }), room("lobby")],
    sections: ["Empty there", "Research", "Ops"],
  }), here([{ id: "ember", section: "Research" }], [], { sections: ["Research"] }));

  it("adds only the teams this page lacks, in the other side's order, and never an empty one", () => {
    expect(merged.sections).toEqual(["Ops"]);
  });

  it("puts each row in its team by name, chiefs first; unteamed bots in Bots and rooms in Channels", () => {
    expect(ids(otherSideIn(merged, userSectionId("Ops")).bots)).toEqual(["boss", "atlas"]);
    expect(ids(otherSideIn(merged, userSectionId("Ops")).rooms)).toEqual(["launch"]);
    expect(ids(otherSideIn(merged, userSectionId("Research")).bots)).toEqual(["kit"]);
    expect(ids(otherSideIn(merged, BOTS_SECTION_ID).bots)).toEqual(["nova"]);
    expect(ids(otherSideIn(merged, CHANNELS_SECTION_ID).rooms)).toEqual(["lobby"]);
    for (const id of [PINNED_SECTION_ID, BOT_CHATS_SECTION_ID]) expect(otherSideIn(merged, id)).toEqual({ bots: [], rooms: [] });
    expect(otherSideIn(null, BOTS_SECTION_ID)).toEqual({ bots: [], rooms: [] });
    expect(otherSideNeeds(merged)).toEqual({ bots: true, channels: true });
    expect(otherSideNeeds(null)).toEqual({ bots: false, channels: false });
  });

  it("lists the teams in the same order on both pages: this computer's, then My Cloud's own", () => {
    const computer = { sections: ["Research", "Home"], bots: [{ id: "ember", section: "Research" }] };
    const cloud = { sections: ["Ops", "Research"], bots: [rosterBot("atlas", { section: "Ops" }), rosterBot("kit", { section: "Research" })] };
    const fromComputer = mergeWorkspace(view({ bots: cloud.bots, sections: cloud.sections }), here(computer.bots, [], { sections: computer.sections }));
    const fromCloud = mergeWorkspace(view({ side: "computer", bots: [rosterBot("ember", { section: "Research" })], sections: computer.sections }, { page: "cloud" }),
      here([{ id: "atlas", section: "Ops" }, { id: "kit", section: "Research" }], [], { sections: cloud.sections }));
    expect(fromComputer.teams).toEqual(["Research", "Home", "Ops"]);
    expect(fromCloud.teams).toEqual(["Research", "Ops"]);
  });

  it("search keeps the other side's rows whose name matches, and the teams they sit in", () => {
    const found = searchMerged(merged, "atl")!;
    expect(ids(found.bots)).toEqual(["atlas"]);
    expect(found.rooms).toEqual([]);
    expect(found.sections).toEqual(["Ops"]);
    expect(otherSideNeeds(found)).toEqual({ bots: false, channels: false });
    expect(searchMerged(merged, "  ")).toBe(merged);
    expect(searchMerged(null, "x")).toBeNull();
  });
});

describe("one workspace: an asleep or unreachable side", () => {
  it("carries the other side's state and the Admin's reason; its rows stay", () => {
    const asleep = mergeWorkspace(view({ state: "asleep", bots: [rosterBot("atlas")] }), here([]));
    expect([asleep.state, ids(asleep.bots)]).toEqual(["asleep", ["atlas"]]);
    const unreachable = mergeWorkspace(view({ state: "unreachable", reason: "Restarting.", bots: [rosterBot("atlas")] }), here([]));
    expect([unreachable.state, unreachable.reason, ids(unreachable.bots)]).toEqual(["unreachable", "Restarting.", ["atlas"]]);
  });
});
