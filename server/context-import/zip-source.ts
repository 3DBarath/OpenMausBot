// Open an uploaded export, a zip or a bare conversations.json, and hand over
// each element of each conversation list in it, parsed, one at a time.
// Nothing is ever written to disk: an entry's name only decides whether the
// entry is read, so a name that climbs out of a folder is just a name.
//
// A zip is read from its list of contents, the directory at its end, and
// never front to back. The list is walked in small pieces, and only the
// conversation lists are then opened, each at the place the list gives for
// it and each a small chunk at a time (fflate does the inflating). An entry
// that is not read costs the walk past its line in the list and nothing
// more, however large it is. Sizes are counted as the bytes come out,
// whatever a header declares.
//
// A problem with one entry is a line in the report, and the other entries
// are still read. A problem with the file as a whole (a zip whose list of
// contents is missing, damaged or far too long, or one part of a split zip)
// is thrown as an ExportReadError, with a message written for the person.
// A read error or a cancel also ends the read early.
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Inflate } from "fflate";

import { createArraySplitter, NotAListError } from "./json-array.ts";

/** An entry of a zip larger than this once unpacked is refused. A bare file
 * has no limit of its own: the upload limit already bounds it. */
export const ENTRY_MAX_BYTES = 2 * 1024 ** 3;
/** A zip that lists more entries than this is refused whole. */
export const ZIP_MAX_ENTRIES = 100_000;
/** The longest list of contents that is walked: a kilobyte for each entry allowed. */
export const ZIP_MAX_DIRECTORY_BYTES = ZIP_MAX_ENTRIES * 1024;
/** At most this many conversation lists of one zip are opened. A real export
 * has one, or a few numbered parts; the rest of a zip that names more are
 * counted and left. */
export const ZIP_MAX_LISTS = 1_000;
/** All the conversation lists of one zip together may unpack to this many
 * times the limit for one: packed whitespace unpacks a thousandfold, and
 * without this a zip of a few megabytes could keep a read busy for hours. */
export const ZIP_UNPACKED_ENTRIES = 4;
/** Refused entries are listed up to this many; one more line counts the rest. */
export const REFUSED_MAX_LINES = 20;
/** The conversation lists an export carries: conversations.json, or numbered
 * parts of it, in any folder. Every other entry is skipped unread. */
const KNOWN_ENTRY = /(?:^|[\\/])conversations(?:-\d+)?\.json$/i;
/** Small reads bound how much one chunk of a zip can unpack to at once. */
const ZIP_READ_BYTES = 16 * 1024;
/** …and smaller ones, down to this, while one read unpacks to more than a step should hold. */
const ZIP_READ_MIN_BYTES = 512;
const STEP_UNPACKED_BYTES = 1024 * 1024;
const JSON_READ_BYTES = 64 * 1024;
/** The list of contents is read this much at a time. */
const DIRECTORY_READ_BYTES = 64 * 1024;
/** Packed data that takes in this much and gives nothing out has ended early
 * or never will end: a deflate stream waits on one block of 64 KiB at most. */
const INFLATE_IDLE_BYTES = 128 * 1024;

// The parts of a zip, by the four bytes each starts with, and their fixed lengths.
const LOCAL_HEADER = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const DIRECTORY_RECORD = 0x02014b50;
const DIRECTORY_RECORD_BYTES = 46;
const END_RECORD = 0x06054b50;
const END_RECORD_BYTES = 22;
const ZIP64_END_RECORD = 0x06064b50;
const ZIP64_END_RECORD_BYTES = 56;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
/** A 16- or 32-bit field holding this says the number is kept as 64 bits elsewhere. */
const WIDE16 = 0xffff;
const WIDE32 = 0xffffffff;

/** A problem with the upload as a whole. The message is for the person: what is wrong, and what to do. */
export class ExportReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportReadError";
  }
}

