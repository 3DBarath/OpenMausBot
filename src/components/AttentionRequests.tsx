import { useContext } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { api, StoreContext, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { oneTapAnswer, oneTapQuestion, requestIdOf, useAttentionRequests, type AttentionRequest } from "@/lib/attention-requests";
import { APPROVAL_CONTROL, PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";

const loadRequests = () => api<{ requests?: AttentionRequest[] }>("/api/attention/requests", { timeoutMs: 10_000 });

/** The asks waiting on the person, answered where they are listed, through the composer's own decisions. */
export function AttentionRequests({ compact }: { compact: boolean }) {
  const store = useContext(StoreContext);
  const { requests, answered } = useAttentionRequests(Boolean(store), loadRequests);
  if (!store || requests.length === 0) return null;
  return (
    <ul data-testid="attention-requests" aria-label={t("attention.requests.title")} className={cn("flex flex-col gap-1.5 px-1.5", compact ? "pb-1" : "pb-1.5")}>
      {requests.map((request) => (
        <li key={requestIdOf(request)}>
          <AttentionRequestItem request={request} bot={store.state.bots.find((bot) => bot.id === request.botId)}
            dispatch={store.dispatch} onAnswered={() => answered(request)} />
        </li>
      ))}
    </ul>
  );
}

export function AttentionRequestItem({ request, bot, dispatch, onAnswered }: {
  request: AttentionRequest;
  bot?: Bot;
  dispatch: NonNullable<React.ContextType<typeof StoreContext>>["dispatch"];
  onAnswered: () => void;
}) {
  const open = () => dispatch({ type: "switchTask", botId: request.botId, threadId: request.threadId });
  const where = (
    <button type="button" onClick={open} className="min-w-0 truncate text-left text-[11px] text-ink-secondary hover:text-ink hover:underline">
      {request.threadTitle ? t("attention.requests.where", { name: request.botName, title: request.threadTitle }) : request.botName}
    </button>
  );
  const pending = pendingApprovals([request.message])[0];
  if (pending) {
    return (
      <div className="flex flex-col gap-1" onClickCapture={(event) => { if ((event.target as HTMLElement).closest("[data-approval-decision] button")) onAnswered(); }}>
        {where}
        <PendingApprovalPanel pending={pending} count={1} index={0} botName={request.botName}
          actions={<span data-approval-decision className="contents"><PendingApprovalActions part="primary" pending={pending} threadId={request.threadId} bot={bot} onCancelTurn={() => {}} /></span>} />
      </div>
    );
  }
  const question = oneTapQuestion(request);
  const card = request.message.card!;
  const asked = card.questionRequest?.questions[0];
  return (
    <div role="region" aria-label={t("question.card.named", { name: request.botName })} className="flex flex-col gap-1.5 rounded-lg border border-hairline/40 bg-panel px-2.5 py-2">
      {where}
      <div className="flex items-start gap-1.5 text-[12.5px] text-ink">
        <MessageCircleQuestion size={13} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-secondary" />
        <span className="min-w-0">{asked?.question ?? card.title}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {question ? question.options.map((option) => (
          <button key={option.label} type="button" title={option.description}
            onClick={() => {
              onAnswered();
              dispatch({ type: "decideRequest", threadId: request.threadId, requestId: card.requestId!, behavior: "answer", message: oneTapAnswer(question, option.label) });
            }}
            className={cn(APPROVAL_CONTROL, "bg-ink/[0.07] text-ink hover:bg-ink/[0.12]")}>
            {option.label}
          </button>
        )) : (
          <button type="button" onClick={open} className={cn(APPROVAL_CONTROL, "bg-ink/[0.07] text-ink hover:bg-ink/[0.12]")}>
            {t("attention.requests.answerThere")}
          </button>
        )}
      </div>
    </div>
  );
}
