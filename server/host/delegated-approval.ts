import { delegationOriginKind } from "./delegation-origin.ts";
import { delegatedApprovalMode } from "../auto-approve.ts";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode.ts";
import type { BotRecord, Store } from "../store.ts";
import type { Coordinator, HandoffView } from "../coordinator.ts";
import type { ModelSelection } from "../contracts.ts";

export function createDelegatedApprovals(deps: {
  store(): Store;
  coordinator(): Coordinator;
  driverKind(selection: ModelSelection): string | undefined;
  cloudGuestDriven(threadId: string): boolean;
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  approvalModeForTurn(bot: BotRecord, peerInitiated?: boolean, threadId?: string): ApprovalMode;
}) {
// Only authorized Chief work can inherit a grant; outside work and Custom recipients keep their own policy.
function delegatedLevel(from: BotRecord, fromThreadId: string, target: BotRecord, recipientMode: ApprovalMode, origin: "person" | "routine" | "outside" = "person"): ApprovalMode | null {
  if (origin === "outside" || approvalModeFor(target) === "custom") return null;
  return delegatedApprovalMode({
    senderIsChief: Boolean(from.chiefOfStaff),
    senderMode: deps.sourceApprovalMode(from.id, fromThreadId),
    sameBot: from.id === target.id,
    recipientMode,
    recipientDriverKind: deps.driverKind(target.modelSelection),
  });
}

 function ownThreadLevel(target: BotRecord, threadId: string): ApprovalMode {
  return deps.approvalModeForTurn(deps.store().projectBotForTask(target.id, threadId) ?? target, false, threadId);
}

const DELEGATED_LEVEL_NAMES: Partial<Record<ApprovalMode, string>> = { edits: "Auto-accept edits", auto: "Approve for me", full: "Full access" };

 function applyDelegatedLevel(from: BotRecord, fromThreadId: string, target: BotRecord, threadId: string, origin: "person" | "routine" | "outside"): void {
  const level = delegatedLevel(from, fromThreadId, target, ownThreadLevel(target, threadId), origin);
  if (!level || deps.store().taskByThread(target.id, threadId)?.approvalMode === level) return;
  deps.store().patchTask(target.id, threadId, { approvalMode: level, autoApprove: false, alwaysAllow: [] });
  const name = DELEGATED_LEVEL_NAMES[level] ?? level;
  deps.store().appendMessage(threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${name} — delegated by ${from.name}, a Chief of Staff on ${name}`, ok: true },
  });
}

 function roomTurnApprovalMode(bot: BotRecord, threadId: string, orchestration?: { roomHandoffId?: string }): ApprovalMode {
  const handoff = orchestration?.roomHandoffId ? deps.coordinator().node(orchestration.roomHandoffId) : undefined;
  const source = handoff?.parentId ? deps.coordinator().node(handoff.parentId) : undefined;
  const origin = delegationOriginKind(handoff ? deps.coordinator().node(handoff.rootId) : undefined);
  return roomTurnLevel(bot, threadId, source, origin);
}

 function roomTurnLevel(bot: BotRecord, threadId: string, source: Pick<HandoffView, "botId" | "threadId"> | undefined, origin: "person" | "routine" | "outside" = "outside"): ApprovalMode {
  if (deps.cloudGuestDriven(threadId)) return "ask";
  const from = source ? deps.store().bot(source.botId) : undefined;
  const own = deps.approvalModeForTurn(bot, source !== undefined, threadId);
  return (from && source && delegatedLevel(from, source.threadId, bot, own, origin)) || own;
}


  return { delegatedLevel, applyDelegatedLevel, roomTurnApprovalMode, roomTurnLevel };
}