const BY_ITSELF = "Upload the conversations.json from inside it by itself.";
const DAMAGED = "That zip file is incomplete or damaged: its list of contents could not be read. Download the export again, or upload the conversations.json from inside it by itself.";
const TOO_MANY = `That zip file holds more than ${ZIP_MAX_ENTRIES.toLocaleString("en-US")} files, which is more than can be read here. ${BY_ITSELF}`;
const TOO_LONG = `That zip file's list of contents is too long to be read here. ${BY_ITSELF}`;
const SPLIT = `That zip file is one part of a zip that was split into several files, which cannot be read here. ${BY_ITSELF}`;

// Why one entry was refused: the rest of a `name: reason` line.
const UNPACK = "could not be unpacked";
const LOCKED = "locked with a password, so it cannot be read here; upload conversations.json by itself";
const tooLarge = (limit: number) => `larger than ${Math.round(limit / 1024 ** 3)} GB once unpacked`;
const oddMethod = (method: number) => `packed in a way that cannot be read here (method ${method}); upload conversations.json by itself`;

let zipEntryMaxBytes = ENTRY_MAX_BYTES;
/** Lower the limit on a zip's entries for a test; with no argument, put it back. */
export function setZipEntryMaxBytesForTests(bytes: number = ENTRY_MAX_BYTES): void {
  zipEntryMaxBytes = bytes;
}

export interface ExportReadReport {
  kind: "zip" | "json";
  /** Every entry of a zip, by name, the first 500: what the archive holds, for a look at a real export. */
  entries: string[];
  /** The lists that were read, by entry name. */
  read: string[];
  /** Entries refused, as `name: reason`: the first REFUSED_MAX_LINES, then one line counting the rest. */
  refused: string[];
  /** Elements that were not valid JSON on their own. */
  unparseable: number;
  /** Elements too large to hold. */
  oversized: number;
  /** A list ended before it closed. */
  truncated: boolean;
}

/** An entry name as it may be shown: printable, bounded. */
function shown(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

function isZip(path: string): boolean {
  const head = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  return head[0] === 0x50 && head[1] === 0x4b && [0x03, 0x05, 0x07].includes(head[2]!);
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error("The read was cancelled."), { name: "AbortError" });
}

/** `length` bytes of the file from `position`, or null when the file does not hold them. */
async function bytesAt(file: FileHandle, position: number, length: number): Promise<Buffer | null> {
  if (!Number.isSafeInteger(position) || position < 0) return null;
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
    if (!bytesRead) return null;
    filled += bytesRead;
  }
  return buffer;
}

/** A 64-bit number. One past what a JavaScript number holds exactly comes out
 * a little off, and still far past the end of any file, so it is refused there. */
const u64 = (buffer: Buffer, at: number) => Number(buffer.readBigUInt64LE(at));

interface Directory {
  /** Where the list of contents starts in the file, and how long it is. */
  start: number;
  bytes: number;
  /** How far every place the zip gives is from where it really is: more than
   * 0 when data was put in front of the zip after it was made. */
  shift: number;
}

/** The 64-bit end record that goes with the end record at `endAt`, or null when there is none. */
async function zip64End(file: FileHandle, endAt: number) {
  const locatorAt = endAt - ZIP64_LOCATOR_BYTES;
  const locator = await bytesAt(file, locatorAt, ZIP64_LOCATOR_BYTES);
  if (!locator || locator.readUInt32LE(0) !== ZIP64_LOCATOR) return null;
  // where the locator says or, when data was put in front of the zip, right before the locator
  for (const at of [u64(locator, 8), locatorAt - ZIP64_END_RECORD_BYTES]) {
    if (at + ZIP64_END_RECORD_BYTES > locatorAt) continue;
    const record = await bytesAt(file, at, ZIP64_END_RECORD_BYTES);
    if (!record || record.readUInt32LE(0) !== ZIP64_END_RECORD) continue;
    return {
      // any disk number but 0, or more than one disk in all, is a split zip
      disk: record.readUInt32LE(16) || locator.readUInt32LE(4) || Math.max(0, locator.readUInt32LE(16) - 1),
      firstDisk: record.readUInt32LE(20),
      here: u64(record, 24),
      entries: u64(record, 32),
      bytes: u64(record, 40),
      start: u64(record, 48),
      end: at,
    };
  }
  return null;
}

