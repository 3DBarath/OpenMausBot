import { randomUUID } from "node:crypto";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { approvalEvidence, reviewApproval, type ReviewAction, type ReviewVerdict } from "../approval-review.ts";
import { appendDecision } from "../decision-log.ts";
import { redactSecretsInText } from "../redact.ts";
import type { AppConfig } from "../config.ts";
import type { Store } from "../store.ts";
import type { ProviderInstance } from "../contracts.ts";
import type { ModelSelection } from "../../shared/wire.ts";
import type { UsageRow } from "../usage-ledger.ts";

export function createApprovalReviewService(deps: {
  store(): Store;
  config(): AppConfig;
  watchdog(): { setCheckpointOwnsDeadline(threadId: string, value: boolean): void };
  getProvider(id: string): ProviderInstance | undefined;
  providerRefusal(provider: ProviderInstance): string | null | undefined;
  assertBudget(): void;
  bookUsage(row: Omit<UsageRow, "at" | "costSource">, countsKnown: boolean, threadId: string): void;
  sourceApprovalMode(botId: string, threadId: string): ApprovalMode;
  roomApprovalMode(threadId: string, botId: string): ApprovalMode;
  dataDir: string;
}) {
  const reviewSessionSelections = new Map<string, ModelSelection>();
  const approvalReviewControllers = new Map<string, Set<AbortController>>();
  const connectorReviewGrants = new Map<string, { settings: string; expiresAt: number }>();
function reviewGrantKey(threadId: string, tool: string, args: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, part]) => [key, canonical(part)])) : value;
  return `${threadId}:${JSON.stringify([tool.toLowerCase(), canonical(args)])}`;
}

function carryConnectorApproval(threadId: string, action: ReviewAction) {
  if (!action.tool.startsWith("composio_")) return;
  for (const [key, grant] of connectorReviewGrants) if (grant.expiresAt <= Date.now()) connectorReviewGrants.delete(key);
  connectorReviewGrants.set(reviewGrantKey(threadId, action.tool.slice("composio_".length), action.arguments),
    { settings: JSON.stringify(deps.config().approvalReview ?? {}), expiresAt: Date.now() + 60_000 });
}

function approvedToolForTurn(threadId: string, isCurrent: () => boolean) {
  return (action: ReviewAction, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!isCurrent()) throw new Error("The execution changed before approval could be used.");
    carryConnectorApproval(threadId, action);
  };
}

function reviewToolForTurn(botId: string, threadId: string, session: ModelSelection, isCurrent: () => boolean) {
  return async (action: ReviewAction, signal: AbortSignal): Promise<ReviewVerdict> => {
    const settings = deps.config().approvalReview ?? {};
    const settingsIdentity = JSON.stringify(settings);
    const messages = deps.store().activePath(threadId);
    let evidenceIdentity: string;
    try { evidenceIdentity = JSON.stringify(approvalEvidence(messages)); }
    catch { return { decision: "ask", reason: "The complete authorization evidence is unavailable; your approval is required." }; }
    const standingInstructions = deps.store().bot(botId)?.soul;
    const controller = new AbortController();
    const controllers = approvalReviewControllers.get(threadId) ?? new Set<AbortController>();
    controllers.add(controller);
    approvalReviewControllers.set(threadId, controllers);
    deps.watchdog().setCheckpointOwnsDeadline(threadId, true);
    const current = () => isCurrent() && JSON.stringify(deps.config().approvalReview ?? {}) === settingsIdentity &&
      deps.store().bot(botId)?.soul === standingInstructions && JSON.stringify(approvalEvidence(deps.store().activePath(threadId))) === evidenceIdentity;
    try {
      deps.assertBudget();
      const bot = deps.store().bot(botId);
      if (!bot) return { decision: "ask", reason: "The requesting bot is no longer available." };
      const verdict = await reviewApproval({
        action, session: reviewSessionSelections.get(threadId) ?? session, settings, messages, standingInstructions,
        getProvider: deps.getProvider, providerRefusal: deps.providerRefusal,
        signal: AbortSignal.any([signal, controller.signal]), isCurrent: current,
        onUsage: (provider, usage) => deps.bookUsage({ botId, botName: bot.name, threadId: `approval-${threadId}-${randomUUID()}`,
          instanceId: provider.instanceId, driverKind: provider.driverKind, model: usage.model,
          input: usage.input ?? 0, output: usage.output ?? 0,
          ...(usage.cachedInput !== undefined ? { cachedInput: usage.cachedInput } : {}), costUsd: usage.costUsd ?? null,
          trigger: { kind: "bot", botId } }, usage.input !== undefined && usage.output !== undefined, threadId),
      });
      if (!current() || signal.aborted || controller.signal.aborted) return { decision: "ask", reason: "The execution changed while review was pending." };
      const reason = redactSecretsInText(verdict.reason);
      appendDecision(deps.dataDir, { threadId, botId, botName: bot.name, tool: action.tool, summary: reason,
        decision: verdict.decision === "allow" ? "auto-approved" : verdict.decision === "deny" ? "auto-denied" : "card-shown",
        source: "auto-review", rule: verdict.reviewer ? `${verdict.reviewer.instanceId}:${verdict.reviewer.model}` : "review-unavailable" });
      deps.store().appendMessage(threadId, { role: "bot", kind: "activity",
        tool: { name: `${verdict.decision === "allow" ? "Approved" : verdict.decision === "deny" ? "Denied" : "Approval needed"} ${action.tool}: ${reason}`, ok: verdict.decision !== "deny" } });
      // A connector execution has an inner outbound gate. Carry only this
      // exact allow through it once, rather than calling the reviewer twice.
      if (verdict.decision === "allow") carryConnectorApproval(threadId, action);
      return { decision: verdict.decision, reason: verdict.decision === "deny"
        ? `${reason} Do not repackage this denied outcome or bypass review; use a materially safer alternative or ask the user.` : reason };
    } catch { return { decision: "ask", reason: "Automatic review is unavailable; your approval is required." }; }
    finally {
      controllers.delete(controller);
      if (!controllers.size) {
        approvalReviewControllers.delete(threadId);
        deps.watchdog().setCheckpointOwnsDeadline(threadId, false);
      }
    }
  };
}

  return {
    settingsBusy() {
      const store = deps.store();
      return approvalReviewControllers.size > 0 ||
        store.bots.some(bot => bot.tasks?.some(task => task.busy && deps.sourceApprovalMode(bot.id, task.threadId) === "auto")) ||
        store.groups.some(group => group.busyBotId && deps.roomApprovalMode(group.threadId, group.busyBotId) === "auto");
    },
    reviewToolForTurn, approvedToolForTurn,
    setSession(threadId: string, session: ModelSelection) { reviewSessionSelections.set(threadId, session); },
    session(threadId: string) { return reviewSessionSelections.get(threadId); },
    updateSessionModel(threadId: string, model: string) {
      const selection = reviewSessionSelections.get(threadId);
      if (selection) reviewSessionSelections.set(threadId, { ...selection, model });
    },
    active() { return approvalReviewControllers.size; },
    takeConnectorGrant(threadId: string, tool: string, args: Record<string, unknown>) {
      const key = reviewGrantKey(threadId, tool, args);
      const grant = connectorReviewGrants.get(key);
      connectorReviewGrants.delete(key);
      return grant;
    },
    finishThread(threadId: string) {
      for (const controller of approvalReviewControllers.get(threadId) ?? []) controller.abort();
      reviewSessionSelections.delete(threadId);
      for (const key of connectorReviewGrants.keys()) if (key.startsWith(`${threadId}:`)) connectorReviewGrants.delete(key);
    },
  };
}
