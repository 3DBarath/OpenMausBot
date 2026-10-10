// The two export parsers on synthetic conversations: only the person's own
// messages, only the branch they last saw, and every shape the parsers do
// not know skipped and counted instead of failing.
import { describe, expect, it } from "vitest";

import { chatGptConversation, claudeConversation } from "../testing/context-import-fixtures.ts";
import { isChatGptConversation, parseChatGptConversation } from "./chatgpt-export.ts";
import { isClaudeConversation, parseClaudeConversation } from "./claude-export.ts";
import { toMillis } from "./types.ts";

const AT = Date.UTC(2026, 2, 2, 10, 30);

describe("timestamps", () => {
  it("reads seconds, milliseconds and ISO 8601, and gives 0 for anything else", () => {
    expect(toMillis(1_772_447_400.5)).toBe(1_772_447_400_500);
    expect(toMillis(1_772_447_400_000)).toBe(1_772_447_400_000);
    expect(toMillis("2026-03-02T10:30:00.000000Z")).toBe(AT);
    for (const junk of [null, undefined, "", "soon", -5, Number.NaN, {}]) expect(toMillis(junk)).toBe(0);
  });
});

describe("a ChatGPT conversation", () => {
  it("keeps the person's messages in order and nothing the assistant said", () => {
    const parsed = parseChatGptConversation(chatGptConversation({ id: "c1", title: "  Dinner ideas ", updatedAt: AT, messages: ["I'm vegetarian.", "Suggest three places."] }));
    expect(parsed).toEqual({ id: "c1", title: "Dinner ideas", updatedAt: AT, messages: ["I'm vegetarian.", "Suggest three places."], skippedMessages: 0 });
  });

  it("follows only the active branch of an edited conversation", () => {
    const node = (id: string, parent: string | null, children: string[], role?: string, text?: string) =>
      [id, { id, parent, children, message: role ? { author: { role }, content: { content_type: "text", parts: [text] } } : null }] as const;
    const mapping = Object.fromEntries([
      node("root", null, ["u1"]),
      node("u1", "root", ["a1", "a1b"], "user", "I live in Mumbai."),
      node("a1", "u1", ["u2"], "assistant", "Noted."),
      node("u2", "a1", [], "user", "Abandoned draft about Mumbai trains."),
      // the person edited their second message: a new branch from the same parent
      node("a1b", "u1", ["u2b"], "assistant", "Noted again."),
      node("u2b", "a1b", ["a2b"], "user", "Actually I moved to Pune."),
      node("a2b", "u2b", [], "assistant", "Updated."),
    ]);
    const conversation = { id: "c2", title: "Cities", update_time: AT / 1000, mapping, current_node: "a2b" };
    expect(parseChatGptConversation(conversation)?.messages).toEqual(["I live in Mumbai.", "Actually I moved to Pune."]);
    // without current_node, the last child at each step is the latest edit
    expect(parseChatGptConversation({ ...conversation, current_node: undefined })?.messages).toEqual(["I live in Mumbai.", "Actually I moved to Pune."]);
    expect(parseChatGptConversation({ ...conversation, current_node: "gone" })?.messages).toEqual(["I live in Mumbai.", "Actually I moved to Pune."]);
  });

  it("keeps the text of a mixed message and counts what it cannot read", () => {
    const message = (id: string, parent: string, content: unknown, extra: Record<string, unknown> = {}) =>
      [id, { id, parent, children: [], message: { author: { role: "user" }, content, ...extra } }] as const;
    const mapping = Object.fromEntries([
      ["root", { id: "root", parent: null, children: [], message: null }],
      message("m1", "root", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer", asset_pointer: "file-service://x" }, "What plant is this?"] }),
      message("m2", "m1", { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }] }),
      message("m3", "m2", { content_type: "user_editable_context", user_profile: "hidden" }, { metadata: { is_visually_hidden_from_conversation: true } }),
      message("m4", "m3", { content_type: "some_future_type", stuff: 1 }),
      message("m5", "m4", "just a string"),
      ["m6", { id: "m6", parent: "m5", children: [], message: "not an object" }],
      message("m7", "m6", { content_type: "text", parts: ["   "] }),
      message("m8", "m7", { content_type: "text", parts: ["Last real message."] }),
    ]);
    const parsed = parseChatGptConversation({ conversation_id: "c3", mapping, current_node: "m8" });
    expect(parsed).toEqual({ id: "c3", title: "Untitled", updatedAt: 0, messages: ["What plant is this?", "Last real message."], skippedMessages: 5 });
  });

  it("survives a parent loop and refuses what is not a conversation", () => {
    const mapping = { a: { id: "a", parent: "b", children: ["b"], message: { author: { role: "user" }, content: { content_type: "text", parts: ["loop"] } } }, b: { id: "b", parent: "a", children: ["a"], message: null } };
    expect(parseChatGptConversation({ id: "c4", mapping, current_node: "a" })?.messages).toEqual(["loop"]);
    expect(parseChatGptConversation({ id: "c4", mapping })?.messages).toEqual(["loop"]);
    for (const junk of [null, 7, "text", [], {}, { mapping: [] }, { mapping: null }, { chat_messages: [] }]) {
      expect(isChatGptConversation(junk)).toBe(false);
      expect(parseChatGptConversation(junk)).toBeNull();
    }
  });
});

describe("a Claude conversation", () => {
  it("keeps the messages whose sender is the person", () => {
    const parsed = parseClaudeConversation(claudeConversation({ id: "u1", title: "Launch plan", updatedAt: AT, messages: ["We ship on Fridays.", "Draft the note."] }));
    expect(parsed).toEqual({ id: "u1", title: "Launch plan", updatedAt: AT, messages: ["We ship on Fridays.", "Draft the note."], skippedMessages: 0 });
  });

  it("falls back to the content blocks, leaves attachments out and counts unknown shapes", () => {
    const parsed = parseClaudeConversation({
      uuid: "u2", name: "", created_at: "2026-03-02T10:30:00Z",
      chat_messages: [
        { sender: "human", text: "", content: [{ type: "text", text: "From the blocks." }, { type: "tool_result", content: "ignored" }] },
        { sender: "human", text: "See the file.", attachments: [{ file_name: "notes.txt", extracted_content: "ATTACHMENT TEXT" }] },
        { sender: "human", text: "", content: [], files: [{ file_name: "photo.png" }] },
        { sender: "assistant", text: "Not the person." },
        { sender: "tool", text: "Unknown sender." },
        "not an object",
        { text: "no sender" },
      ],
    });
    expect(parsed).toEqual({ id: "u2", title: "Untitled", updatedAt: AT, messages: ["From the blocks.", "See the file."], skippedMessages: 4 });
    expect(JSON.stringify(parsed)).not.toContain("ATTACHMENT TEXT");
  });

  it("refuses what is not a conversation", () => {
    for (const junk of [null, 7, [], {}, { chat_messages: {} }, { mapping: {} }]) {
      expect(isClaudeConversation(junk)).toBe(false);
      expect(parseClaudeConversation(junk)).toBeNull();
    }
  });
});
