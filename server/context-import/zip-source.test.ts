// Reading an upload: a zip or a bare JSON file is told apart by its bytes,
// only conversation lists are read, an entry's name is never a path, an
// entry past the size limit or packed with an unknown method is refused and
// reported, and nothing is written next to the upload.
import { randomBytes } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deflateSync, strToU8, zipSync } from "fflate";

import { ExportReadError, readExport, REFUSED_MAX_LINES, setZipEntryMaxBytesForTests, ZIP_MAX_DIRECTORY_BYTES, ZIP_MAX_ENTRIES, ZIP_MAX_LISTS } from "./zip-source.ts";

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

// fflate's zipSync builds a zip in memory and chooses every header itself.
// The tests below need a 200 MB entry that the test never holds, and headers
// no ordinary writer produces, so this writes a zip to disk piece by piece.

/** One entry of a zip written by hand. */
interface Part {
  name: string;
  method: number;
  /** The entry's bytes as they sit in the zip, or how many blocks of filler to write in their place. */
  packed: Uint8Array | { blocks: number };
  unpacked: number;
  crc: number;
  /** Sizes after the data (a data descriptor), zeros in the header before it. */
  descriptor?: boolean;
  /** Sizes and place as 64-bit numbers in an extra field. */
  zip64?: boolean;
  /** Listed only: nothing is written for it, and the list says it is at this place in the file. */
  listedAt?: number;
}

const FILLER = randomBytes(65_535);
const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? strToU8(content) : content);
const stored = (name: string, content: string | Uint8Array): Part => {
  const raw = bytesOf(content);
  return { name, method: 0, packed: raw, unpacked: raw.length, crc: crc32(raw) };
};
const deflated = (name: string, content: string | Uint8Array): Part => {
  const raw = bytesOf(content);
  return { name, method: 8, packed: deflateSync(raw), unpacked: raw.length, crc: crc32(raw) };
};
/** About `megabytes` of bytes that do not compress, written a block at a time. */
const filler = (name: string, megabytes: number, method: number): Part => {
  const blocks = Math.ceil((megabytes * 1024 * 1024) / FILLER.length);
  let crc = 0;
  for (let block = 0; block < blocks; block += 1) crc = crc32(FILLER, crc);
  return { name, method, packed: { blocks }, unpacked: blocks * FILLER.length, crc };
};
/** An entry the list of contents claims and the file does not hold: the list puts it where no entry starts, so opening it would fail. */
const ghost = (name: string, megabytes: number): Part => ({ name, method: 0, packed: { blocks: megabytes * 16 }, unpacked: megabytes * 16 * FILLER.length, crc: 0, listedAt: 4 });

