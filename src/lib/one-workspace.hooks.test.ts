import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));

import type { OneWorkspaceView } from "../../shared/one-workspace";
import { setOneWorkspaceForTests, useMergedWorkspace, useOwnHome } from "./one-workspace";

const view: OneWorkspaceView = { page: "computer", twinHome: "computer", cloudName: "My Cloud",
  other: { side: "cloud", state: "ready", at: 1, bots: [{ id: "ember", threadId: "t", name: "Ember", title: "", color: "blue", avatarUrl: null, unread: false }], rooms: [], sections: [] } };
const bots = [{ id: "ember" }];
const groups: never[] = [];

afterEach(() => setOneWorkspaceForTests(null));

describe("the merged view's hooks", () => {
  it("merge nothing until this page's own store has loaded, so a bot both sides have never flashes as its other copy", () => {
    setOneWorkspaceForTests({ view });
    expect(useMergedWorkspace({ hydrated: false, bots: [], groups })).toBeNull();
    const merged = useMergedWorkspace({ hydrated: true, bots, groups });
    expect(merged?.bots).toEqual([]);
    expect(merged?.homes.get("ember")).toEqual({ side: "computer", twin: true });
    expect(useMergedWorkspace({ hydrated: true, bots, groups })).toBe(merged);
  });

  it("give this page's rows their home only while the two show together", () => {
    expect(useOwnHome("ember")).toBeNull();
    setOneWorkspaceForTests({ view });
    expect(useOwnHome("ember")).toEqual({ side: "computer", twin: true });
    expect(useOwnHome("juno")).toEqual({ side: "computer", twin: false });
  });
});
