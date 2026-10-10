// Open an uploaded export, a zip or a bare conversations.json, and hand over
// each element of each conversation list in it, parsed, one at a time.
// Nothing is ever written to disk: an entry's name only decides whether the
// entry is read, so a name that climbs out of a folder is just a name. The
// zip is read front to back as a stream (fflate), entry sizes are counted as
// the bytes come out rather than trusted from the header, and a problem with
// the content is reported, never thrown: only a read error or a cancel ends
// the read early.
import { closeSync, createReadStream, openSync, readSync } from "node:fs";
import { Unzip, UnzipInflate, UnzipPassThrough } from "fflate";

import { createArraySplitter, NotAListError } from "./json-array.ts";

/** An entry larger than this once unpacked is refused. */
export const ENTRY_MAX_BYTES = 2 * 1024 ** 3;
/** The conversation lists an export carries: conversations.json, or numbered
 * parts of it, in any folder. Every other entry is skipped unread. */
const KNOWN_ENTRY = /(?:^|[\\/])conversations(?:-\d+)?\.json$/i;
/** Small reads bound how much one chunk of a zip can unpack to at once. */
const ZIP_READ_BYTES = 16 * 1024;
const JSON_READ_BYTES = 64 * 1024;

export interface ExportReadReport {
  kind: "zip" | "json";
  /** Every entry of a zip, by name, the first 500: what the archive holds, for a look at a real export. */
  entries: string[];
  /** The lists that were read, by entry name. */
  read: string[];
  /** Entries refused, as `name: reason`. */
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

export async function readExport(
  path: string,
  onElement: (value: unknown) => void,
  opts: { entryMaxBytes?: number; signal?: AbortSignal } = {},
): Promise<ExportReadReport> {
  const limit = opts.entryMaxBytes ?? ENTRY_MAX_BYTES;
  const report: ExportReadReport = { kind: isZip(path) ? "zip" : "json", entries: [], read: [], refused: [], unparseable: 0, oversized: 0, truncated: false };

  /** One list: bytes in, parsed elements out; false once it is refused. */
  const list = (name: string) => {
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
      report.refused.push(`${shown(name)}: ${reason}`);
      return false;
    };
    return {
      refuse,
      push(chunk: Uint8Array): boolean {
        if (refused) return false;
        bytes += chunk.length;
        if (bytes > limit) return refuse(`larger than ${Math.round(limit / 1024 ** 3)} GB once unpacked`);
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
    const whole = list("conversations.json");
    for await (const chunk of createReadStream(path, { highWaterMark: JSON_READ_BYTES })) {
      aborted(opts.signal);
      if (!whole.push(chunk as Buffer)) break;
    }
    whole.end();
    return report;
  }

  // fflate calls back synchronously inside push(): what an entry unpacks to
  // is queued here and drained after each chunk of the archive.
  const pending: Array<() => void> = [];
  const unzip = new Unzip((entry) => {
    if (report.entries.length < 500) report.entries.push(shown(entry.name));
    if (!KNOWN_ENTRY.test(entry.name)) return;
    const target = list(entry.name);
    if (entry.originalSize !== undefined && entry.originalSize > limit) {
      target.refuse(`larger than ${Math.round(limit / 1024 ** 3)} GB once unpacked`);
      return;
    }
    let stopped = false;
    entry.ondata = (error, data, final) => {
      if (stopped) return;
      if (error) {
        stopped = true;
        pending.push(() => { target.refuse("could not be unpacked"); });
        return;
      }
      pending.push(() => {
        if (stopped) return;
        if (!target.push(data)) {
          stopped = true;
          entry.terminate();
          return;
        }
        if (final) target.end();
      });
    };
    try {
      entry.start();
    } catch {
      // no decoder for this entry's method (Deflate64 from Windows, for one)
      stopped = true;
      target.refuse(`packed in a way that cannot be read here (method ${entry.compression}); upload conversations.json by itself`);
    }
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  const drain = () => {
    for (const step of pending.splice(0)) step();
  };
  for await (const chunk of createReadStream(path, { highWaterMark: ZIP_READ_BYTES })) {
    aborted(opts.signal);
    unzip.push(chunk as Buffer);
    drain();
  }
  unzip.push(new Uint8Array(0), true);
  drain();
  return report;
}