function writeZip(name: string, parts: Part[], opts: { zip64?: boolean; declare?: number } = {}): string {
  const path = join(scratch, name);
  const fd = openSync(path, "w");
  let at = 0;
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  const flush = () => {
    if (heldBytes) writeSync(fd, Buffer.concat(held));
    held = [];
    heldBytes = 0;
  };
  // small pieces are gathered into one write; a large one goes out as it is, so 200 MB of filler leaves nothing behind in memory
  const put = (...pieces: Uint8Array[]) => {
    for (const piece of pieces) {
      at += piece.length;
      if (piece.length < 32 * 1024) {
        held.push(piece);
        heldBytes += piece.length;
        continue;
      }
      flush();
      writeSync(fd, piece);
    }
    if (heldBytes > 1024 * 1024) flush();
  };
  const u64 = (...values: number[]) => {
    const out = Buffer.alloc(8 * values.length);
    values.forEach((value, index) => out.writeBigUInt64LE(BigInt(value), 8 * index));
    return out;
  };
  /** The zip64 extra field: id 1, then each number as 64 bits. */
  const extra64 = (...values: number[]) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(1, 0);
    head.writeUInt16LE(8 * values.length, 2);
    return Buffer.concat([head, u64(...values)]);
  };
  const directory: Uint8Array[] = [];
  for (const part of parts) {
    const nameBytes = Buffer.from(part.name);
    const offset = part.listedAt ?? at;
    // inside a deflate stream each block of filler is a "stored" block: five bytes, then the block as it is
    const framed = "blocks" in part.packed && part.method === 8 ? 5 : 0;
    const packed = "blocks" in part.packed ? part.packed.blocks * (FILLER.length + framed) + framed : part.packed.length;
    const flags = part.descriptor ? 8 : 0;
    const wide = part.zip64 ? 0xffffffff : undefined;
    if (part.listedAt === undefined) {
      const extra = part.zip64 ? extra64(part.unpacked, packed) : Buffer.alloc(0);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(part.zip64 ? 45 : 20, 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(part.method, 8);
      if (!part.descriptor) {
        header.writeUInt32LE(part.crc, 14);
        header.writeUInt32LE(wide ?? packed, 18);
        header.writeUInt32LE(wide ?? part.unpacked, 22);
      }
      header.writeUInt16LE(nameBytes.length, 26);
      header.writeUInt16LE(extra.length, 28);
      put(header, nameBytes, extra);
      if ("blocks" in part.packed) {
        for (let block = 0; block < part.packed.blocks; block += 1) {
          if (framed) put(Buffer.from([0x00, 0xff, 0xff, 0x00, 0x00]));
          put(FILLER);
        }
        if (framed) put(Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]));
      } else put(part.packed);
      if (part.descriptor) {
        const after = Buffer.alloc(16);
        after.writeUInt32LE(0x08074b50, 0);
        after.writeUInt32LE(part.crc, 4);
        after.writeUInt32LE(packed, 8);
        after.writeUInt32LE(part.unpacked, 12);
        put(after);
      }
    }
    const extra = part.zip64 ? extra64(part.unpacked, packed, offset) : Buffer.alloc(0);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(part.zip64 ? 45 : 20, 4);
    record.writeUInt16LE(part.zip64 ? 45 : 20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(part.method, 10);
    record.writeUInt32LE(part.crc, 16);
    record.writeUInt32LE(wide ?? packed, 20);
    record.writeUInt32LE(wide ?? part.unpacked, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(wide ?? offset, 42);
    directory.push(record, nameBytes, extra);
  }
  const start = at;
  for (const piece of directory) put(piece);
  const bytes = at - start;
  const count = opts.declare ?? parts.length;
  if (opts.zip64) {
    const record = Buffer.alloc(24);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(at), 8);
    locator.writeUInt32LE(1, 16);
    put(record, u64(count, count, bytes, start), locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // an old-style end record counts to 65,535 and wraps round past it
  end.writeUInt16LE(opts.zip64 ? 0xffff : count & 0xffff, 8);
  end.writeUInt16LE(opts.zip64 ? 0xffff : count & 0xffff, 10);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : bytes, 12);
  end.writeUInt32LE(opts.zip64 ? 0xffffffff : start, 16);
  put(end);
  flush();
  closeSync(fd);
  return path;
}

const used = () => {
  const memory = process.memoryUsage();
  return memory.heapUsed + memory.external + memory.arrayBuffers;
};

/** While `work` runs: the most memory in use, and the longest the event loop went without turning, in milliseconds. */
async function watch<T>(work: () => Promise<T>): Promise<{ result: T; peak: number; stall: number }> {
  let peak = used();
  let last = performance.now();
  let stall = 0;
  const sample = () => {
    peak = Math.max(peak, used());
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  };
  const timer = setInterval(sample, 2);
  try {
    const result = await work();
    sample();
    return { result, peak, stall };
  } finally {
    clearInterval(timer);
  }
}

