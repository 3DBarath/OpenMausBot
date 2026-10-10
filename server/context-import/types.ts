// What both export parsers produce: one conversation, reduced to what an
// import reads. The assistant's side, attachments and images are not here.

export interface ExportConversation {
  /** The export's own id for the conversation; "" when it has none. */
  id: string;
  title: string;
  /** When it was last updated, epoch milliseconds; 0 when the export does not say. */
  updatedAt: number;
  /** The person's own messages, oldest first. */
  messages: string[];
  /** Messages of the person's left out: an unknown shape, or no text (an image, a file). */
  skippedMessages: number;
}

/** A timestamp as an export writes it: seconds (ChatGPT), milliseconds, or ISO 8601 (Claude). */
export function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value < 1e11 ? value * 1000 : value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
