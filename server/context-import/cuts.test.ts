// The cuts and the packing: what of a conversation is sent, and how many
// calls a set of conversations makes.
import { describe, expect, it } from "vitest";

import { BATCH_MAX_CHARS, clip, CONVERSATION_MAX_CHARS, conversationText, cutMessage, dropFencedCode, HEADING_CHARS, MESSAGE_MAX_CHARS, packBatches, PASTE_PIECE_CHARS, pastePieces } from "./cuts.ts";

describe("cutting a message", () => {
  it("drops fenced code, closed or not, and folds the rest onto one line", () => {
    expect(dropFencedCode("before ```ts\nconst a = 1;\n``` after").replace(/\s+/g, " ")).toBe("before after");
    expect(cutMessage("Review this:\n```py\nprint('x')\n```\nand tell me\n\nwhat you think")).toBe("Review this: and tell me what you think");
    expect(cutMessage("Here it is ```never closed\nSECRET_CODE")).toBe("Here it is");
    expect(cutMessage("```only code```")).toBe("");
  });

  it("cuts at 1,500 characters without splitting an emoji", () => {
    expect(cutMessage("x".repeat(5_000))).toHaveLength(MESSAGE_MAX_CHARS);
    const emoji = `${"x".repeat(MESSAGE_MAX_CHARS - 1)}😀 tail`;
    expect(cutMessage(emoji)).toBe("x".repeat(MESSAGE_MAX_CHARS - 1));
    expect(clip("ab😀", 3)).toBe("ab");
    expect(clip("ab😀", 4)).toBe("ab😀");
  });
});

describe("one conversation's text", () => {
  it("is one line per message, skips empty ones, and stops at 6,000 characters", () => {
    expect(conversationText(["I'm vegetarian.", "```code```", "  Suggest\nplaces.  "])).toBe("I'm vegetarian.\nSuggest places.");
    const long = conversationText(Array.from({ length: 10 }, (_, index) => `${index}`.repeat(1_400)));
    expect(long).toHaveLength(CONVERSATION_MAX_CHARS);
    expect(long.split("\n")).toHaveLength(5);
    expect(long.split("\n").at(-1)).toHaveLength(CONVERSATION_MAX_CHARS - 4 * 1_401);
    expect(conversationText([])).toBe("");
  });
});

describe("pasted text", () => {
  it("is cut into pieces at line ends, and a very long line is cut where it must be", () => {
    expect(pastePieces("  one\r\ntwo\n\nthree  ")).toEqual(["one\ntwo\n\nthree"]);
    const lines = Array.from({ length: 30 }, (_, index) => `${index}:${"x".repeat(997)}`);
    const pieces = pastePieces(lines.join("\n"));
    expect(pieces.length).toBe(2);
    expect(pieces.every((piece) => piece.length <= PASTE_PIECE_CHARS)).toBe(true);
    expect(pieces.join("\n")).toBe(lines.join("\n"));
    expect(pastePieces("y".repeat(PASTE_PIECE_CHARS * 2 + 5)).map((piece) => piece.length)).toEqual([PASTE_PIECE_CHARS, PASTE_PIECE_CHARS, 5]);
    expect(pastePieces(" \n \n")).toEqual([]);
  });
});

describe("packing batches", () => {
  it("fills each batch up to about 24,000 characters, in order", () => {
    const size = 6_000 - HEADING_CHARS;
    expect(packBatches([size, size, size, size, size])).toEqual([[0, 1, 2, 3], [4]]);
    expect(packBatches([100, BATCH_MAX_CHARS * 2, 100])).toEqual([[0], [1], [2]]);
    expect(packBatches([])).toEqual([]);
    expect(packBatches([10, 10, 10], 2 * (10 + HEADING_CHARS))).toEqual([[0, 1], [2]]);
  });
});
