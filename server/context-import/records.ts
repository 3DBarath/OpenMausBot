// One record per finished import, in $OMB_DATA_DIR/context-imports.json:
// where it came from, when, how much was read and saved, the date range, and
// a hash of each conversation's id and update time. The hashes are how a
// later import knows what was already read ("Read more", a newer export).
// No title, no message, no fact: nothing here says what a conversation held.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { IMPORT_ORIGINS, type ImportOrigin, type ImportRecordView } from "../../shared/context-import.ts";

const MAX_RECORDS = 100;

export interface ImportRecord extends ImportRecordView {
  hashes: string[];
}

function filePath(): string {
  return join(DATA_DIR, "context-imports.json");
}

export function listImportRecords(): ImportRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(filePath(), "utf8")) as { imports?: unknown };
    if (!Array.isArray(parsed.imports)) return [];
    return parsed.imports.filter((record): record is ImportRecord =>
      Boolean(record) && typeof record.id === "string" && IMPORT_ORIGINS.includes(record.origin as ImportOrigin) && typeof record.at === "number" && Array.isArray(record.hashes));
  } catch {
    return [];
  }
}

/** Every conversation an earlier import read. */
export function importedHashes(): Set<string> {
  return new Set(listImportRecords().flatMap((record) => record.hashes.filter((hash) => typeof hash === "string" && hash.length > 0)));
}

export function appendImportRecord(record: ImportRecord): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  writeFileAtomic(filePath(), `${JSON.stringify({ imports: [...listImportRecords(), record].slice(-MAX_RECORDS) }, null, 2)}\n`, { mode: 0o600 });
}

/** "Delete everything imported" starts over: a later import reads those conversations again. */
export function clearImportRecords(): void {
  rmSync(filePath(), { force: true });
}

export function recordView(record: ImportRecord): ImportRecordView {
  const { hashes: _hashes, ...view } = record;
  return view;
}