/** Find a zip's list of contents from the end record that closes the file. */
async function findDirectory(file: FileHandle, fileBytes: number, signal: AbortSignal | undefined): Promise<Directory> {
  // The end record is the last thing in a zip but for a comment of at most
  // 64 KiB, so it is looked for from the end, and whatever starts with its
  // four bytes has to hold together before it is believed.
  const tailBytes = Math.min(fileBytes, END_RECORD_BYTES + WIDE16);
  const tailAt = fileBytes - tailBytes;
  const tail = await bytesAt(file, tailAt, tailBytes);
  let split = false;
  for (let i = tail ? tail.length - END_RECORD_BYTES : -1; tail && i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) !== END_RECORD) continue;
    aborted(signal);
    const at = tailAt + i;
    const after = fileBytes - (at + END_RECORD_BYTES + tail.readUInt16LE(i + 20));
    if (after < 0) continue;
    // Bytes may follow a zip. One that is read in an unusual way must close
    // the file all the same: an upload cut off just after an attachment that
    // is itself a zip (a .docx is one) ends near that zip's end record, and
    // is not that zip.
    const closesTheFile = after === 0;
    let disk = tail.readUInt16LE(i + 4);
    let firstDisk = tail.readUInt16LE(i + 6);
    let here = tail.readUInt16LE(i + 8);
    let entries = tail.readUInt16LE(i + 10);
    let bytes = tail.readUInt32LE(i + 12);
    let start = tail.readUInt32LE(i + 16);
    let end = at;
    if (disk === WIDE16 || firstDisk === WIDE16 || here === WIDE16 || entries === WIDE16 || bytes === WIDE32 || start === WIDE32) {
      const wide = await zip64End(file, at);
      if (wide) ({ disk, firstDisk, here, entries, bytes, start, end } = wide);
      else if (bytes === WIDE32 || start === WIDE32) continue;
    }
    if (disk || firstDisk || here !== entries) {
      split ||= closesTheFile;
      continue;
    }
    if (start + bytes > end) continue;
    const startsARecord = async (position: number) => (await bytesAt(file, position, 4))?.readUInt32LE(0) === DIRECTORY_RECORD;
    let shift = 0;
    if (bytes && !(await startsARecord(start))) {
      // not where the zip says: then right before the end record, with every place in the zip moved by as much
      shift = end - bytes - start;
      if (!closesTheFile || !(await startsARecord(start + shift))) continue;
    }
    if (entries > ZIP_MAX_ENTRIES) throw new ExportReadError(TOO_MANY);
    if (bytes > ZIP_MAX_DIRECTORY_BYTES) throw new ExportReadError(TOO_LONG);
    return { start: start + shift, bytes, shift };
  }
  throw new ExportReadError(split ? SPLIT : DAMAGED);
}

/** A conversation list, as its line in the list of contents describes it. */
interface ListedEntry {
  /** Its name as it may be shown. */
  label: string;
  /** Where the list of contents keeps its name, to compare with the entry's own header. */
  nameAt: number;
  nameBytes: number;
  flags: number;
  method: number;
  /** Its sizes and where its header is, or null when the list defers them to 64-bit numbers it does not give. */
  place: { packed: number; unpacked: number; at: number } | null;
}

/** An entry's sizes and place from its line in the list of contents. A field
 * holding WIDE32 is kept in the line's 64-bit extra field instead. */
function placeOf(fixed: Buffer, extra: Buffer): ListedEntry["place"] {
  let packed = fixed.readUInt32LE(20);
  let unpacked = fixed.readUInt32LE(24);
  let at = fixed.readUInt32LE(42);
  if (packed !== WIDE32 && unpacked !== WIDE32 && at !== WIDE32) return { packed, unpacked, at };
  for (let i = 0; i + 4 <= extra.length; ) {
    const length = extra.readUInt16LE(i + 2);
    if (extra.readUInt16LE(i) === 1) {
      // field 1 holds only the deferred numbers, in this order
      const field = extra.subarray(i + 4, i + 4 + length);
      let used = 0;
      const wide = (value: number) => {
        if (value !== WIDE32) return value;
        used += 8;
        return used <= field.length ? u64(field, used - 8) : NaN;
      };
      unpacked = wide(unpacked);
      packed = wide(packed);
      at = wide(at);
      return Number.isNaN(packed + unpacked + at) ? null : { packed, unpacked, at };
    }
    i += 4 + length;
  }
  return null;
}

