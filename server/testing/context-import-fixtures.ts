// Synthetic ChatGPT and Claude exports for the context-import tests and the
// verification recipe. These follow the shapes the parsers assume
// (server/context-import/chatgpt-export.ts, claude-export.ts); they are not
// copies of real exports, and prove nothing about what a real one holds.
import { writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

export interface FixtureConversation {
  id: string;
  title: string;
  /** Epoch milliseconds. */
  updatedAt: number;
  /** The person's messages, oldest first; the assistant answers each one. */
  messages: string[];
}

/** One ChatGPT conversation: a linear tree from a root node to `current_node`. */
export function chatGptConversation(input: FixtureConversation): Record<string, unknown> {
  const seconds = input.updatedAt / 1000;
  const mapping: Record<string, unknown> = { root: { id: "root", parent: null, children: [], message: null } };
  let parent = "root";
  const add = (id: string, role: string, content: unknown, metadata: Record<string, unknown> = {}) => {
    mapping[id] = { id, parent, children: [], message: { id, author: { role, name: null, metadata: {} }, create_time: seconds, content, status: "finished_successfully", metadata, recipient: "all" } };
    (mapping[parent] as { children: string[] }).children.push(id);
    parent = id;
  };
  add("system", "system", { content_type: "text", parts: [""] }, { is_visually_hidden_from_conversation: true });
  input.messages.forEach((text, index) => {
    add(`u${index}`, "user", { content_type: "text", parts: [text] });
    add(`a${index}`, "assistant", { content_type: "text", parts: [`Assistant reply ${index}, which an import never reads.`] });
  });
  return {
    title: input.title, create_time: seconds - 60, update_time: seconds, mapping, moderation_results: [], current_node: parent,
    conversation_id: input.id, id: input.id, is_archived: false, default_model_slug: "gpt-4o",
  };
}

export function claudeConversation(input: FixtureConversation): Record<string, unknown> {
  const at = new Date(input.updatedAt).toISOString();
  return {
    uuid: input.id, name: input.title, summary: "", created_at: at, updated_at: at, account: { uuid: "account-1" },
    chat_messages: input.messages.flatMap((text, index) => [
      { uuid: `${input.id}-h${index}`, sender: "human", text, content: [{ type: "text", text }], created_at: at, updated_at: at, attachments: [], files: [] },
      { uuid: `${input.id}-a${index}`, sender: "assistant", text: `Assistant reply ${index}, which an import never reads.`, content: [], created_at: at, updated_at: at, attachments: [], files: [] },
    ]),
  };
}

/** A conversations.json as a bare file. */
export function writeExportJson(path: string, conversations: readonly unknown[]): void {
  writeFileSync(path, JSON.stringify(conversations), { mode: 0o600 });
}

/** An export zip: conversations.json beside the other files an export carries. */
export function writeExportZip(path: string, conversations: readonly unknown[]): void {
  writeFileSync(path, zipSync({
    "user.json": strToU8(JSON.stringify({ id: "user-1" })),
    "chat.html": strToU8("<html><body>not read</body></html>"),
    "conversations.json": strToU8(JSON.stringify(conversations)),
  }), { mode: 0o600 });
}

const DAY = 86_400_000;

/** A small export with something of everything, dated back from `now`. */
export function sampleConversations(now: number): FixtureConversation[] {
  return [
    { id: "conv-food", title: "Dinner ideas", updatedAt: now - 2 * DAY, messages: ["I'm vegetarian and I love Irani cafes.", "Suggest three places in Pune, where I live."] },
    { id: "conv-work", title: "Launch plan", updatedAt: now - 40 * DAY, messages: ["I run a two-person company called Supamaus. We ship on Fridays.", "```ts\nconst secret = 1;\n```\nReview this snippet."] },
    { id: "conv-old", title: "Old city", updatedAt: now - 500 * DAY, messages: ["I live in Mumbai."] },
  ];
}
