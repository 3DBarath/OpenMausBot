// What of a conversation is sent to the model, and how conversations are
// grouped into calls. Per conversation: its title, its date and the person's
// messages, each cut at 1,500 characters with fenced code dropped, 6,000
// characters at most. Conversations are packed, in order, into batches of
// about 24,000 characters; one batch is one model call. The scan uses the
// same numbers, so the estimate it shows is the work that will be done.

export const MESSAGE_MAX_CHARS = 1_500;
export const CONVERSATION_MAX_CHARS = 6_000;
export const BATCH_MAX_CHARS = 24_000;
/** What a conversation's heading line costs in a batch, on top of its text. */
export const HEADING_CHARS = 120;
/** Pasted text has no conversations: it is sent in pieces of this size. */
export const PASTE_PIECE_CHARS = 20_000;

/** One conversation as it is sent. No id: the hash is all that is kept of it. */
export interface PreparedConversation {
  /** conversationHash(); "" for pasted text. */
  hash: string;
  title: string;
  /** YYYY-MM-DD, the day it was last updated. */
  date: string;
  updatedAt: number;
  /** One line per message. */
  text: string;
}

/** The first `max` characters, never ending on half of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** A fence that never closes takes the rest of the message with it. */
export function dropFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ");
}

/** One message as one line: no code blocks, no runaway whitespace, cut. */
export function cutMessage(text: string): string {
  return clip(dropFencedCode(text).replace(/\s+/g, " ").trim(), MESSAGE_MAX_CHARS);
}

/** The person's messages of one conversation as they are sent, oldest first. */
export function conversationText(messages: readonly string[]): string {
  const lines: string[] = [];
  let length = 0;
  for (const message of messages) {
    const line = cutMessage(message);
    if (!line) continue;
    const room = CONVERSATION_MAX_CHARS - length - (lines.length ? 1 : 0);
    if (room <= 0) break;
    const kept = clip(line, room);
    lines.push(kept);
    length += kept.length + (lines.length > 1 ? 1 : 0);
  }
  return lines.join("\n");
}

/** Pasted text in pieces, cut at line ends where it can be. */
export function pastePieces(text: string): string[] {
  const pieces: string[] = [];
  let piece = "";
  const flush = () => {
    if (piece.trim()) pieces.push(piece.trim());
    piece = "";
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    let rest = line;
    while (rest.length > PASTE_PIECE_CHARS) {
      flush();
      const head = clip(rest, PASTE_PIECE_CHARS);
      pieces.push(head);
      rest = rest.slice(head.length);
    }
    if (piece.length + rest.length + 1 > PASTE_PIECE_CHARS) flush();
    piece += piece ? `\n${rest}` : rest;
  }
  flush();
  return pieces;
}

/** Group sizes, in order, into batches of at most `limit` characters; each
 * item also costs its heading. An item larger than the limit gets a batch
 * of its own. Returns the indexes of each batch. */
export function packBatches(sizes: readonly number[], limit = BATCH_MAX_CHARS): number[][] {
  const batches: number[][] = [];
  let current: number[] = [];
  let used = 0;
  sizes.forEach((size, index) => {
    const cost = size + HEADING_CHARS;
    if (current.length && used + cost > limit) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += cost;
  });
  if (current.length) batches.push(current);
  return batches;
}