/** Walk the list of contents: every name into the report (the first 500), and
 * the conversation lists back, the first ZIP_MAX_LISTS of them; `left` counts the rest. */
async function listEntries(file: FileHandle, directory: Directory, report: ExportReadReport, signal: AbortSignal | undefined): Promise<{ wanted: ListedEntry[]; left: number }> {
  const wanted: ListedEntry[] = [];
  let left = 0;
  const end = directory.start + directory.bytes;
  // The list is read a piece at a time, and each read goes through the event
  // loop, so a long list never holds the server up. `unread` is what has been
  // read from the file and not used yet: never much more than one line.
  let unread: Buffer = Buffer.alloc(0);
  let next = directory.start;
  const take = async (length: number): Promise<Buffer> => {
    while (unread.length < length) {
      aborted(signal);
      const piece = next < end ? await bytesAt(file, next, Math.min(DIRECTORY_READ_BYTES, end - next)) : null;
      if (!piece) throw new ExportReadError(DAMAGED);
      next += piece.length;
      unread = unread.length ? Buffer.concat([unread, piece]) : piece;
    }
    const taken = unread.subarray(0, length);
    unread = unread.subarray(length);
    return taken;
  };
  let entries = 0;
  for (let at = directory.start; at < end; ) {
    const fixed = await take(DIRECTORY_RECORD_BYTES);
    if (fixed.readUInt32LE(0) !== DIRECTORY_RECORD) throw new ExportReadError(DAMAGED);
    entries += 1;
    // counted here too: the end record's count is only what the zip says of itself
    if (entries > ZIP_MAX_ENTRIES) throw new ExportReadError(TOO_MANY);
    const flags = fixed.readUInt16LE(8);
    const nameBytes = fixed.readUInt16LE(28);
    const extraBytes = fixed.readUInt16LE(30);
    const rest = await take(nameBytes + extraBytes + fixed.readUInt16LE(32));
    // a name is UTF-8 when its entry says so, and one byte to a character otherwise
    const name = rest.toString(flags & 0x800 ? "utf8" : "latin1", 0, nameBytes);
    if (report.entries.length < 500) report.entries.push(shown(name));
    if (KNOWN_ENTRY.test(name) && wanted.length >= ZIP_MAX_LISTS) left += 1;
    else if (KNOWN_ENTRY.test(name)) {
      wanted.push({
        label: shown(name),
        nameAt: at + DIRECTORY_RECORD_BYTES,
        nameBytes,
        flags,
        method: fixed.readUInt16LE(10),
        place: placeOf(fixed, rest.subarray(nameBytes, nameBytes + extraBytes)),
      });
    }
    at += DIRECTORY_RECORD_BYTES + rest.length;
  }
  return { wanted, left };
}

