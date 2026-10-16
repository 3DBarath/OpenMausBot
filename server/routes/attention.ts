// GET /api/attention/requests: the open approval and question cards of every
// conversation that is waiting on the person, so the attention panel can show
// each ask and answer it there through the same /respond path the composer
// uses. Only conversations marked "waiting-on-you" are read: they are live,
// so their messages are already in memory.
import type { Message, Store } from "../store.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface AttentionRequest {
  botId: string;
  botName: string;
  threadId: string;
  threadTitle: string;
  message: Message;
}

/** A card a person can still answer: a live provider ask that is an approval (a tool) or a question set. */
export function openAsk(message: Message): boolean {
  const card = message.card;
  return message.kind === "options" && Boolean(card?.requestId) && !card!.answered && !card!.dismissed && !card!.expired
    && (Boolean(card!.tool) || Boolean(card!.questionRequest?.questions.length));
}

export function attentionRequests(store: Pick<Store, "bots" | "messagesFor">, visible: (threadId: string) => boolean): AttentionRequest[] {
  const out: AttentionRequest[] = [];
  for (const bot of store.bots) {
    const waiting = new Map<string, string>();
    if (bot.activity === "waiting-on-you") waiting.set(bot.threadId, bot.tasks?.find((task) => task.threadId === bot.threadId)?.title ?? "");
    for (const task of bot.tasks ?? []) if (task.activity === "waiting-on-you") waiting.set(task.threadId, task.title ?? "");
    for (const [threadId, threadTitle] of waiting) {
      if (!visible(threadId)) continue;
      for (const message of store.messagesFor(threadId)) {
        if (openAsk(message)) out.push({ botId: bot.id, botName: bot.name, threadId, threadTitle, message });
      }
    }
  }
  return out.sort((a, b) => a.message.at - b.message.at);
}

export function createAttentionRoutes(deps: {
  store: Pick<Store, "bots" | "messagesFor">;
  threadVisible: (auth: RequestAuth, threadId: string) => boolean;
}): RouteHandler {
  return async ({ res, path, method, auth, json }) => {
    if (method !== "GET" || path !== "/api/attention/requests") return PASS;
    res.setHeader("cache-control", "no-store");
    return json(res, 200, { requests: attentionRequests(deps.store, (threadId) => deps.threadVisible(auth, threadId)) });
  };
}
