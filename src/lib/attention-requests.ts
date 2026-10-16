// The open asks (approvals and provider questions) of conversations waiting on
// the person, as GET /api/attention/requests lists them. The attention panel
// polls while it is on screen and hides an ask the moment it is answered here;
// the next read drops it for good, or brings it back if the answer failed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AskQuestion } from "../../shared/ask-question";
import { formatQuestionAnswers } from "../../shared/ask-question";
import type { Message } from "@/state/store";

export interface AttentionRequest {
  botId: string;
  botName: string;
  threadId: string;
  threadTitle: string;
  message: Message;
}

export const ATTENTION_POLL_MS = 8_000;
/** After an answer, the server needs a moment to settle the card. */
export const ATTENTION_SETTLE_MS = 1_500;

export function requestIdOf(request: AttentionRequest): string {
  return request.message.card?.requestId ?? request.message.id;
}

/** Still open as far as this screen knows: not answered here and not settled in a loaded copy of the conversation. */
export function visibleRequests(requests: readonly AttentionRequest[], answeredHere: ReadonlySet<string>): AttentionRequest[] {
  return requests.filter((request) => {
    const card = request.message.card;
    return Boolean(card) && !card!.answered && !card!.dismissed && !card!.expired && !answeredHere.has(requestIdOf(request));
  });
}

/** A question set that one tap answers: a single, single-choice question with options. */
export function oneTapQuestion(request: AttentionRequest): AskQuestion | null {
  const questions = request.message.card?.questionRequest?.questions ?? [];
  const only = questions.length === 1 ? questions[0]! : null;
  return only && !only.multiSelect && only.options.length > 0 ? only : null;
}

export function oneTapAnswer(question: AskQuestion, label: string): string {
  return formatQuestionAnswers([question], [[label]]);
}

export function useAttentionRequests(enabled: boolean, load: () => Promise<{ requests?: AttentionRequest[] }>) {
  const [requests, setRequests] = useState<AttentionRequest[]>([]);
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(new Set());
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try {
      const next = (await loadRef.current()).requests ?? [];
      setRequests(next);
      // an id the server no longer lists is settled; one it still lists after an answer failed comes back
      setAnsweredHere(new Set());
    } catch {
      // a session without the scope, or the server restarting: keep what is on screen
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh(); }, ATTENTION_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  const answered = useCallback((request: AttentionRequest) => {
    setAnsweredHere((current) => new Set([...current, requestIdOf(request)]));
    setTimeout(() => void refresh(), ATTENTION_SETTLE_MS);
  }, [refresh]);
  return { requests: visibleRequests(requests, answeredHere), answered, refresh };
}