/** Where an entry's packed bytes are and how they are packed, or why it cannot be read. */
async function openEntry(file: FileHandle, entry: ListedEntry, directory: Directory, limit: number): Promise<{ at: number; packed: number; method: number } | string> {
  const { place } = entry;
  if (!place) return UNPACK;
  const headerAt = place.at + directory.shift;
  const header = headerAt + LOCAL_HEADER_BYTES <= directory.start ? await bytesAt(file, headerAt, LOCAL_HEADER_BYTES) : null;
  if (!header || header.readUInt32LE(0) !== LOCAL_HEADER) return UNPACK;
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const packed = header.readUInt32LE(18);
  const nameBytes = header.readUInt16LE(26);
  if ((flags | entry.flags) & 1) return LOCKED;
  // 0 is stored as it is and 8 is deflate; anything else (Deflate64 from Windows, for one) has no reader here
  const odd = [method, entry.method].find((one) => one !== 0 && one !== 8);
  if (odd !== undefined) return oddMethod(odd);
  if (place.unpacked > limit) return tooLarge(limit);
  // An entry is described twice: by the header in front of its data and by
  // its line in the list of contents. Where the two differ, which bytes are
  // the entry's and how to unpack them is a guess, so it is not read. A size
  // the header leaves for later (to after the data, or to a 64-bit number) is
  // the list's to give.
  const at = headerAt + LOCAL_HEADER_BYTES + nameBytes + header.readUInt16LE(28);
  const sizeLeftForLater = packed === WIDE32 || (Boolean(flags & 8) && packed === 0);
  if (method !== entry.method || nameBytes !== entry.nameBytes || (!sizeLeftForLater && packed !== place.packed)) return UNPACK;
  if ((method === 0 && place.packed !== place.unpacked) || at + place.packed > directory.start) return UNPACK;
  const listed = await bytesAt(file, entry.nameAt, nameBytes);
  const named = await bytesAt(file, headerAt + LOCAL_HEADER_BYTES, nameBytes);
  if (!listed || !named || !listed.equals(named)) return UNPACK;
  return { at, packed: place.packed, method };
}

const NOTHING = new Uint8Array(0);

/** fflate's streaming inflate as a function: what a chunk of packed bytes
 * unpacks to, or null when they are damaged. Only fflate runs inside the
 * `try`, so an error from whoever takes the bytes is never taken for damage. */
function inflater(): (chunk: Uint8Array, last: boolean) => Uint8Array | null {
  // fflate hands over what one push unpacked in one piece; were it ever to use several, none is dropped
  let out: Uint8Array[] = [];
  const stream = new Inflate((data) => { if (data.length) out.push(data); });
  return (chunk, last) => {
    out = [];
    try {
      stream.push(chunk, last);
    } catch {
      return null;
    }
    return out.length === 0 ? NOTHING : out.length === 1 ? out[0]! : Buffer.concat(out);
  };
}

/** Unpack an entry's bytes into `push`, a small chunk at a time. False when
 * the packed data is damaged; true when it was read to its end, or `push`
 * said to stop. */
async function unpack(file: FileHandle, data: { at: number; packed: number; method: number }, push: (chunk: Uint8Array) => boolean, signal: AbortSignal | undefined): Promise<boolean> {
  const inflate = data.method === 8 ? inflater() : null;
  let idle = 0;
  // How much packed data one step takes. Each step is a read of the file, so
  // other work runs between two steps; a step must also be short. Packed
  // whitespace unpacks a thousandfold, megabytes from one small read, so
  // the read shrinks while a step gives too much and grows back after.
  let step = ZIP_READ_BYTES;
  for (let at = data.at, left = data.packed; left > 0; ) {
    aborted(signal);
    // a new buffer each time: whoever takes the bytes may keep a piece of it
    const chunk = await bytesAt(file, at, Math.min(step, left));
    if (!chunk) return false;
    at += chunk.length;
    left -= chunk.length;
    const out = inflate ? inflate(chunk, left === 0) : chunk;
    if (!out) return false;
    if (out.length > STEP_UNPACKED_BYTES) step = Math.max(ZIP_READ_MIN_BYTES, step >> 1);
    else if (out.length < STEP_UNPACKED_BYTES / 4) step = Math.min(ZIP_READ_BYTES, step << 1);
    if (out.length) {
      idle = 0;
      if (!push(out)) return true;
    } else {
      // fflate keeps what it cannot use yet, so packed data that gives nothing out is not fed to it without end
      idle += chunk.length;
      if (idle > INFLATE_IDLE_BYTES) return false;
    }
  }
  return true;
}

