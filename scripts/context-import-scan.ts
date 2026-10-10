// Run the context import's scan on a real ChatGPT or Claude export and print
// what it found: what the archive holds, how many conversations each parser
// understood, the date range, what the default read would cost, and the
// shapes no parser knew. This is how the two "Checks before building" that
// need a real export get answered (docs/superpowers/specs/2026-10-10-context-import-design.md).
//
// No model is called, nothing is uploaded and nothing is written. The output
// holds counts, dates, entry names and key names only, never a message.
//
//   node --experimental-strip-types scripts/context-import-scan.ts ~/Downloads/export.zip
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { estimateSlice, proposeSlice, scanExport, selectSlice } from "../server/context-import/scan.ts";

const target = process.argv[2];
if (!target || !existsSync(target) || !statSync(target).isFile()) {
  console.error("Usage: node --experimental-strip-types scripts/context-import-scan.ts <export.zip or conversations.json>");
  process.exit(2);
}

const started = Date.now();
const baseline = process.memoryUsage().rss;
let peakRss = baseline;
const watch = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 50);
const { summary, rows, unknownShapes, archiveEntries } = await scanExport(resolve(target));
clearInterval(watch);

const day = (at: number | null) => (at ? new Date(at).toISOString().slice(0, 10) : null);
const slice = proposeSlice(rows, Date.now());
const selected = selectSlice(rows, slice);
console.log(JSON.stringify({
  file: { bytes: statSync(target).size, seconds: Math.round((Date.now() - started) / 100) / 10, peakMemoryMB: Math.round(Math.max(peakRss, process.memoryUsage().rss) / 1024 ** 2) },
  archiveEntries,
  format: summary.format,
  conversations: summary.conversations,
  withOwnMessages: summary.withOwnMessages,
  undated: rows.filter((row) => !row.updatedAt).length,
  oldest: day(summary.oldest),
  newest: day(summary.newest),
  ownChars: summary.ownChars,
  skipped: summary.skipped,
  truncated: summary.truncated,
  unknownShapes,
  defaultRead: { from: day(slice.from), to: day(slice.to), cap: slice.cap, ...estimateSlice(selected) },
  everything: estimateSlice(selectSlice(rows, { from: 0, to: Date.now(), cap: rows.length || 1 })),
}, null, 2));
