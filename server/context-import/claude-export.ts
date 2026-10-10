// A Claude export's conversations.json, one conversation at a time.
//
// Anthropic publishes no schema for the export either. The shape read here
// is the one people who parse these files have described since 2024, and it
// has NOT been checked against a real export from this year (see the plan's
// Checks; `scripts/context-import-scan.ts` reports what a real file holds):
//
//   { uuid, name, created_at, updated_at,                      // ISO 8601
//     chat_messages: [ { uuid, sender: "human" | "assistant", created_at,
//       text, content: [ { type: "text", text }, … ], attachments, files } ] }
//
// Only messages whose sender is the person are read. What a file attachment
// said is not the person's words and is left out. Anything of another shape
// is skipped and counted, never an error.
import { isRecord, toMillis, type ExportConversation } from "./types.ts";

export function isClaudeConversation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Array.isArray(value.chat_messages);
}

function ownText(message: Record<string, unknown>): string | null {
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  if (!Array.isArray(message.content)) return null;
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text || null;
}

export function parseClaudeConversation(value: unknown): ExportConversation | null {
  if (!isClaudeConversation(value)) return null;
  const messages: string[] = [];
  let skippedMessages = 0;
  for (const message of value.chat_messages as unknown[]) {
    if (!isRecord(message) || typeof message.sender !== "string") {
      skippedMessages += 1;
      continue;
    }
    if (message.sender === "assistant") continue;
    if (message.sender !== "human") {
      skippedMessages += 1;
      continue;
    }
    const text = ownText(message);
    if (text === null) skippedMessages += 1;
    else messages.push(text);
  }
  return {
    id: typeof value.uuid === "string" ? value.uuid : "",
    title: typeof value.name === "string" && value.name.trim() ? value.name.trim() : "Untitled",
    updatedAt: toMillis(value.updated_at) || toMillis(value.created_at),
    messages,
    skippedMessages,
  };
}