describe("a zip entry the import does not read", () => {
  // The entry is 200 MB. A reader that goes through the zip front to back
  // holds all of it, on the scan and again on the read pass.
  const BOUND_MB = 32;

  it.each([
    ["stored", 0],
    ["deflated", 8],
    ["packed with a method that cannot be read here", 99],
  ])("costs no memory for its size, on the scan or on the read pass: %s", async (_how, method) => {
    const zip = writeZip("media.zip", [filler("media/video.mp4", 200, method), deflated("conversations.json", LIST)]);
    const baseline = used();
    const grew: number[] = [];
    // the import reads its upload twice: once to scan it, once to read what was picked
    for (const pass of ["scan", "read pass"]) {
      const { result, peak } = await watch(() => read(zip));
      expect(result.elements, pass).toEqual([{ id: "a" }, { id: "b" }]);
      expect(result.report, pass).toMatchObject({ entries: ["media/video.mp4", "conversations.json"], read: ["conversations.json"], refused: [] });
      grew.push(Math.round((peak - baseline) / 1024 / 1024));
    }
    expect(Math.max(...grew), `memory grew by ${grew[0]} MB on the scan and ${grew[1]} MB by the end of the read pass`).toBeLessThan(BOUND_MB);
  }, 120_000);
});

describe("a zip is read from its list of contents", () => {
  const big = JSON.stringify(Array.from({ length: 200 }, (_, index) => ({ id: index, text: "x".repeat(100) })));
  const DAMAGED = "That zip file is incomplete or damaged: its list of contents could not be read. Download the export again, or upload the conversations.json from inside it by itself.";
  /** Where a zip made by zipSync keeps its list of contents. */
  const directoryOf = (zip: Uint8Array) => Buffer.from(zip.buffer, zip.byteOffset, zip.length).readUInt32LE(zip.length - 6);

  it("refuses a zip that declares or holds more entries than the cap, quickly, and reads one at the cap", async () => {
    const declares = writeZip("declares.zip", [stored("conversations.json", LIST)], { zip64: true, declare: ZIP_MAX_ENTRIES + 1 });
    // the old-style end record of this one says 34,465; its list holds all 100,001
    const holds = writeZip("holds.zip", [stored("user.json", "{}"), ...Array.from({ length: ZIP_MAX_ENTRIES }, (_, index) => ghost(`media/${index}.png`, 1))]);
    // quickly by the processor's time, not the clock: on a busy machine every read of the file waits its turn
    const worked = () => {
      const { user, system } = process.cpuUsage();
      return (user + system) / 1000;
    };
    for (const zip of [declares, holds]) {
      const before = worked();
      const reading = read(zip);
      await expect(reading, zip).rejects.toThrow("That zip file holds more than 100,000 files, which is more than can be read here. Upload the conversations.json from inside it by itself.");
      await expect(reading, zip).rejects.toBeInstanceOf(ExportReadError);
      expect(worked() - before, zip).toBeLessThan(2_000);
    }
    const most = writeZip("most.zip", [deflated("conversations.json", LIST), ...Array.from({ length: ZIP_MAX_ENTRIES - 1 }, (_, index) => ghost(`media/${index}.png`, 1))]);
    expect((await read(most)).elements).toEqual([{ id: "a" }, { id: "b" }]);
  }, 120_000);

  it("refuses a zip whose list of contents is longer than it will walk, without walking it", async () => {
    expect(ZIP_MAX_DIRECTORY_BYTES).toBe(ZIP_MAX_ENTRIES * 1024);
    // A real list of one entry, then a gap that the end record counts as more of the list.
    // Walked, the gap would read as damage: being told it is too long shows it was not walked.
    const zip = Buffer.from(zipSync({ "conversations.json": strToU8(LIST) }));
    const end = zip.subarray(zip.length - 22);
    const gap = ZIP_MAX_DIRECTORY_BYTES;
    end.writeUInt32LE(end.readUInt32LE(12) + gap, 12);
    const path = join(scratch, "long-list.zip");
    const fd = openSync(path, "w");
    writeSync(fd, zip.subarray(0, zip.length - 22));
    writeSync(fd, end, 0, end.length, zip.length - 22 + gap);
    closeSync(fd);
    const reading = read(path);
    await expect(reading).rejects.toThrow("That zip file's list of contents is too long to be read here. Upload the conversations.json from inside it by itself.");
    await expect(reading).rejects.toBeInstanceOf(ExportReadError);
  });

  it("lists 20,000 entries it does not read without opening them, and without stalling the server", async () => {
    // each of these claims 512 MB at a place in the file where no entry starts
    const media = (from: number) => Array.from({ length: 10_000 }, (_, index) => ghost(`media/${from + index}.png`, 512));
    const zip = writeZip("many.zip", [stored("user.json", "{}"), ...media(0), deflated("conversations.json", LIST), ...media(10_000)]);
    // The best of three reads: a busy machine can hold any one of them up, and a reader that stalls would stall them all.
    const stalls: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const { result, stall } = await watch(() => read(zip));
      expect(result.elements).toEqual([{ id: "a" }, { id: "b" }]);
      expect(result.report).toMatchObject({ kind: "zip", read: ["conversations.json"], refused: [] });
      expect(result.report.entries).toHaveLength(500);
      expect(result.report.entries.slice(0, 3)).toEqual(["user.json", "media/0.png", "media/1.png"]);
      stalls.push(stall);
    }
    expect(Math.min(...stalls)).toBeLessThan(250);
  }, 120_000);

  it("lists at most 20 refused entries and counts the rest in one more line", async () => {
    const refused = Object.fromEntries(Array.from({ length: REFUSED_MAX_LINES + 5 }, (_, index) => [`part${index}/conversations.json`, strToU8('{"not":"a list"}')]));
    const { elements, report } = await read(file("refused.zip", zipSync({ ...refused, [`${"long/".repeat(40)}conversations.json`]: strToU8("{}"), "ok/conversations.json": strToU8(LIST) })));
    expect(REFUSED_MAX_LINES).toBe(20);
    expect(report.refused).toHaveLength(21);
    expect(report.refused[0]).toBe("part0/conversations.json: not a list of conversations");
    expect(report.refused[19]).toBe("part19/conversations.json: not a list of conversations");
    expect(report.refused[20]).toBe("6 more entries, not listed here");
    expect(report.read).toEqual(["ok/conversations.json"]);
    expect(elements).toEqual([{ id: "a" }, { id: "b" }]);
    // a long name is clipped where it is shown
    const long = await read(file("long.zip", zipSync({ [`${"long/".repeat(40)}conversations.json`]: strToU8("{}") })));
    expect(long.report.refused).toEqual([`${"long/".repeat(24)}: not a list of conversations`]);
  });

  it("says a zip cut off before or inside its list of contents is incomplete, not empty", async () => {
    const zip = zipSync({ "chat.html": strToU8("x".repeat(500)), "conversations.json": strToU8(LIST) });
    const directory = directoryOf(zip);
    const cuts: Array<[string, number]> = [["inside the first entry", 40], ["before the list of contents", directory], ["inside the list of contents", directory + 60], ["inside the end record", zip.length - 5]];
    for (const [where, bytes] of cuts) {
      const reading = read(file("cut.zip", zip.subarray(0, bytes)));
      await expect(reading, where).rejects.toThrow(DAMAGED);
      await expect(reading, where).rejects.toBeInstanceOf(ExportReadError);
      await expect(reading, where).rejects.toMatchObject({ name: "ExportReadError" });
    }
    // whole, with a list of contents that does not hold together
    const damaged = Uint8Array.from(zip);
    damaged[directory + 46 + "chat.html".length] = 0;
    await expect(read(file("damaged-list.zip", damaged))).rejects.toThrow(DAMAGED);
    // Cut off after an attachment that is itself a zip (a .docx is one): the end of the attachment is not the end of the upload.
    const attachment = zipSync({ "word/document.xml": strToU8("<w:document/>") });
    const withAttachment = zipSync({ "conversations.json": strToU8(LIST), "file-1.docx": [attachment, { level: 0 }], "audio.wav": [strToU8("x".repeat(5_000)), { level: 0 }] });
    await expect(read(file("cut-after-attachment.zip", withAttachment.subarray(0, directoryOf(withAttachment) - 2_000)))).rejects.toThrow(DAMAGED);
    // a zip with nothing in it is whole: it is empty, not damaged
    expect((await read(file("nothing.zip", zipSync({})))).report).toEqual({ kind: "zip", entries: [], read: [], refused: [], unparseable: 0, oversized: 0, truncated: false });
  });

  it("refuses one part of a split zip", async () => {
    const zip = zipSync({ "conversations.json": strToU8(LIST) });
    zip[zip.length - 22 + 4] = 1; // "this is disk 1", counted from 0
    const reading = read(file("split.zip", zip));
    await expect(reading).rejects.toThrow("That zip file is one part of a zip that was split into several files, which cannot be read here. Upload the conversations.json from inside it by itself.");
    await expect(reading).rejects.toBeInstanceOf(ExportReadError);
  });

  it("never reads part of a bare file: past a limit that was asked for it hands over nothing, and with none it is read whole", async () => {
    // several reads long: a reader that only counts as it goes has handed over the start of it before it notices
    const long = JSON.stringify(Array.from({ length: 3_000 }, (_, index) => ({ id: index, text: "x".repeat(100) })));
    const limited = await read(file("long.json", long), { entryMaxBytes: 100_000 });
    expect(limited.elements).toEqual([]);
    expect(limited.report).toMatchObject({ kind: "json", read: [], refused: ["conversations.json: larger than 0 GB once unpacked"] });
    expect((await read(file("fits.json", long), { entryMaxBytes: Buffer.byteLength(long) })).elements).toHaveLength(3_000);

    setZipEntryMaxBytesForTests(4_096);
    try {
      // the lowered limit is in force for a zip's entries ...
      expect((await read(file("big.zip", zipSync({ "conversations.json": strToU8(big) })))).report).toMatchObject({ read: [], refused: ["conversations.json: larger than 0 GB once unpacked"] });
      // ... and is no limit on a bare file, which the upload limit already bounds
      const whole = await read(file("whole.json", big));
      expect(whole.elements).toHaveLength(200);
      expect(whole.report).toMatchObject({ kind: "json", read: ["conversations.json"], refused: [], truncated: false });
    } finally {
      setZipEntryMaxBytesForTests();
    }
    // back to 2 GB
    expect((await read(file("again.zip", zipSync({ "conversations.json": strToU8(big) })))).elements).toHaveLength(200);
  });

  it("counts an entry as it unpacks when its header and the list of contents both lie about its size", async () => {
    const zip = zipSync({ "conversations.json": strToU8(big), "b/conversations.json": strToU8(LIST) });
    zip.set([10, 0, 0, 0], 22);
    zip.set([10, 0, 0, 0], directoryOf(zip) + 24);
    const { elements, report } = await read(file("lying.zip", zip), { entryMaxBytes: 4_096 });
    expect(report).toMatchObject({ read: ["b/conversations.json"], refused: ["conversations.json: larger than 0 GB once unpacked"] });
    expect(elements.length).toBeLessThan(200);
    expect(elements.slice(-2)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("refuses an entry locked with a password, and one whose header and the list of contents disagree, and reads the others", async () => {
    const reason = async (change: (zip: Uint8Array, directory: number) => void) => {
      const zip = zipSync({ "conversations.json": [strToU8(JSON.stringify([{ id: "first" }])), { level: 0 }], "b/conversations.json": strToU8(LIST) });
      change(zip, directoryOf(zip));
      const { elements, report } = await read(file("changed.zip", zip));
      expect(report.read).toEqual(["b/conversations.json"]);
      expect(elements).toEqual([{ id: "a" }, { id: "b" }]);
      expect(report.refused).toHaveLength(1);
      return report.refused[0];
    };
    const locked = "conversations.json: locked with a password, so it cannot be read here; upload conversations.json by itself";
    expect(await reason((zip) => { zip[6]! |= 1; })).toBe(locked);
    expect(await reason((zip, directory) => { zip[directory + 8]! |= 1; })).toBe(locked);
    // a method that cannot be read, named only by the list of contents
    expect(await reason((zip, directory) => { zip[directory + 10] = 14; })).toBe("conversations.json: packed in a way that cannot be read here (method 14); upload conversations.json by itself");
    // stored by its header, deflated by the list
    expect(await reason((zip, directory) => { zip[directory + 10] = 8; })).toBe("conversations.json: could not be unpacked");
    // the header at that place belongs to an entry of another name
    expect(await reason((zip) => { zip[30] = 0x58; })).toBe("conversations.json: could not be unpacked");
    // two packed sizes
    expect(await reason((zip) => { zip.set([5, 0, 0, 0], 18); })).toBe("conversations.json: could not be unpacked");
    // the list points past the end of the entries
    expect(await reason((zip, directory) => { zip.set([0xf0, 0xff, 0xff, 0x7f], directory + 42); })).toBe("conversations.json: could not be unpacked");
  });

  it("reads entries whose sizes come after their data, entries with 64-bit sizes, and in the order of the list", async () => {
    const more = JSON.stringify([{ id: "c" }]);
    const late = await read(writeZip("descriptor.zip", [{ ...deflated("conversations.json", LIST), descriptor: true }, { ...stored("more/conversations-2.json", more), descriptor: true }]));
    expect(late.elements).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(late.report).toMatchObject({ read: ["conversations.json", "more/conversations-2.json"], refused: [] });

    const wide = await read(writeZip("zip64.zip", [{ ...stored("chat.html", "<html>"), zip64: true }, { ...deflated("conversations.json", LIST), zip64: true }, { ...stored("more/conversations-2.json", more), zip64: true }], { zip64: true }));
    expect(wide.elements).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(wide.report).toMatchObject({ entries: ["chat.html", "conversations.json", "more/conversations-2.json"], read: ["conversations.json", "more/conversations-2.json"], refused: [] });

    // an entry that says its sizes are 64-bit and does not give them
    const zip = zipSync({ "conversations.json": strToU8(LIST), "b/conversations.json": strToU8(more) });
    zip.set([0xff, 0xff, 0xff, 0xff], directoryOf(zip) + 20);
    expect((await read(file("no-sizes.zip", zip))).report).toMatchObject({ read: ["b/conversations.json"], refused: ["conversations.json: could not be unpacked"] });
  });

  it("finds the list of contents of a zip with data in front of it and a comment after it", async () => {
    const zip = Buffer.from(zipSync({ "chat.html": strToU8("x"), "conversations.json": strToU8(LIST) }));
    // the comment holds the four bytes an end record starts with, twice
    const comment = Buffer.from("made by hand; PK\x05\x06 is not where this zip ends, whatever it looks like, and neither is PK\x05\x06");
    zip.writeUInt16LE(comment.length, zip.length - 2);
    const commented = await read(file("comment.zip", Buffer.concat([zip, comment])));
    expect(commented.elements).toEqual([{ id: "a" }, { id: "b" }]);
    expect(commented.report).toMatchObject({ kind: "zip", entries: ["chat.html", "conversations.json"], read: ["conversations.json"], refused: [] });
    // the marker of a zip made in parts, then bytes that are not an entry: every place the zip gives is short by this much
    const front = Buffer.concat([Buffer.from("PK\x07\x08"), Buffer.alloc(5_000, 0x20)]);
    const fronted = await read(file("front.zip", Buffer.concat([front, zip, comment])));
    expect(fronted.elements).toEqual([{ id: "a" }, { id: "b" }]);
    expect(fronted.report).toMatchObject({ kind: "zip", entries: ["chat.html", "conversations.json"], read: ["conversations.json"], refused: [] });
  });

  it("reads lists that span many chunks of the zip, however they are packed", async () => {
    // text that does not compress, so the packed list is megabytes too
    const list = Array.from({ length: 600 }, (_, index) => ({ id: index, text: randomBytes(1_500).toString("base64") }));
    const raw = strToU8(JSON.stringify(list));
    // deflate that packs nothing: whole blocks of 64 KiB, each giving nothing out until all of it is in
    const blocks = deflateRawSync(raw, { level: 0 });
    expect(blocks.length).toBeGreaterThan(raw.length);
    const inBlocks: Part = { name: "conversations.json", method: 8, packed: blocks, unpacked: raw.length, crc: crc32(raw) };
    for (const part of [deflated("conversations.json", raw), stored("conversations.json", raw), inBlocks]) {
      const { elements, report } = await read(writeZip("long-list.zip", [stored("chat.html", "x"), part]));
      expect(report).toMatchObject({ read: ["conversations.json"], refused: [], unparseable: 0, truncated: false });
      expect(elements).toEqual(list);
    }
  }, 120_000);

  it("does not unpack the same bytes again for every line of a list that points at them", async () => {
    const one = deflated("conversations.json", LIST);
    // one entry in the file, and a list of contents that names it sixty times
    const { elements, report } = await read(writeZip("again.zip", [one, ...Array.from({ length: 59 }, () => ({ ...one, listedAt: 0 }))]));
    expect(report.entries).toHaveLength(60);
    // the entries of a zip sit side by side: together they are never larger than the file in front of its list
    expect(report.read).toEqual(["conversations.json"]);
    expect(elements).toEqual([{ id: "a" }, { id: "b" }]);
    expect(report.refused).toHaveLength(REFUSED_MAX_LINES + 1);
    expect(report.refused[0]).toBe("conversations.json: could not be unpacked");
    expect(report.refused.at(-1)).toBe("39 more entries, not listed here");
  });

  it("gives up on packed data that stops unpacking, rather than holding the rest of it", async () => {
    // a whole deflate stream, then a megabyte that the entry also claims as its own
    const packed = Buffer.concat([deflateSync(strToU8(LIST)), Buffer.alloc(1024 * 1024)]);
    const zip = writeZip("tail.zip", [{ name: "conversations.json", method: 8, packed, unpacked: LIST.length, crc: crc32(LIST) }, deflated("b/conversations.json", JSON.stringify([{ id: "c" }]))]);
    const { elements, report } = await read(zip);
    expect(report).toMatchObject({ read: ["b/conversations.json"], refused: ["conversations.json: could not be unpacked"] });
    expect(elements.at(-1)).toEqual({ id: "c" });
  });

  it("lets an error from the caller through as it is, from a stored entry and from a deflated one", async () => {
    for (const level of [0, 6] as const) {
      const zip = file("throws.zip", zipSync({ "conversations.json": [strToU8(LIST), { level }] }));
      await expect(readExport(zip, () => { throw new RangeError("the caller's own"); })).rejects.toThrow(RangeError);
    }
  });

  it("stops at once when cancelled while it walks a long list of contents", async () => {
    const zip = writeZip("long.zip", [stored("user.json", "{}"), ...Array.from({ length: 60_000 }, (_, index) => ghost(`media/${index}.png`, 1))]);
    // a signal that counts the looks at it, and is cancelled from the look it is told
    const signalThat = (cancelsOn: number) => {
      const counted = {
        looks: 0,
        signal: { get aborted() { counted.looks += 1; return counted.looks >= cancelsOn; } } as AbortSignal,
      };
      return counted;
    };
    // the list is looked at piece by piece, some fifty times in all ...
    const never = signalThat(Infinity);
    await read(zip, { signal: never.signal });
    expect(never.looks).toBeGreaterThan(40);
    // ... so the twentieth look is well inside it, and is the last
    const midway = signalThat(20);
    await expect(read(zip, { signal: midway.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(midway.looks).toBe(20);
  }, 120_000);

  it("opens a bounded number of conversation lists, however many a zip names, and says how many it left", async () => {
    // a real export has one list, or a few numbered parts; a crafted one can name a hundred thousand
    const many: Record<string, Uint8Array> = {};
    for (let index = 0; index < 1_005; index += 1) many[`part-${index}/conversations.json`] = strToU8(`[{"id":${index}}]`);
    const { elements, report } = await read(file("many-lists.zip", zipSync(many, { level: 0 })));
    expect(ZIP_MAX_LISTS).toBe(1_000);
    expect(elements).toHaveLength(ZIP_MAX_LISTS);
    expect(report.read).toHaveLength(ZIP_MAX_LISTS);
    expect(elements.at(-1)).toEqual({ id: 999 });
    expect(report.refused).toEqual(["5 more conversation lists than the 1,000 one import reads: not read"]);
  });
});
