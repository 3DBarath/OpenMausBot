// Step 2 of an import: read the whole export once, without a model, and say
// what is in it. The scan keeps one small row per conversation (a hash of
// its id and update time, the time, and how many characters of it would be
// sent) and no text. From those rows it proposes which conversations to
// read — newest first, the last 12 months, at most 500, never one an
// earlier import already read — and what that will cost in model calls.
import { createHash } from "node:crypto";

import { conversationText, packBatches, pastePieces } from "./cuts.ts";
import { MAX_BATCH_CANDIDATES } from "./extract.ts";
import { CONSOLIDATE_CHUNK } from "./review.ts";
import { screenMessages } from "./screen.ts";
import { isChatGptConversation, parseChatGptConversation } from "./chatgpt-export.ts";
import { isClaudeConversation, parseClaudeConversation } from "./claude-export.ts";
import { isRecord, type ExportConversation } from "./types.ts";
import { readExport } from "./zip-source.ts";
import { DEFAULT_SLICE_CAP, DEFAULT_SLICE_MONTHS, MAX_SLICE_CAP, type ImportEstimate, type ImportScanSummary, type ImportSlice } from "../../shared/context-import.ts";

/** One scan keeps a row for at most this many conversations. Past it the
 * rest of the file is still read, so the count is true, but nothing is kept
 * of it: memory stays bounded whatever the file holds. */
export const SCAN_MAX_CONVERSATIONS = 100_000;
/** One import proposes at most this many facts (job.ts stops reading there). */
export const MAX_CANDIDATES = 2_000;

/** The pause between two model calls (job.ts), which the estimate counts. */
export const CALL_GAP_MS = 2_000;
/** How long one call takes, roughly. Not measured on any engine: see the plan's Checks. */
const CALL_MIN_SECONDS = 8;
const CALL_MAX_SECONDS = 45;

export interface ScanRow {
  /** conversationHash(); "" for a piece of pasted text. */
  hash: string;
  /** Epoch milliseconds; 0 when the export gave no time. */
  updatedAt: number;
  /** Characters that would be sent, after the cuts; 0 when the person wrote nothing in it. */
  chars: number;
}

export interface ScanResult {
  summary: ImportScanSummary;
  rows: ScanRow[];
  /** For a look at a real export (scripts/context-import-scan.ts): the top-level
   * keys of shapes no parser knew, with counts, and a zip's entry names. Names
   * and keys only, never a value. */
  unknownShapes: Record<string, number>;
  archiveEntries: string[];
}

/** What the import record keeps of a conversation: enough to know it was read, nothing of what it said. */
export function conversationHash(conversation: Pick<ExportConversation, "id" | "title" | "updatedAt">): string {
  return createHash("sha256").update(`${conversation.id || conversation.title}\n${conversation.updatedAt}`).digest("hex").slice(0, 24);
}

/** A conversation of either export, told apart by its shape, or null. */
export function parseConversation(value: unknown): { format: "chatgpt" | "claude"; conversation: ExportConversation } | null {
  if (isChatGptConversation(value)) {
    const conversation = parseChatGptConversation(value);
    return conversation ? { format: "chatgpt", conversation } : null;
  }
  if (isClaudeConversation(value)) {
    const conversation = parseClaudeConversation(value);
    return conversation ? { format: "claude", conversation } : null;
  }
  return null;
}

/** Whether an element of an export is shaped like a conversation, readable
 * or not. Told to the reader, which gives up on a list that shows none
 * (readExport). */
export function conversationShaped(value: unknown): boolean {
  return isChatGptConversation(value) || isClaudeConversation(value);
}

export async function scanExport(path: string, opts: { alreadyRead?: ReadonlySet<string>; signal?: AbortSignal; maxConversations?: number } = {}): Promise<ScanResult> {
  const max = opts.maxConversations ?? SCAN_MAX_CONVERSATIONS;
  const rows: ScanRow[] = [];
  const seen = new Set<string>();
  const formats = { chatgpt: 0, claude: 0 };
  const unknownShapes: Record<string, number> = {};
  const summary: ImportScanSummary = {
    format: "unknown", conversations: 0, withOwnMessages: 0, oldest: null, newest: null, ownChars: 0, alreadyRead: 0,
    skipped: { conversations: 0, messages: 0, oversized: 0, entries: [], secrets: 0, overLimit: 0 }, truncated: false,
  };
  const report = await readExport(path, (value) => {
    if (rows.length >= max) {
      // counted, so the person is told how many; nothing of it is parsed or kept
      summary.skipped.overLimit += 1;
      return true;
    }
    const parsed = parseConversation(value);
    if (!parsed) {
      summary.skipped.conversations += 1;
      const shape = isRecord(value) ? Object.keys(value).sort().slice(0, 12).map((key) => key.slice(0, 40)).join(",") || "(empty object)" : Array.isArray(value) ? "(list)" : `(${typeof value})`;
      if (Object.keys(unknownShapes).length < 20 || Object.hasOwn(unknownShapes, shape)) unknownShapes[shape] = (unknownShapes[shape] ?? 0) + 1;
      // a conversation that could not be read is still one; anything else is not
      return conversationShaped(value);
    }
    const { conversation } = parsed;
    const hash = conversationHash(conversation);
    // the same conversation in two parts of an export is one conversation
    if (seen.has(hash)) return true;
    seen.add(hash);
    formats[parsed.format] += 1;
    summary.conversations += 1;
    summary.skipped.messages += conversation.skippedMessages;
    // what would be sent: the person's messages, without any that holds a secret (screen.ts)
    const screened = screenMessages(conversation.messages);
    summary.skipped.secrets += screened.cut;
    const chars = conversationText(screened.messages).length;
    if (chars) summary.withOwnMessages += 1;
    summary.ownChars += conversation.messages.reduce((total, message) => total + message.length, 0);
    if (conversation.updatedAt) {
      summary.oldest = summary.oldest === null ? conversation.updatedAt : Math.min(summary.oldest, conversation.updatedAt);
      summary.newest = summary.newest === null ? conversation.updatedAt : Math.max(summary.newest, conversation.updatedAt);
    }
    if (opts.alreadyRead?.has(hash)) summary.alreadyRead += 1;
    rows.push({ hash, updatedAt: conversation.updatedAt, chars });
    return true;
  }, { signal: opts.signal });
  summary.skipped.conversations += report.unparseable;
  summary.skipped.oversized = report.oversized;
  summary.skipped.entries = report.refused;
  if (report.cut.length) summary.skipped.cut = report.cut;
  summary.truncated = report.truncated;
  if (formats.chatgpt || formats.claude) summary.format = formats.chatgpt >= formats.claude ? "chatgpt" : "claude";
  return { summary, rows, unknownShapes, archiveEntries: report.entries };
}

