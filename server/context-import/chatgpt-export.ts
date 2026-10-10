// A ChatGPT export's conversations.json, one conversation at a time.
//
// OpenAI publishes no schema for the export. The shape read here is the one
// people who parse these files have described since 2023, and it has NOT
// been checked against a real export from this year (see the plan's Checks;
// `scripts/context-import-scan.ts` reports what a real file actually holds):
//
//   { id | conversation_id, title, create_time, update_time,   // seconds, as floats
//     current_node,
//     mapping: { <node id>: { id, parent, children,
//       message: null | { author: { role }, create_time, metadata,
//         content: { content_type, parts } } } } }
//
// A conversation is a tree, because editing a message starts a new branch.
// The branch the person last saw runs from `current_node` up through
// `parent`; only that branch is read. Anything of another shape is skipped
// and counted, never an error.
import { isRecord, toMillis, type ExportConversation } from "./types.ts";

export function isChatGptConversation(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRecord(value.mapping);
}

/** The node ids of the active branch, oldest first. */
function activeBranch(mapping: Record<string, unknown>, currentNode: unknown): string[] {
  const parentOf = (id: string): string | null => {
    const node = mapping[id];
    return isRecord(node) && typeof node.parent === "string" && Object.hasOwn(mapping, node.parent) ? node.parent : null;
  };
  const ids = Object.keys(mapping);
  if (typeof currentNode === "string" && Object.hasOwn(mapping, currentNode)) {
    const branch: string[] = [];
    const seen = new Set<string>();
    for (let id: string | null = currentNode; id !== null && !seen.has(id); id = parentOf(id)) {
      seen.add(id);
      branch.push(id);
    }
    return branch.reverse();
  }
  // No current node: from the root, follow the last child, which is the latest edit.
  const root = ids.find((id) => parentOf(id) === null);
  if (root === undefined) return ids;
  const branch: string[] = [];
  const seen = new Set<string>();
  for (let id: string | undefined = root; id !== undefined && !seen.has(id);) {
    seen.add(id);
    branch.push(id);
    const node: unknown = mapping[id];
    const children: unknown[] = isRecord(node) && Array.isArray(node.children) ? node.children : [];
    const next: unknown = children.findLast((child) => typeof child === "string" && Object.hasOwn(mapping, child));
    id = typeof next === "string" ? next : undefined;
  }
  return branch;
}

/** The text of one of the person's messages; null when it has none this reader knows. */
function ownText(message: Record<string, unknown>): string | null {
  const content = message.content;
  if (!isRecord(content)) return null;
  if (content.content_type !== "text" && content.content_type !== "multimodal_text") return null;
  if (!Array.isArray(content.parts)) return null;
  // a multimodal message mixes text with image pointers; only the text is the person's words
  const text = content.parts.filter((part): part is string => typeof part === "string").join("\n").trim();
  return text || null;
}

export function parseChatGptConversation(value: unknown): ExportConversation | null {
  if (!isChatGptConversation(value)) return null;
  const mapping = value.mapping as Record<string, unknown>;
  const messages: string[] = [];
  let skippedMessages = 0;
  for (const id of activeBranch(mapping, value.current_node)) {
    const node = mapping[id];
    const message = isRecord(node) ? node.message : null;
    if (message === null || message === undefined) continue;
    if (!isRecord(message) || !isRecord(message.author)) {
      skippedMessages += 1;
      continue;
    }
    if (message.author.role !== "user") continue;
    // custom instructions ride along as a hidden message in every conversation
    if (isRecord(message.metadata) && message.metadata.is_visually_hidden_from_conversation === true) continue;
    const text = ownText(message);
    if (text === null) skippedMessages += 1;
    else messages.push(text);
  }
  const id = typeof value.conversation_id === "string" && value.conversation_id ? value.conversation_id : typeof value.id === "string" ? value.id : "";
  return {
    id,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : "Untitled",
    updatedAt: toMillis(value.update_time) || toMillis(value.create_time),
    messages,
    skippedMessages,
  };
}
