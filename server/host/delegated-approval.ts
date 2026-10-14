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
/** A Chief of Staff's level flows down its delegation. The person set the
 * Chief's level so its work runs that way; a teammate the Chief brings in
 * starting at "Ask for approval" meant switching every such thread by hand,
 * all day, for the whole team. So a teammate a Chief delegates to starts at
 * the Chief's level for that work: Auto-accept edits, Approve for me or Full
 * access (delegatedApprovalMode: never lower than the teammate's own level,
 * capped at what its engine implements). Only a Chief passes its level on —
 * an ordinary bot's delegation still uses the recipient's setting. Returns
 * null to keep the recipient's own level. */
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

 function applyDelegatedLevel(from: BotRecord, fromThreadId: string, target: BotRecord, threadId: string, origin: "person" | "outside"): void {
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
  const origin = handoff ? deps.coordinator().node(handoff.rootId)?.origin?.kind : undefined;
  return roomTurnLevel(bot, threadId, source, origin === "user" ? "person" : "outside");
}

 function roomTurnLevel(bot: BotRecord, threadId: string, source: Pick<HandoffView, "botId" | "threadId"> | undefined, origin: "person" | "routine" | "outside" = "outside"): ApprovalMode {
  if (deps.cloudGuestDriven(threadId)) return "ask";
  const from = source ? deps.store().bot(source.botId) : undefined;
  const own = deps.approvalModeForTurn(bot, source !== undefined, threadId);
  return (from && source && delegatedLevel(from, source.threadId, bot, own, origin)) || own;
}


  return { delegatedLevel, applyDelegatedLevel, roomTurnApprovalMode, roomTurnLevel };
}