/** Pasted text has no conversations: each piece is read as one. */
export function scanPaste(text: string, now: number): ScanResult {
  const pieces = pastePieces(text);
  return {
    summary: {
      format: "paste", conversations: pieces.length, withOwnMessages: pieces.length, oldest: pieces.length ? now : null, newest: pieces.length ? now : null,
      ownChars: text.length, alreadyRead: 0, skipped: { conversations: 0, messages: 0, oversized: 0, entries: [], secrets: 0, overLimit: 0 }, truncated: false,
    },
    rows: pieces.map((piece) => ({ hash: "", updatedAt: now, chars: piece.length })),
    unknownShapes: {},
    archiveEntries: [],
  };
}

/** `months` before `at`, by the calendar (in UTC, so the range does not move with the machine's zone). */
function monthsBefore(at: number, months: number): number {
  const date = new Date(at);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.getTime();
}

const readable = (row: ScanRow, alreadyRead: ReadonlySet<string>) => row.chars > 0 && !(row.hash && alreadyRead.has(row.hash));
/** A conversation with no time is in every range: the export did not say, so it is not left out for it. */
const inRange = (row: ScanRow, slice: Pick<ImportSlice, "from" | "to">) => !row.updatedAt || (row.updatedAt >= slice.from && row.updatedAt <= slice.to);

/** The default read: the last 12 months, at most 500 conversations. When
 * everything in that range was read before and older conversations remain,
 * the range moves back to end at the newest one not yet read ("Read more"). */
export function proposeSlice(rows: readonly ScanRow[], now: number, alreadyRead: ReadonlySet<string> = new Set()): ImportSlice {
  const slice: ImportSlice = { from: monthsBefore(now, DEFAULT_SLICE_MONTHS), to: now, cap: DEFAULT_SLICE_CAP };
  const unread = rows.filter((row) => readable(row, alreadyRead));
  if (unread.some((row) => inRange(row, slice))) return slice;
  const newest = unread.reduce((latest, row) => Math.max(latest, row.updatedAt), 0);
  return newest ? { from: monthsBefore(newest, DEFAULT_SLICE_MONTHS), to: newest, cap: DEFAULT_SLICE_CAP } : slice;
}

/** A slice as asked for, held to what is allowed: a whole range, a cap from 1 to 2,000. */
export function clampSlice(wanted: Partial<ImportSlice>, fallback: ImportSlice): ImportSlice {
  const number = (value: unknown, otherwise: number) => (typeof value === "number" && Number.isFinite(value) ? value : otherwise);
  const from = Math.max(0, number(wanted.from, fallback.from));
  const to = Math.max(from, number(wanted.to, fallback.to));
  return { from, to, cap: Math.min(MAX_SLICE_CAP, Math.max(1, Math.round(number(wanted.cap, fallback.cap)))) };
}

/** The conversations a slice reads, newest first. */
export function selectSlice(rows: readonly ScanRow[], slice: ImportSlice, alreadyRead: ReadonlySet<string> = new Set()): ScanRow[] {
  return rows
    .filter((row) => readable(row, alreadyRead) && inRange(row, slice))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, slice.cap);
}

/** How many conflict checks an import of this many batches can need: the
 * proposed facts are checked 200 at a time, a batch proposes at most 40, and
 * an import stops at 2,000. */
export function conflictCalls(batches: number): number {
  return batches ? Math.ceil(Math.min(MAX_CANDIDATES, batches * MAX_BATCH_CANDIDATES) / CONSOLIDATE_CHUNK) : 0;
}

/** What reading these conversations costs: one call per batch and the
 * checks for conflicting facts; and at most, when every batch has to be
 * read twice (one retry each). */
export function estimateSlice(selected: readonly ScanRow[]): ImportEstimate {
  const batches = packBatches(selected.map((row) => row.chars)).length;
  const checks = conflictCalls(batches);
  const calls = batches + checks;
  const gap = CALL_GAP_MS / 1000;
  return {
    conversations: selected.length,
    chars: selected.reduce((total, row) => total + row.chars, 0),
    calls,
    maxCalls: batches * 2 + checks,
    minSeconds: Math.round(calls * (CALL_MIN_SECONDS + gap)),
    maxSeconds: Math.round(calls * (CALL_MAX_SECONDS + gap)),
  };
}
