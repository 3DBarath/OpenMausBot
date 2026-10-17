import { describe, expect, it, vi } from "vitest";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import type { BotRecord } from "../store.ts";
import type { HandoffView } from "../coordinator.ts";
import { createDelegatedLevel } from "./delegated-level.ts";
import { createRoomApprovalModes } from "./room-approval.ts";

function fixture() {
  const chief = { id: "chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
  const member = { id: "member", approvalMode: "ask", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
  const root = { id: "root", rootId: "root", botId: chief.id, threadId: "source" } as HandoffView;
  const handoff = { id: "child", parentId: root.id, rootId: root.id, botId: member.id, threadId: "room", level: "full", mode: "work" } as HandoffView;
  const nodes = new Map([[root.id, root], [handoff.id, handoff]]);
  const delegatedLevel = vi.fn(createDelegatedLevel({ sourceApprovalMode: () => "full", driverKind: () => "claudeAgent" }));
  const modes = createRoomApprovalModes({ node: id => nodes.get(id), bot: id => id === chief.id ? chief : member,
    cloudGuestDriven: () => false,
    approvalModeForTurn: (bot, peerInitiated) => approvalModeForOrigin(approvalModeFor(bot), { peerInitiated }), delegatedLevel });
  return { chief, member, root, handoff, delegatedLevel, ...modes };
}

describe("room approval levels", () => {
  it("carries a Chief's level into the room hand-off", () => {
    const f = fixture();
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("full");
    expect(f.delegatedLevel).toHaveBeenCalledWith(f.chief, "source", f.member, "ask");
  });
  it("keeps a Custom recipient on its peer Auto projection instead of raising it to Full", () => {
    const f = fixture();
    const custom = { ...f.member, approvalMode: "custom" as const };
    expect(f.roomTurnApprovalMode(custom, "room", { roomHandoffId: f.handoff.id })).toBe("auto");
  });
  it("keeps execution within the recorded ceiling and consultations within the recipient grant", () => {
    const f = fixture();
    f.handoff.level = "auto";
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("auto");
    f.handoff.mode = "consult";
    expect(f.roomTurnApprovalMode(f.member, "room", { roomHandoffId: f.handoff.id })).toBe("ask");
  });
});
