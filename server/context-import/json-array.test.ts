// The list splitter: every element comes out whole however the bytes are
// cut, structure inside strings is ignored, an oversized element is skipped
// and counted, and a 512 MB list is read in a fixed amount of memory.
import { closeSync, createReadStream, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createArraySplitter, NotAListError } from "./json-array.ts";

function split(text: string | Uint8Array, chunkBytes: number, maxElementBytes?: number) {
  const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
  const elements: unknown[] = [];
  let oversized = 0;
  const splitter = createArraySplitter({
    onElement: (element) => elements.push(JSON.parse(element.toString("utf8"))),
    onOversized: () => { oversized += 1; },
    ...(maxElementBytes ? { maxElementBytes } : {}),
  });
  for (let at = 0; at < bytes.length; at += chunkBytes) splitter.push(bytes.subarray(at, at + chunkBytes));
  return { elements, oversized, closed: splitter.closed() };
}

const TRICKY = [
  { title: "brackets ] } [ { in a string", text: "a \"quoted\" word, a backslash \\ and an escaped quote at the end\\\"" },
  { nested: [[1, [2, { deep: "]" }]], {}], emoji: "नमस्ते 👋 ünïcödé", empty: "" },
  "a bare string, with ] and , inside",
  42, -1.5e3, true, null,
  [1, 2, [3]],
  {},
];

describe("splitting a JSON list", () => {
  it("returns every element whole at every chunk size, including one byte at a time", () => {
    const text = `\n  ${JSON.stringify(TRICKY, null, 2)}\n`;
    for (const chunkBytes of [1, 2, 3, 7, 64, 100_000]) {
      expect(split(text, chunkBytes), `chunks of ${chunkBytes}`).toEqual({ elements: TRICKY, oversized: 0, closed: true });
    }
    expect(split(JSON.stringify(TRICKY), 5).elements).toEqual(TRICKY);
  });

  it("reads an empty list, skips a byte order mark and ignores what follows the list", () => {
    expect(split("[]", 1)).toEqual({ elements: [], oversized: 0, closed: true });
    expect(split(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[{"a":1}]')]), 2).elements).toEqual([{ a: 1 }]);
    expect(split('[{"a":1}] trailing {"b":2}', 4)).toEqual({ elements: [{ a: 1 }], oversized: 0, closed: true });
  });

  it("refuses text that is not a list, and reports a list that never closes", () => {
    expect(() => split('{"conversations": []}', 8)).toThrowError(NotAListError);
    expect(() => split("<html>", 8)).toThrowError(NotAListError);
    expect(split('[{"a":1},{"b":', 3)).toEqual({ elements: [{ a: 1 }], oversized: 0, closed: false });
  });

  it("skips and counts an element past the size limit and keeps going", () => {
    const text = JSON.stringify([{ small: 1 }, { big: "x".repeat(5_000) }, { small: 2 }]);
    for (const chunkBytes of [16, 100_000]) {
      expect(split(text, chunkBytes, 1_000), `chunks of ${chunkBytes}`).toEqual({ elements: [{ small: 1 }, { small: 2 }], oversized: 1, closed: true });
    }
  });

  it("reads a 512 MB list of conversations without holding it", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-json-array-"));
    const path = join(scratch, "conversations.json");
    try {
      const one = JSON.stringify({ id: "c", title: "Synthetic", update_time: 1_700_000_000, mapping: { a: { message: { author: { role: "user" }, content: { content_type: "text", parts: [`${"x".repeat(48_000)} "quoted" {brace} [bracket] \\ end`] } } } } });
      const block = Buffer.from(`${one},`.repeat(20));
      const fd = openSync(path, "w");
      let written = writeSync(fd, "[");
      let expected = 0;
      while (written < 512 * 1024 * 1024) {
        written += writeSync(fd, block);
        expected += 20;
      }
      writeSync(fd, `${one}]`);
      expected += 1;
      closeSync(fd);

      const used = () => {
        const memory = process.memoryUsage();
        return memory.heapUsed + memory.arrayBuffers;
      };
      const baseline = used();
      let elements = 0;
      let peak = 0;
      const splitter = createArraySplitter({
        onElement: (bytes) => {
          JSON.parse(bytes.toString("utf8"));
          elements += 1;
          if (elements % 50 === 0) peak = Math.max(peak, used());
        },
        onOversized: () => { throw new Error("unexpected oversized element"); },
      });
      for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) splitter.push(chunk as Buffer);
      expect(splitter.closed()).toBe(true);
      expect(elements).toBe(expected);
      // The file is 512 MB; holding it, or its parsed form, would pass this many times over.
      expect(peak - baseline).toBeLessThan(128 * 1024 * 1024);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);

  it("passes over a long run of whitespace quickly, wherever it is", () => {
    // 192 MB of spaces and line breaks around three small elements: nothing to keep, so nothing to dwell on
    const blank = Buffer.alloc(8 * 1024 * 1024, " \n\t\r");
    const elements: unknown[] = [];
    const splitter = createArraySplitter({ onElement: (element) => elements.push(JSON.parse(element.toString("utf8"))), onOversized: () => undefined });
    const started = process.cpuUsage();
    splitter.push(Buffer.from("["));
    for (let piece = 0; piece < 8; piece += 1) splitter.push(blank);
    splitter.push(Buffer.from('{"a":1},'));
    for (let piece = 0; piece < 8; piece += 1) splitter.push(blank);
    splitter.push(Buffer.from('"two" ,'));
    for (let piece = 0; piece < 8; piece += 1) splitter.push(blank);
    splitter.push(Buffer.from("3 ]"));
    const spent = process.cpuUsage(started);
    expect(elements).toEqual([{ a: 1 }, "two", 3]);
    expect(splitter.closed()).toBe(true);
    // processor time, so a busy machine does not decide: a quarter of a second for 192 MB
    expect((spent.user + spent.system) / 1000).toBeLessThan(250);
  });
});