export async function readExport(
  path: string,
  onElement: (value: unknown) => void,
  opts: { entryMaxBytes?: number; signal?: AbortSignal } = {},
): Promise<ExportReadReport> {
  aborted(opts.signal);
  const report: ExportReadReport = { kind: isZip(path) ? "zip" : "json", entries: [], read: [], refused: [], unparseable: 0, oversized: 0, truncated: false };
  /** Entries refused past the lines the report keeps. */
  let unlisted = 0;
  /** Conversation lists past the number one import opens. */
  let listsLeft = 0;

  /** One list: bytes in, parsed elements out; false once it is refused. */
  const list = (name: string, limit: number) => {
    let bytes = 0;
    let refused = false;
    const splitter = createArraySplitter({
      onElement: (element) => {
        let value: unknown;
        try {
          value = JSON.parse(element.toString("utf8"));
        } catch {
          report.unparseable += 1;
          return;
        }
        onElement(value);
      },
      onOversized: () => { report.oversized += 1; },
    });
    const refuse = (reason: string) => {
      refused = true;
      if (report.refused.length < REFUSED_MAX_LINES) report.refused.push(`${shown(name)}: ${reason}`);
      else unlisted += 1;
      return false;
    };
    return {
      refuse,
      push(chunk: Uint8Array): boolean {
        if (refused) return false;
        bytes += chunk.length;
        if (bytes > limit) return refuse(tooLarge(limit));
        try {
          splitter.push(chunk);
        } catch (error) {
          if (error instanceof NotAListError) return refuse("not a list of conversations");
          throw error;
        }
        return true;
      },
      end() {
        if (refused) return;
        report.read.push(shown(name));
        if (!splitter.closed()) report.truncated = true;
      },
    };
  };

  if (report.kind === "json") {
    // A bare file has only the limit that was asked for, and its size on disk
    // is checked against it first: a file is read whole or not at all.
    const limit = opts.entryMaxBytes ?? Infinity;
    const whole = list("conversations.json", limit);
    if (statSync(path).size > limit) {
      whole.refuse(tooLarge(limit));
      return report;
    }
    for await (const chunk of createReadStream(path, { highWaterMark: JSON_READ_BYTES })) {
      aborted(opts.signal);
      if (!whole.push(chunk as Buffer)) break;
    }
    whole.end();
    return report;
  }

  const limit = opts.entryMaxBytes ?? zipEntryMaxBytes;
  const file = await open(path, "r");
  try {
    const directory = await findDirectory(file, (await file.stat()).size, opts.signal);
    // The entries of a zip sit side by side in front of its list of contents,
    // so together they are no larger than that part of the file. A list that
    // points many lines at the same bytes runs out of this, and those bytes
    // are not unpacked again for each line.
    let room = directory.start;
    // what all the lists together have unpacked to, against the most they may
    const budget = limit * ZIP_UNPACKED_ENTRIES;
    const tooMuch = `left unread: the lists of this zip unpack to more than ${Math.round(budget / 1024 ** 3)} GB in all`;
    let unpacked = 0;
    // the whole list is walked before any entry is opened: a zip that is refused whole hands over nothing first
    const { wanted, left } = await listEntries(file, directory, report, opts.signal);
    listsLeft = left;
    for (const entry of wanted) {
      aborted(opts.signal);
      const target = list(entry.label, limit);
      const fits = !entry.place || LOCAL_HEADER_BYTES + entry.place.packed <= room;
      const data = unpacked >= budget ? tooMuch : fits ? await openEntry(file, entry, directory, limit) : UNPACK;
      if (typeof data === "string") target.refuse(data);
      else {
        room -= LOCAL_HEADER_BYTES + data.packed;
        const push = (chunk: Uint8Array) => {
          // the entry's own limit first; what it took counts against what all may take
          if (!target.push(chunk)) return false;
          unpacked += chunk.length;
          return unpacked > budget ? target.refuse(tooMuch) : true;
        };
        if (!(await unpack(file, data, push, opts.signal))) target.refuse(UNPACK);
      }
      target.end();
    }
  } finally {
    await file.close();
  }
  if (unlisted) report.refused.push(`${unlisted} more entries, not listed here`);
  if (listsLeft) report.refused.push(`${listsLeft.toLocaleString("en-US")} more conversation lists than the ${ZIP_MAX_LISTS.toLocaleString("en-US")} one import reads: not read`);
  return report;
}
