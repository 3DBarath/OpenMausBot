// Reading an upload: a zip or a bare JSON file is told apart by its bytes,
// only conversation lists are read, an entry's name is never a path, an
// entry past the size limit or packed with an unknown method is refused and
// reported, and nothing is written next to the upload.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { readExport } from "./zip-source.ts";

let scratch: string;
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "omb-zip-source-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function file(name: string, bytes: Uint8Array | string): string {
  const path = join(scratch, name);
  writeFileSync(path, bytes);
  return path;
}

async function read(path: string, opts: { entryMaxBytes?: number; signal?: AbortSignal } = {}) {
  const elements: unknown[] = [];
  const report = await readExport(path, (value) => elements.push(value), opts);
  return { elements, report };
}

const LIST = JSON.stringify([{ id: "a" }, { id: "b" }]);

describe("reading an uploaded export", () => {
  it("reads a bare conversations.json whatever it is called", async () => {
    const { elements, report } = await read(file("upload.bin", LIST));
    expect(elements).toEqual([{ id: "a" }, { id: "b" }]);
    expect(report).toEqual({ kind: "json", entries: [], read: ["conversations.json"], refused: [], unparseable: 0, oversized: 0, truncated: false });
  });

  it("reads only the conversation lists of a zip, in any folder, and numbered parts", async () => {
    const zip = zipSync({
      "chat.html": strToU8("<html>[not read]</html>"),
      "user.json": strToU8('[{"id":"not a conversation list"}]'),
      "conversations.json": strToU8(LIST),
      "export/conversations-001.json": strToU8(JSON.stringify([{ id: "c" }])),
      "my-conversations.json": strToU8(JSON.stringify([{ id: "wrong name" }])),
    });
    const { elements, report } = await read(file("export.zip", zip));
    expect(elements).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(report).toMatchObject({ kind: "zip", read: ["conversations.json", "export/conversations-001.json"], refused: [] });
    expect(report.entries).toEqual(["chat.html", "user.json", "conversations.json", "export/conversations-001.json", "my-conversations.json"]);
  });

  it("treats a name that climbs out of the folder as a name: it is read, and nothing is written", async () => {
    const zip = zipSync({
      "../../conversations.json": strToU8(JSON.stringify([{ id: "climber" }])),
      "/etc/conversations.json": strToU8(JSON.stringify([{ id: "absolute" }])),
      "..\\..\\conversations.json": strToU8(JSON.stringify([{ id: "backslash" }])),
    });
    const { elements } = await read(file("evil.zip", zip));
    expect(elements).toEqual([{ id: "climber" }, { id: "absolute" }, { id: "backslash" }]);
    expect(readdirSync(scratch)).toEqual(["evil.zip"]);
    expect(readdirSync(join(scratch, ".."))).not.toContain("conversations.json");
  });

  it("refuses an entry larger than the limit once unpacked, and still reads the others", async () => {
    const big = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ id: index, text: "x".repeat(100) })));
    const zip = zipSync({ "a/conversations.json": strToU8(big), "b/conversations.json": strToU8(LIST) });
    const { elements, report } = await read(file("big.zip", zip), { entryMaxBytes: 4_096 });
    expect(report.refused).toEqual(["a/conversations.json: larger than 0 GB once unpacked"]);
    expect(report.read).toEqual(["b/conversations.json"]);
    expect(elements.slice(-2)).toEqual([{ id: "a" }, { id: "b" }]);
    // the declared size is not trusted: a header that claims 10 bytes is still counted as it unpacks
    const lying = zipSync({ "conversations.json": strToU8(big) });
    lying.set([10, 0, 0, 0], 22);
    const counted = await read(file("lying.zip", lying), { entryMaxBytes: 4_096 });
    expect(counted.report).toMatchObject({ read: [], refused: ["conversations.json: larger than 0 GB once unpacked"] });
    expect(counted.elements.length).toBeLessThan(200);
    // and a bare file is counted the same way
    expect((await read(file("big.json", big), { entryMaxBytes: 4_096 })).report.refused).toEqual(["conversations.json: larger than 0 GB once unpacked"]);
  });

  it("reports an entry that is not a list, one packed with an unknown method, and a damaged one", async () => {
    const notAList = zipSync({ "conversations.json": strToU8('{"conversations": []}') });
    expect((await read(file("object.zip", notAList))).report).toMatchObject({ read: [], refused: ["conversations.json: not a list of conversations"] });

    const stored = zipSync({ "conversations.json": [strToU8(LIST), { level: 0 }] });
    stored[8] = 9; // the local header's method: Deflate64, which Windows uses for large files
    const unknown = await read(file("deflate64.zip", stored));
    expect(unknown.elements).toEqual([]);
    expect(unknown.report.refused[0]).toMatch(/^conversations\.json: packed in a way that cannot be read here \(method 9\)/);

    const damaged = zipSync({ "conversations.json": strToU8(JSON.stringify(Array.from({ length: 50 }, (_, index) => ({ id: index, text: "y".repeat(40) })))) });
    damaged.fill(0xff, 60, 90);
    const broken = await read(file("damaged.zip", damaged));
    expect(broken.report.read).toEqual([]);
    expect(broken.report.refused).toEqual(["conversations.json: could not be unpacked"]);
  });

  it("counts an element that is not valid JSON, reports a cut-off list, and finds nothing in a zip without one", async () => {
    const { elements, report } = await read(file("odd.json", '[{"id":"a"}, {"id": nope}, {"id":"c"}, {"id":'));
    expect(elements).toEqual([{ id: "a" }, { id: "c" }]);
    expect(report).toMatchObject({ unparseable: 1, truncated: true });
    expect((await read(file("html.json", "<html>"))).report).toMatchObject({ read: [], refused: ["conversations.json: not a list of conversations"] });
    expect((await read(file("empty.zip", zipSync({ "chat.html": strToU8("x") })))).report).toMatchObject({ kind: "zip", read: [], refused: [] });
  });

  it("stops when the read is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(read(file("list.json", LIST), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
