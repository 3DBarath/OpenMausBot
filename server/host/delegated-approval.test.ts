import { describe, expect, it, vi } from "vitest";
import { approvalModeFor } from "../../shared/approval-mode.ts";
import { approvalModeForOrigin } from "../auto-approve.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import { createDelegatedApprovals } from "./delegated-approval.ts";

const fixture = (custom = false, outside = false) => {
  const chief = { id: "chief", name: "Chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "codex" } } as BotRecord;
  const member = { id: "member", name: "Member", approvalMode: custom ? "custom" : "ask", modelSelection: { instanceId: "codex" } } as BotRecord;
  const bots = new Map([[chief.id, chief], [member.id, member]]);
  const patchTask = vi.fn();
  const store = { bot: (id: string) => bots.get(id), projectBotForTask: (id: string) => bots.get(id), taskByThread: () => ({ approvalMode: "ask" }), patchTask, appendMessage: vi.fn() } as unknown as Store;
  const nodes = new Map<string, Partial<HandoffView>>([
    ["root", { id: "root", rootId: "root", botId: chief.id, threadId: "source", origin: outside ? { kind: "outside" } : { kind: "user", request: "Perform this synthetic assignment." } }],
    ["handoff", { id: "handoff", rootId: "root", parentId: "root", botId: member.id, threadId: "destination" }],
  ]);
  const coordinator = { node: (id: string) => nodes.get(id) } as unknown as Coordinator;
  const levels = createDelegatedApprovals({ store: () => store, coordinator: () => coordinator, driverKind: () => "codex", cloudGuestDriven: () => false,
    sourceApprovalMode: () => "full", approvalModeForTurn: (bot, peerInitiated) => approvalModeForOrigin(approvalModeFor(bot), { peerInitiated: Boolean(peerInitiated) }) });
  return { levels, chief, member, patchTask, source: { botId: chief.id, threadId: "source" } };
};

describe("delegated connector authority", () => {
  it.each(["person", "routine"] as const)("inherits a Chief grant for an authorized %s lineage", origin => {
    const f = fixture();
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, origin)).toBe("full");
  });
  it("does not borrow a Chief grant for outside work or an unknown lineage", () => {
    const f = fixture(false, true);
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, "outside")).toBe("ask");
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source)).toBe("ask");
    expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("ask");
    f.levels.applyDelegatedLevel(f.chief, "source", f.member, "destination", "outside");
    expect(f.patchTask).not.toHaveBeenCalled();
  });
  it("does not elevate a Custom recipient after peer normalization", () => {
    const f = fixture(true);
    expect(f.levels.roomTurnLevel(f.member, "destination", f.source, "person")).toBe("auto");
    expect(f.levels.roomTurnApprovalMode(f.member, "destination", { roomHandoffId: "handoff" })).toBe("auto");
    f.levels.applyDelegatedLevel(f.chief, "source", f.member, "destination", "person");
    expect(f.patchTask).not.toHaveBeenCalled();
  });
});
