// The scan: counts, the date range, the default slice, the estimate, and
// that nothing of an unknown shape fails it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chatGptConversation, claudeConversation, sampleConversations, writeExportJson, writeExportZip } from "../testing/context-import-fixtures.ts";
import { clampSlice, conversationHash, estimateSlice, proposeSlice, scanExport, scanPaste, selectSlice, type ScanRow } from "./scan.ts";

const NOW = Date.UTC(2026, 9, 10, 12);
const DAY = 86_400_000;
let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "omb-scan-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("scanning an export", () => {
  it("counts conversations, the person's characters and the date range of a ChatGPT zip", async () => {
    const sample = sampleConversations(NOW);
    const path = join(scratch, "export.zip");
    writeExportZip(path, [
      ...sample.map(chatGptConversation),
      chatGptConversation({ id: "conv-empty", title: "Assistant only", updatedAt: NOW - DAY, messages: [] }),
      { title: "No mapping here", weird: true },
      "a string",
      7,
    ]);
    const { summary, rows, unknownShapes } = await scanExport(path);
    expect(summary).toEqual({
      format: "chatgpt", conversations: 4, withOwnMessages: 3, oldest: NOW - 500 * DAY, newest: NOW - DAY,
      ownChars: sample.flatMap((conversation) => conversation.messages).reduce((total, message) => total + message.length, 0),
      alreadyRead: 0, skipped: { conversations: 3, messages: 0, oversized: 0, entries: [] }, truncated: false,
    });
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.hash === conversationHash({ id: "conv-empty", title: "", updatedAt: NOW - DAY }))).toMatchObject({ chars: 0 });
    // the snippet in the Launch plan conversation is dropped before counting what would be sent
    expect(rows.find((row) => row.hash === conversationHash({ id: "conv-work", title: "", updatedAt: NOW - 40 * DAY }))!.chars)
      .toBe("I run a two-person company called Supamaus. We ship on Fridays.\nReview this snippet.".length);
    expect(unknownShapes).toEqual({ "title,weird": 1, "(string)": 1, "(number)": 1 });
    expect(JSON.stringify({ summary, rows, unknownShapes })).not.toContain("vegetarian");
  });

  it("tells a Claude export by its shape, counts a repeated conversation once, and marks what was read before", async () => {
    const sample = sampleConversations(NOW);
    const path = join(scratch, "anything.bin");
    writeExportJson(path, [...sample.map(claudeConversation), claudeConversation(sample[0]!)]);
    const read = new Set([conversationHash({ id: "conv-food", title: "", updatedAt: NOW - 2 * DAY })]);
    const { summary, rows } = await scanExport(path, { alreadyRead: read });
    expect(summary).toMatchObject({ format: "claude", conversations: 3, withOwnMessages: 3, alreadyRead: 1 });
    expect(rows).toHaveLength(3);
  });

  it("reports a file with nothing it knows instead of failing", async () => {
    const path = join(scratch, "notes.json");
    writeExportJson(path, [{ hello: "world" }]);
    expect((await scanExport(path)).summary).toMatchObject({ format: "unknown", conversations: 0, skipped: { conversations: 1 } });
  });

  it("reads pasted text as pieces, with no hashes", () => {
    const { summary, rows } = scanPaste("- I am vegetarian\n- I live in Pune\n", NOW);
    expect(summary).toMatchObject({ format: "paste", conversations: 1, ownChars: 35, oldest: NOW, newest: NOW });
    expect(rows).toEqual([{ hash: "", updatedAt: NOW, chars: 34 }]);
    expect(scanPaste("   ", NOW).rows).toEqual([]);
  });
});

describe("the slice and the estimate", () => {
  const row = (hash: string, daysAgo: number, chars = 1_000): ScanRow => ({ hash, updatedAt: NOW - daysAgo * DAY, chars });

  it("proposes the last 12 months and at most 500 conversations, newest first", () => {
    const rows = [row("old", 500), row("recent", 10), row("mid", 200), row("empty", 5, 0), { hash: "undated", updatedAt: 0, chars: 50 }];
    const slice = proposeSlice(rows, NOW);
    expect(slice).toEqual({ from: Date.UTC(2025, 9, 10, 12), to: NOW, cap: 500 });
    expect(selectSlice(rows, slice).map((entry) => entry.hash)).toEqual(["recent", "mid", "undated"]);
    expect(selectSlice(rows, { ...slice, cap: 1 }).map((entry) => entry.hash)).toEqual(["recent"]);
    expect(selectSlice(rows, { from: 0, to: NOW, cap: 500 }).map((entry) => entry.hash)).toEqual(["recent", "mid", "old", "undated"]);
    const many = Array.from({ length: 700 }, (_, index) => row(`c${index}`, index % 300));
    expect(selectSlice(many, proposeSlice(many, NOW))).toHaveLength(500);
  });

  it("leaves out what an earlier import read, and moves the range back when only older ones remain", () => {
    const rows = [row("recent", 10), row("mid", 200), row("old", 500), row("older", 700)];
    const read = new Set(["recent"]);
    // a newer export: the range stays, the conversation already read is left out
    expect(selectSlice(rows, proposeSlice(rows, NOW, read), read).map((entry) => entry.hash)).toEqual(["mid"]);
    // read more: everything recent was read, so the range ends at the newest one that was not
    const more = proposeSlice(rows, NOW, new Set(["recent", "mid"]));
    expect(more.to).toBe(NOW - 500 * DAY);
    expect(selectSlice(rows, more, new Set(["recent", "mid"])).map((entry) => entry.hash)).toEqual(["old", "older"]);
    // nothing left at all: the default range, which then selects nothing
    expect(selectSlice(rows, proposeSlice(rows, NOW, new Set(["recent", "mid", "old", "older"])), new Set(["recent", "mid", "old", "older"]))).toEqual([]);
  });

  it("holds a requested slice to a whole range and a cap between 1 and 2,000", () => {
    const fallback = { from: 100, to: 200, cap: 500 };
    expect(clampSlice({}, fallback)).toEqual(fallback);
    expect(clampSlice({ from: 150, cap: 99_999 }, fallback)).toEqual({ from: 150, to: 200, cap: 2_000 });
    expect(clampSlice({ from: 300, to: 10, cap: 0 }, fallback)).toEqual({ from: 300, to: 300, cap: 1 });
    expect(clampSlice({ from: Number.NaN, to: -5, cap: 2.6 }, fallback)).toEqual({ from: 100, to: 100, cap: 3 });
  });

  it("estimates one call per batch of about 24,000 characters, plus the conflict check", () => {
    expect(estimateSlice([])).toEqual({ conversations: 0, chars: 0, calls: 0, minSeconds: 0, maxSeconds: 0 });
    const ten = Array.from({ length: 10 }, (_, index) => row(`c${index}`, index, 5_880));
    expect(estimateSlice(ten)).toEqual({ conversations: 10, chars: 58_800, calls: 4, minSeconds: 40, maxSeconds: 188 });
  });
});
