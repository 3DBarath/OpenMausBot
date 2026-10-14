import type { Message } from "./store.ts";
import { extractTurnImages } from "./turn-images.ts";
import { redactSecretsInText } from "./redact.ts";
import type { CaptureTurn, RoomLine } from "./memory-capture.ts";

/** Only the visible branch and attributed messages may feed memory. */
export function memoryTurn(messages: readonly Message[], botId: string, turnId: string, room: boolean, failed = false): CaptureTurn | null {
  const replyAt = messages.findLastIndex(message => message.role === "bot" && message.kind === "text" && message.turnId === turnId
    && (!room || message.from?.botId === botId));
  if (replyAt < 0) return null;
  const reply = messages[replyAt];
  const clean = (text: string) => redactSecretsInText(extractTurnImages(text).text);
  const previous = room ? messages.slice(0, replyAt).findLastIndex(message => message.role === "bot" && message.kind === "text" && message.from?.botId === botId) : -1;
  const before = messages.slice(previous + 1, replyAt);
  const asked = before.findLast(message => message.role === "user" && message.kind === "text");
  if (!room && !asked) return null;
  const lines: RoomLine[] = before.filter(message => message.kind === "text" && !message.peerAsk && (message.role === "user" || message.role === "bot"))
    .slice(-30).map(message => ({ by: message.role === "bot" ? "peer" : message.sender || message.relayed ? "other" : "person",
      name: message.from?.name ?? "participant", text: clean(message.text ?? ""), messageId: message.id }));
  const tools = messages.filter(message => message.turnId === turnId && message.kind === "activity" && message.tool)
    .slice(-20).map(message => `${message.tool!.name}: ${message.tool!.ok === false ? "failed" : "observed"}`).join("; ");
  return { person: asked?.peerAsk ? "" : clean(asked?.text ?? ""), bot: clean(reply.text ?? ""), owner: !room && !asked?.sender && !asked?.peerAsk && !asked?.relayed,
    sourceMessageId: reply.id, turnId, failed, delegated: Boolean(asked?.peerAsk), evidence: tools || "No tool evidence recorded", ...(room ? { room: lines } : {}) };
}
