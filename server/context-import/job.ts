// The import job (docs/memory.md, "Shared notes and import"). One import at
// a time. Its state lives in $OMB_DATA_DIR/context-import/, so closing the
// app does not lose a review in progress:
//
//   job.json                 status, progress and the proposed facts
//   tmp/<id>.upload          the export as uploaded
//   tmp/<id>.paste.txt       pasted text, without the secrets the screen cut out
//   tmp/<id>.rows.json       the scan's row per conversation (no text)
//   tmp/<id>.batches.json    the cut text of the conversations being read
//
// Save and cancel delete the whole folder, and nothing reaches About me or
// the shared notes before save (save.ts). The folder is never part of a
// backup (server/workspace-backup.ts). An import nobody touches for 14 days
// is deleted with its upload, at boot and once a day.
//
// Nothing here may take the server down or hold it up. A background pass
// never rejects: whatever goes wrong in one (a full disk, a folder that
// stopped being writable, a file that cannot be read) fails that import, in
// words the person reads, and the failure path itself cannot throw. A job
// folder that is corrupt or cannot be written at boot is logged and treated
// as no import. Memory, calls and time are bounded for any input: the scan
// keeps a bounded number of rows, an import stops at 2,000 facts, and a save
// that would not fit is refused whole rather than cut short.
//
// What is sent to a model and written to the batches file has been through
// the import's screen first (screen.ts): the value of a password, a card
// number or an identity or bank number is cut out of the message that holds
// it, and such messages are counted.
//
// Model calls are paced for subscription engines whose limits nobody has
// measured: one call at a time, a pause between calls, one retry after a
// longer pause. A part whose answer cannot be used after its retry is
// skipped and counted, and the job goes on. When the engine itself fails
// (no answer, an error, a time limit) three parts in a row, the job pauses
// itself and gives those parts back, so a usage limit costs time and no
// facts; on resume the person may have them read again or skipped. After a
// restart a running job comes back paused: usage is only spent in a run the
// person started.
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { factIdentity } from "../memory-entries.ts";
import { contradictionPrompt, parseContradictions } from "../memory-tidy.ts";
import type { UpkeepEngine } from "../memory-upkeep.ts";
import { knownFactIdentities } from "../profile-learned.ts";
import { redactSecretsInText } from "../redact.ts";
import { sharedNoteIdentities } from "../shared-notes.ts";
import { memoryDate } from "../workspace.ts";
import { conversationText, packBatches, pastePieces, type PreparedConversation } from "./cuts.ts";
import { freshCandidates, importPrompt, parseImportCandidates, type DropTally } from "./extract.ts";
import { appendImportRecord, importedHashes } from "./records.ts";
import { applyContradictions, capCore, consolidationChunks, contradictionEntries, foldSubjects, patchCandidates, ReviewError } from "./review.ts";
import { planSave, SaveError, saveImportedFacts } from "./save.ts";
import { CALL_GAP_MS, clampSlice, conversationHash, estimateSlice, MAX_CANDIDATES, parseConversation, proposeSlice, scanExport, scanPaste, selectSlice, type ScanRow } from "./scan.ts";
import { screenLines, screenMessages, screenTitle } from "./screen.ts";
import { readExport } from "./zip-source.ts";
import {
  IMPORT_EXPIRES_DAYS, IMPORT_ORIGINS, MAX_SLICE_CAP, PASTE_MAX_CHARS, UPLOAD_MAX_BYTES,
  type CandidatePatch, type ImportCandidate, type ImportEstimate, type ImportJobView, type ImportOrigin, type ImportSaveResult, type ImportScanSummary, type ImportSlice, type ImportStatus,
} from "../../shared/context-import.ts";

/** How long one model call may take. The engine is told the same limit
 * (TextGenerationOptions.timeoutMs), so the two never disagree. */
export const CALL_TIMEOUT_MS = 120_000;
export const RETRY_DELAY_MS = 15_000;
/** This many batches in a row that the engine fails (each after its retry) pauses the job. */
export const ENGINE_FAILURES_BEFORE_PAUSE = 3;
export { MAX_CANDIDATES };
export const ENGINE_UNAVAILABLE = "This bot's engine cannot make the quick model call an import uses. Pick another bot.";
const STORAGE_FAILED = "The import could not be saved on this computer. Check that OpenMausBot's data folder can be written to and has free space, then try again.";
const EXPIRES_MS = IMPORT_EXPIRES_DAYS * 86_400_000;
const DAY_MS = 86_400_000;

export class ImportError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ImportError";
    this.status = status;
  }
}

export interface ContextImportDeps {
  /** The bot's engine when it may receive the person's text (policy allows), else null. */
  engine: (botId: string) => UpkeepEngine | null;
  aboutMe: () => string;
  saveAboutMe: (text: string) => void;
  now?: () => Date;
  /** The wait between calls. Resolves early when the signal aborts. Tests pass one that does not wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  callGapMs?: number;
  retryDelayMs?: number;
  callTimeoutMs?: number;
  /** The upload limit; only tests lower it. */
  uploadMaxBytes?: number;
  log?: (line: string) => void;
}

export interface ContextImport {
  /** The open import, or null. */
  current(): ImportJobView | null;
  /** One import by id. While it waits to be read, `slice` asks what another range would cost. */
  view(id: string, slice?: Partial<ImportSlice>): ImportJobView;
  create(origin: ImportOrigin): ImportJobView;
  /** Store the export, then scan it in the background. */
  receiveFile(id: string, body: AsyncIterable<Uint8Array>, declaredBytes?: number): Promise<ImportJobView>;
  receiveText(id: string, text: string): ImportJobView;
  extract(id: string, input: { botId: string } & Partial<ImportSlice>): ImportJobView;
  pause(id: string): ImportJobView;
  /** `skipFailed`: leave out the parts the engine failed before the job paused itself, instead of reading them again. */
  resume(id: string, opts?: { skipFailed?: boolean }): ImportJobView;
  cancel(id: string): Promise<void>;
  patch(id: string, patch: CandidatePatch): ImportJobView;
  save(id: string): Promise<ImportSaveResult>;
  /** At boot: bring back the job a previous run left, paused if it was
   * running. Never throws: a folder that is corrupt or cannot be written is
   * logged and there is no import. */
  start(): void;
  /** Delete the import when nobody has touched it for 14 days. True when it did. Called at boot and daily. */
  expire(): boolean;
  /** Backup maintenance: no new call starts and nothing is written until release. */
  hold(): void;
  release(): void;
  /** Wait for the background pass in flight (tests, shutdown). */
  idle(): Promise<void>;
}

interface StoredJob {
  id: string;
  origin: ImportOrigin;
  status: ImportStatus;
  error?: string;
  pausedBy?: "person" | "engine" | "restart";
  note?: string;
  uploadedBytes?: number;
  scan?: ImportScanSummary;
  slice?: ImportSlice;
  estimate?: ImportEstimate;
  botId?: string;
  batches: number;
  /** Batches dealt with so far: the index of the next one to read. */
  nextBatch: number;
  skippedBatches: number[];
  duplicates: number;
  consolidated: boolean;
  candidates: ImportCandidate[];
  /** What the record keeps of the conversations that were read. */
  readHashes: string[];
  readFrom: number | null;
  readTo: number | null;
  /** Parts given back at the last self-pause, which a resume may skip. */
  failedBatches?: number;
  /** The import stopped at its limit of facts. */
  atLimit?: boolean;
  /** Proposed facts the screen dropped. */
  droppedSecrets?: number;
  droppedInstructions?: number;
  /** When anything last happened to the job (epoch ms): an untouched job expires. */
  touchedAt?: number;
}

const STATUSES: readonly ImportStatus[] = ["created", "uploading", "scanning", "scanned", "preparing", "extracting", "paused", "consolidating", "review", "failed"];

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createContextImport(deps: ContextImportDeps): ContextImport {
  const now = () => deps.now?.() ?? new Date();
  const sleep = deps.sleep ?? defaultSleep;
  const callGapMs = deps.callGapMs ?? CALL_GAP_MS;
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
  const callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const uploadMax = deps.uploadMaxBytes ?? UPLOAD_MAX_BYTES;
  const log = (line: string) => deps.log?.(line);

  const dir = () => join(DATA_DIR, "context-import");
  const tmp = (id: string, suffix: string) => join(dir(), "tmp", `${id}.${suffix}`);
  const jobPath = () => join(dir(), "job.json");

  let job: StoredJob | null = null;
  let rows: ScanRow[] | null = null;
  let batches: PreparedConversation[][] | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  /** The upload being written, settled once its file is closed. */
  let uploading: Promise<void> | null = null;
  let saving = false;
  /** A cancel that is still letting go of its files. No import starts until it is done. */
  let cancelling = false;
  let held = false;
  let waiting: Array<() => void> = [];
  let lastError = "";
  let sweep: ReturnType<typeof setInterval> | null = null;

  const said = (error: unknown) => (error instanceof Error ? error.message : String(error));
  /** Write the job. Throws an ImportError the person can read when it cannot be written. */
  const persist = (touched = true) => {
    if (!job) return;
    // coming back from a restart (start) is not the person touching the import
    if (touched) job.touchedAt = now().getTime();
    try {
      mkdirSync(join(dir(), "tmp"), { recursive: true, mode: 0o700 });
      writeFileAtomic(jobPath(), `${JSON.stringify(job)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`context import: could not write ${jobPath()}: ${said(error)}`);
      throw new ImportError(STORAGE_FAILED, 507);
    }
  };
  /** Write the job where a failure must not become another one. */
  const tryPersist = (): boolean => {
    try {
      persist();
      return true;
    } catch {
      return false;
    }
  };
  const writeTmp = (id: string, suffix: string, text: string) => {
    try {
      mkdirSync(join(dir(), "tmp"), { recursive: true, mode: 0o700 });
      writeFileAtomic(tmp(id, suffix), text, { mode: 0o600 });
    } catch (error) {
      log(`context import: could not write ${tmp(id, suffix)}: ${said(error)}`);
      throw new ImportError(STORAGE_FAILED, 507);
    }
  };
  /** Delete the folder. False when something in it could not be deleted. */
  const removeFolder = (): boolean => {
    try {
      rmSync(dir(), { recursive: true, force: true });
      return true;
    } catch (error) {
      log(`context import: could not delete ${dir()}: ${said(error)}`);
      return false;
    }
  };
  const forget = () => {
    job = null;
    rows = null;
    batches = null;
  };
  const wake = () => {
    for (const resolve of waiting.splice(0)) resolve();
  };
  /** Wait out a backup; returns at once when this pass was stopped. */
  const gate = async (signal: AbortSignal) => {
    while (held && !signal.aborted) await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const need = (id: string): StoredJob => {
    if (!job || job.id !== id) throw new ImportError("That import no longer exists.", 404);
    if (saving) throw new ImportError("This import is being saved. Wait a moment.", 409);
    return job;
  };
  // read again whenever the records change (records.ts), so "Delete everything imported" reaches an open import
  const alreadyRead = () => importedHashes();
  const loadRows = (mine: StoredJob): ScanRow[] => {
    if (rows) return rows;
    try {
      rows = JSON.parse(readFileSync(tmp(mine.id, "rows.json"), "utf8")) as ScanRow[];
    } catch {
      rows = [];
    }
    return rows;
  };
  const selected = (mine: StoredJob) => selectSlice(loadRows(mine), mine.slice!, mine.origin === "paste" ? new Set() : alreadyRead());

  function viewOf(mine: StoredJob, wanted?: Partial<ImportSlice>): ImportJobView {
    const paste = mine.origin === "paste";
    const view: ImportJobView = {
      id: mine.id, origin: mine.origin, status: mine.status,
      ...(mine.error ? { error: mine.error } : {}),
      ...(mine.pausedBy ? { pausedBy: mine.pausedBy } : {}),
      ...(mine.note ? { note: mine.note } : {}),
      ...(mine.uploadedBytes !== undefined ? { uploadedBytes: mine.uploadedBytes } : {}),
      ...(mine.scan ? { scan: mine.scan } : {}),
      ...(mine.botId ? { botId: mine.botId } : {}),
      ...(mine.touchedAt ? { expiresAt: mine.touchedAt + EXPIRES_MS } : {}),
    };
    if (mine.status === "scanned" && mine.slice) {
      const read = paste ? new Set<string>() : alreadyRead();
      // how many were read before is counted now, not when the scan ran
      if (mine.scan && !paste) view.scan = { ...mine.scan, alreadyRead: loadRows(mine).filter((row) => row.hash && read.has(row.hash)).length };
      view.slice = paste ? mine.slice : clampSlice(wanted ?? {}, mine.slice);
      view.estimate = estimateSlice(selectSlice(loadRows(mine), view.slice, read));
    } else if (mine.slice) {
      view.slice = mine.slice;
      if (mine.estimate) view.estimate = mine.estimate;
    }
    if (mine.batches) {
      view.progress = {
        batches: mine.batches, done: mine.nextBatch, skipped: mine.skippedBatches.length, candidates: mine.candidates.length, duplicates: mine.duplicates,
        droppedSecrets: mine.droppedSecrets ?? 0, droppedInstructions: mine.droppedInstructions ?? 0,
      };
    }
    if (mine.status === "paused" && mine.failedBatches) view.failedBatches = mine.failedBatches;
    if (mine.atLimit) view.unreadAtLimit = unreadAtLimit(mine);
    if (mine.status === "review") {
      view.candidates = mine.candidates;
      try {
        const { problems } = planSave(mine.origin, mine.candidates, { aboutMe: deps.aboutMe, now });
        if (problems.length) view.fit = problems;
      } catch (error) {
        // the notes could not be read to plan the save: Save itself will say why
        log(`context import: could not plan the save of ${mine.id}: ${said(error)}`);
      }
    }
    return view;
  }

  /** Conversations of the range that the limit of facts left unread. */
  function unreadAtLimit(mine: StoredJob): number {
    if (mine.origin === "paste" || !mine.slice) return 0;
    try {
      const read = new Set(mine.readHashes);
      return selected(mine).filter((row) => !read.has(row.hash)).length;
    } catch {
      return 0;
    }
  }

  /** The job fails, in words. Cannot throw: this is where failures end. */
  function fail(mine: StoredJob, error: unknown): void {
    try {
      mine.status = "failed";
      mine.error = error instanceof ImportError ? error.message : "The import stopped on an unexpected error. Cancel it and start again.";
      log(`context import: ${mine.id} failed: ${said(error)}`);
    } catch {
      // not even the log may turn a failed import into a failed server
    }
    // kept in memory when it cannot be written: the person still sees why
    tryPersist();
  }

  /** Run one background pass. A pass that was stopped (pause, cancel) ends
   * quietly; any other failure fails the job. The promise kept in `running`
   * never rejects, whatever the pass or its failure handling does. */
  function begin(work: (signal: AbortSignal, mine: StoredJob) => Promise<void>): void {
    const mine = job!;
    const own = new AbortController();
    controller = own;
    const pass = (async () => {
      try {
        await work(own.signal, mine);
      } catch (error) {
        if (!own.signal.aborted && job === mine) fail(mine, error);
      } finally {
        if (controller === own) controller = null;
      }
    })().catch(() => undefined).finally(() => {
      if (running === pass) running = null;
    });
    running = pass;
  }

  function nothingFound(scan: ImportScanSummary): string {
    const parts = ["No ChatGPT or Claude conversations were found in that file."];
    if (scan.skipped.entries[0]) parts.push(`${scan.skipped.entries[0]}.`);
    if (scan.skipped.conversations) parts.push(`${scan.skipped.conversations} item(s) had a shape this version does not know.`);
    return parts.join(" ");
  }

  /** A problem with the file as a whole (zip-source.ts ExportReadError) is told as it is. */
  const readFailure = (error: unknown): unknown =>
    (error instanceof Error && error.name === "ExportReadError" ? new ImportError(error.message, 422) : error);

  async function scanPass(signal: AbortSignal, mine: StoredJob): Promise<void> {
    const result = await scanExport(tmp(mine.id, "upload"), { alreadyRead: alreadyRead(), signal }).catch((error: unknown) => { throw readFailure(error); });
    if (signal.aborted || job !== mine) return;
    await gate(signal);
    if (signal.aborted || job !== mine) return;
    if (!result.summary.conversations) throw new ImportError(nothingFound(result.summary), 422);
    writeTmp(mine.id, "rows.json", JSON.stringify(result.rows));
    rows = result.rows;
    mine.scan = result.summary;
    // the shape of the data decides where it came from, not what was picked
    if (result.summary.format === "chatgpt" || result.summary.format === "claude") mine.origin = result.summary.format;
    mine.slice = proposeSlice(result.rows, now().getTime(), alreadyRead());
    mine.status = "scanned";
    persist();
  }

  /** The conversations of the slice, cut, newest first, in batches. */
  async function prepare(mine: StoredJob, signal: AbortSignal): Promise<PreparedConversation[][]> {
    const day = (at: number) => memoryDate(at ? new Date(at) : now());
    let conversations: PreparedConversation[];
    if (mine.origin === "paste") {
      conversations = pastePieces(readFileSync(tmp(mine.id, "paste.txt"), "utf8"))
        .map((text) => ({ hash: "", title: "Pasted text", date: day(0), updatedAt: now().getTime(), text }));
    } else {
      const order = new Map(selected(mine).map((row, index) => [row.hash, index]));
      const found: PreparedConversation[] = [];
      await readExport(tmp(mine.id, "upload"), (value) => {
        const parsed = parseConversation(value);
        if (!parsed) return;
        const hash = conversationHash(parsed.conversation);
        const index = order.get(hash);
        if (index === undefined || found[index]) return;
        // screened before anything is batched: what the screen cuts out reaches neither the model nor the batches file
        const text = conversationText(screenMessages(parsed.conversation.messages).messages);
        if (text) found[index] = { hash, title: screenTitle(parsed.conversation.title), date: day(parsed.conversation.updatedAt), updatedAt: parsed.conversation.updatedAt, text };
      }, { signal }).catch((error: unknown) => { throw readFailure(error); });
      conversations = found.filter(Boolean);
    }
    return packBatches(conversations.map((conversation) => conversation.text.length)).map((indexes) => indexes.map((index) => conversations[index]!));
  }

  /** One model call, or null: the engine failed, answered nothing, or took too long. */
  async function ask(engine: UpkeepEngine, prompt: string, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted || !engine.generateText) return null;
    const expiry = AbortSignal.any([signal, AbortSignal.timeout(callTimeoutMs)]);
    try {
      const answer = await Promise.race([
        // isolated: nothing of the call is kept by the engine, and it has no tools (TextGenerationOptions)
        engine.generateText(prompt, { signal: expiry, timeoutMs: callTimeoutMs, isolated: true }),
        new Promise<never>((_, reject) => expiry.addEventListener("abort", () => reject(new Error("The engine did not answer in time.")), { once: true })),
      ]);
      return typeof answer === "string" ? answer : null;
    } catch (error) {
      if (!signal.aborted) lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  function pauseForEngine(mine: StoredJob, failed: number): void {
    mine.status = "paused";
    mine.pausedBy = "engine";
    mine.failedBatches = failed;
    const reason = redactSecretsInText(lastError).replace(/\s+/g, " ").trim().slice(0, 200);
    mine.note = `The engine failed ${ENGINE_FAILURES_BEFORE_PAUSE} times in a row, so the import paused itself. It may have reached a usage limit. Resume later, and nothing read so far is lost.${reason ? ` It said: ${reason}` : ""}`;
    persist();
  }

  async function extractPass(signal: AbortSignal, mine: StoredJob): Promise<void> {
    const engine = mine.botId ? deps.engine(mine.botId) : null;
    if (!engine?.generateText) throw new ImportError(ENGINE_UNAVAILABLE, 409);
    if (mine.status === "preparing") {
      const prepared = await prepare(mine, signal);
      if (signal.aborted || job !== mine) return;
      await gate(signal);
      if (signal.aborted || job !== mine) return;
      if (!prepared.length) throw new ImportError("There was nothing of yours to read in those conversations.", 422);
      writeTmp(mine.id, "batches.json", JSON.stringify(prepared));
      batches = prepared;
      mine.batches = prepared.length;
      mine.nextBatch = 0;
      mine.status = "extracting";
      persist();
    }
    batches ??= JSON.parse(readFileSync(tmp(mine.id, "batches.json"), "utf8")) as PreparedConversation[][];
    const today = memoryDate(now());
    const known = new Set([...knownFactIdentities(deps.aboutMe()), ...sharedNoteIdentities(), ...mine.candidates.map((candidate) => factIdentity(candidate.text))]);
    // How many parts in a row the engine itself failed. An answer that cannot
    // be used is not the engine failing: that part is skipped and the count starts again.
    let failed = 0;
    while (mine.nextBatch < mine.batches && !mine.atLimit) {
      await gate(signal);
      if (signal.aborted || job !== mine) return;
      const batch = batches[mine.nextBatch] ?? [];
      const prompt = importPrompt({ origin: mine.origin, conversations: batch, today });
      type Read = { found: ImportCandidate[]; dropped: DropTally } | "engine" | "answer";
      const read = async (): Promise<Read> => {
        const answer = await ask(engine, prompt, signal);
        if (answer === null) return "engine";
        const dropped: DropTally = { secrets: 0, instructions: 0 };
        const found = parseImportCandidates(answer, batch, today, dropped);
        if (found !== null) return { found, dropped };
        lastError = "The answer was not the list that was asked for.";
        return "answer";
      };
      let result = await read();
      if (typeof result === "string" && !signal.aborted) {
        await sleep(retryDelayMs, signal);
        result = await read();
      }
      // paused or cancelled while the model answered: this batch is read again on resume
      if (signal.aborted || job !== mine) return;
      await gate(signal);
      if (signal.aborted || job !== mine) return;
      if (typeof result === "string") {
        failed = result === "engine" ? failed + 1 : 0;
        mine.skippedBatches.push(mine.nextBatch);
        mine.nextBatch += 1;
        if (failed >= ENGINE_FAILURES_BEFORE_PAUSE) {
          // the engine is not answering at all: give the batches back and stop spending
          mine.nextBatch -= failed;
          mine.skippedBatches.splice(-failed);
          pauseForEngine(mine, failed);
          return;
        }
      } else {
        failed = 0;
        const { fresh, duplicates } = freshCandidates(result.found, known);
        const room = MAX_CANDIDATES - mine.candidates.length;
        mine.duplicates += duplicates;
        mine.droppedSecrets = (mine.droppedSecrets ?? 0) + result.dropped.secrets;
        mine.droppedInstructions = (mine.droppedInstructions ?? 0) + result.dropped.instructions;
        if (fresh.length > room) {
          // The limit cuts this part short. What fits is proposed, but the
          // part's conversations are not recorded as read: a later import of
          // the same file reads them again and proposes the facts cut here.
          mine.candidates.push(...fresh.slice(0, Math.max(0, room)));
          mine.atLimit = true;
        } else {
          mine.candidates.push(...fresh);
          for (const conversation of batch) {
            if (!conversation.hash) continue;
            mine.readHashes.push(conversation.hash);
            if (conversation.updatedAt) {
              mine.readFrom = mine.readFrom === null ? conversation.updatedAt : Math.min(mine.readFrom, conversation.updatedAt);
              mine.readTo = mine.readTo === null ? conversation.updatedAt : Math.max(mine.readTo, conversation.updatedAt);
            }
          }
          mine.nextBatch += 1;
          // full: no call is made for facts nobody could be shown
          if (mine.candidates.length >= MAX_CANDIDATES && mine.nextBatch < mine.batches) mine.atLimit = true;
        }
      }
      persist();
      if (mine.nextBatch < mine.batches && !mine.atLimit) await sleep(callGapMs, signal);
      if (signal.aborted || job !== mine) return;
    }

    mine.status = "consolidating";
    persist();
    if (!mine.consolidated) {
      // a bounded number of subjects before anything is reviewed (review.ts)
      mine.candidates = foldSubjects(mine.candidates);
      for (const chunk of consolidationChunks(mine.candidates)) {
        if (chunk.length < 2) continue;
        await sleep(callGapMs, signal);
        await gate(signal);
        if (signal.aborted || job !== mine) return;
        const answer = await ask(engine, contradictionPrompt(contradictionEntries(chunk)), signal);
        if (signal.aborted || job !== mine) return;
        if (answer === null) {
          mine.note = "Facts that disagree with each other were not checked, because the engine did not answer. Look for them before you save.";
          break;
        }
        mine.candidates = applyContradictions(mine.candidates, parseContradictions(answer, chunk.length), chunk);
      }
      mine.candidates = capCore(mine.candidates);
      mine.consolidated = true;
    }
    await gate(signal);
    if (signal.aborted || job !== mine) return;
    mine.status = "review";
    delete mine.pausedBy;
    persist();
    log(`context import: ${mine.id} read ${mine.nextBatch - mine.skippedBatches.length} of ${mine.batches} batch(es) and proposes ${mine.candidates.length} fact(s)`);
  }

  return {
    current: () => (job ? viewOf(job) : null),
    view: (id, slice) => viewOf(need(id), slice),

    create(origin) {
      // A cancel deletes the folder when it has finished waiting: an import
      // started meanwhile would be deleted with it, so none is.
      if (cancelling) throw new ImportError("The last import is still being cancelled. Try again in a moment.", 409);
      if (job) throw new ImportError("An import is already open. Finish or cancel it first.", 409);
      if (!IMPORT_ORIGINS.includes(origin)) throw new ImportError("source must be chatgpt, claude or paste", 400);
      job = { id: randomUUID(), origin, status: "created", batches: 0, nextBatch: 0, skippedBatches: [], duplicates: 0, consolidated: false, candidates: [], readHashes: [], readFrom: null, readTo: null };
      try {
        persist();
      } catch (error) {
        // an import that cannot be written was not started
        forget();
        throw error;
      }
      return viewOf(job);
    },

    async receiveFile(id, body, declaredBytes) {
      const mine = need(id);
      if (mine.origin === "paste") throw new ImportError("This import takes pasted text, not a file.", 409);
      if (mine.status !== "created" && mine.status !== "failed") throw new ImportError("This import already has its file.", 409);
      const tooLarge = () => new ImportError(`That file is larger than ${Math.round(uploadMax / 1024 ** 3)} GB. Upload the conversations.json from inside the zip by itself.`, 413);
      if (declaredBytes !== undefined && declaredBytes > uploadMax) throw tooLarge();
      const own = new AbortController();
      controller = own;
      mine.status = "uploading";
      delete mine.error;
      mine.uploadedBytes = 0;
      const backToCreated = () => {
        if (job !== mine) return;
        try {
          rmSync(tmp(id, "upload"), { force: true });
        } catch (error) {
          log(`context import: could not delete ${tmp(id, "upload")}: ${said(error)}`);
        }
        mine.status = "created";
        delete mine.uploadedBytes;
        tryPersist();
      };
      try {
        persist();
      } catch (error) {
        if (controller === own) controller = null;
        backToCreated();
        throw error;
      }
      const counted = async function* () {
        for await (const chunk of body) {
          mine.uploadedBytes = (mine.uploadedBytes ?? 0) + chunk.length;
          if (mine.uploadedBytes > uploadMax) throw tooLarge();
          yield chunk;
        }
      };
      // The file is closed before anything is done about it: a cancel waits
      // for this too, so the folder is never deleted under an open file.
      let out: ReturnType<typeof createWriteStream>;
      try {
        mkdirSync(join(dir(), "tmp"), { recursive: true, mode: 0o700 });
        out = createWriteStream(tmp(id, "upload"), { mode: 0o600 });
      } catch (error) {
        if (controller === own) controller = null;
        log(`context import: could not open ${tmp(id, "upload")}: ${said(error)}`);
        backToCreated();
        throw new ImportError(STORAGE_FAILED, 507);
      }
      const closed = new Promise<void>((resolve) => {
        out.once("close", resolve);
        // a file that never opened is closed
        out.once("error", () => { if (out.destroyed) resolve(); });
      });
      let failure: unknown;
      const written = pipeline(Readable.from(counted()), out, { signal: own.signal }).then(() => undefined, (error: unknown) => { failure ??= error ?? new Error("upload failed"); });
      // A cancel does not wait for the sender: an upload that has stalled
      // never ends by itself, so the file is closed here and that is waited for.
      const stopped = new Promise<void>((resolve) => {
        const stop = () => {
          failure ??= new Error("The import was cancelled.");
          out.destroy();
          resolve();
        };
        if (own.signal.aborted) stop();
        else own.signal.addEventListener("abort", stop, { once: true });
      });
      const settled = Promise.race([written, stopped]).then(() => closed);
      uploading = settled;
      await settled;
      if (uploading === settled) uploading = null;
      if (controller === own) controller = null;
      if (failure !== undefined) {
        backToCreated();
        if (failure instanceof ImportError) throw failure;
        const code = (failure as NodeJS.ErrnoException).code;
        if (!own.signal.aborted && typeof code === "string" && /^E(ACCES|PERM|NOSPC|ROFS|DQUOT|NOENT|IO)$/.test(code)) {
          log(`context import: could not write ${tmp(id, "upload")}: ${said(failure)}`);
          throw new ImportError(STORAGE_FAILED, 507);
        }
        throw new ImportError(own.signal.aborted ? "The import was cancelled." : "The upload was interrupted. Try again.", own.signal.aborted ? 409 : 400);
      }
      if (job !== mine) throw new ImportError("The import was cancelled.", 409);
      if (!mine.uploadedBytes) {
        backToCreated();
        throw new ImportError("That file is empty.", 400);
      }
      mine.status = "scanning";
      try {
        persist();
      } catch (error) {
        backToCreated();
        throw error;
      }
      begin(scanPass);
      return viewOf(mine);
    },

    receiveText(id, text) {
      const mine = need(id);
      if (mine.origin !== "paste") throw new ImportError("This import takes an export file, not pasted text.", 409);
      if (mine.status !== "created") throw new ImportError("This import already has its text.", 409);
      if (!text.trim()) throw new ImportError("Paste some text first.", 400);
      if (text.length > PASTE_MAX_CHARS) throw new ImportError(`Pasted text can be at most ${PASTE_MAX_CHARS.toLocaleString("en-US")} characters. Paste it in parts, one import each.`, 413);
      // screened before it is stored: the value of a secret is cut out of its line, and the lines are counted
      const screened = screenLines(text);
      writeTmp(id, "paste.txt", screened.text);
      const result = scanPaste(screened.text, now().getTime());
      result.summary.skipped.secrets = screened.cut;
      writeTmp(id, "rows.json", JSON.stringify(result.rows));
      rows = result.rows;
      mine.scan = result.summary;
      mine.slice = { from: 0, to: now().getTime(), cap: MAX_SLICE_CAP };
      mine.status = "scanned";
      persist();
      return viewOf(mine);
    },

    extract(id, input) {
      const mine = need(id);
      if (mine.status !== "scanned" || !mine.slice) throw new ImportError("This import is not waiting to be read.", 409);
      if (!deps.engine(input.botId)?.generateText) throw new ImportError(ENGINE_UNAVAILABLE, 409);
      if (mine.origin !== "paste") mine.slice = clampSlice(input, mine.slice);
      const chosen = selected(mine);
      if (!chosen.length) throw new ImportError("There is nothing to read in that range. Widen the dates.", 400);
      mine.estimate = estimateSlice(chosen);
      mine.botId = input.botId;
      mine.status = "preparing";
      try {
        persist();
      } catch (error) {
        // nothing is spent on an import that cannot be written
        mine.status = "scanned";
        throw error;
      }
      begin(extractPass);
      return viewOf(mine);
    },

    pause(id) {
      const mine = need(id);
      if (mine.status !== "extracting" && mine.status !== "consolidating") throw new ImportError("Nothing is running to pause.", 409);
      mine.status = "paused";
      mine.pausedBy = "person";
      // stopped first: a pause that cannot be written still stops spending
      controller?.abort();
      wake();
      persist();
      return viewOf(mine);
    },

    resume(id, opts = {}) {
      const mine = need(id);
      if (mine.status !== "paused") throw new ImportError("This import is not paused.", 409);
      if (!mine.botId || !deps.engine(mine.botId)?.generateText) throw new ImportError(ENGINE_UNAVAILABLE, 409);
      const before = { nextBatch: mine.nextBatch, skipped: [...mine.skippedBatches], failedBatches: mine.failedBatches, pausedBy: mine.pausedBy, note: mine.note };
      if (opts.skipFailed && mine.failedBatches) {
        // the person chose to go on without the parts the engine failed: they are skipped and counted
        const skip = Math.min(mine.failedBatches, mine.batches - mine.nextBatch);
        for (let at = 0; at < skip; at += 1) mine.skippedBatches.push(mine.nextBatch + at);
        mine.nextBatch += skip;
      }
      delete mine.failedBatches;
      mine.status = "extracting";
      delete mine.pausedBy;
      delete mine.note;
      try {
        persist();
      } catch (error) {
        Object.assign(mine, { status: "paused", nextBatch: before.nextBatch, skippedBatches: before.skipped });
        if (before.failedBatches) mine.failedBatches = before.failedBatches;
        if (before.pausedBy) mine.pausedBy = before.pausedBy;
        if (before.note) mine.note = before.note;
        throw error;
      }
      begin(extractPass);
      return viewOf(mine);
    },

    async cancel(id) {
      if (!job || job.id !== id) throw new ImportError("That import no longer exists.", 404);
      if (saving) throw new ImportError("This import is being saved. Wait a moment.", 409);
      const mine = job;
      const pass = running;
      const upload = uploading;
      // From here until the folder is gone nothing else may start: this
      // cancel only ever deletes the import it was called for.
      cancelling = true;
      try {
        job = null;
        controller?.abort();
        wake();
        // let the pass in flight and the upload being written let go of their files before they are removed
        await pass;
        await upload;
        forget();
        if (removeFolder()) return;
        // The files are still there: the import stays, failed, so the person
        // is told and can cancel again once the folder can be changed.
        job = mine;
        mine.status = "failed";
        mine.error = "This import was stopped, but its files could not be deleted from this computer. Check that OpenMausBot's data folder can be changed, then cancel again.";
        throw new ImportError(mine.error, 507);
      } finally {
        cancelling = false;
      }
    },

    patch(id, patch) {
      const mine = need(id);
      if (mine.status !== "review") throw new ImportError("There is nothing to review yet.", 409);
      try {
        mine.candidates = patchCandidates(mine.candidates, patch);
      } catch (error) {
        if (error instanceof ReviewError) throw new ImportError(error.message, error.status);
        throw error;
      }
      persist();
      return viewOf(mine);
    },

    async save(id) {
      const mine = need(id);
      if (mine.status !== "review") throw new ImportError("Review the facts before saving.", 409);
      saving = true;
      try {
        let result: ImportSaveResult;
        try {
          result = await saveImportedFacts(mine.origin, mine.candidates, { aboutMe: deps.aboutMe, saveAboutMe: deps.saveAboutMe, now });
        } catch (error) {
          // Refused or cut off: the job, its facts and its upload are kept,
          // and no conversation is recorded as read.
          if (error instanceof SaveError) throw new ImportError(error.message, 409);
          log(`context import: ${mine.id} could not be saved: ${said(error)}`);
          throw new ImportError("The facts could not be saved on this computer. Nothing was marked as read and the import is still here. Check that OpenMausBot's data folder can be written to and has free space, then save again.", 507);
        }
        try {
          appendImportRecord({
            id: mine.id, origin: mine.origin, at: now().getTime(),
            conversations: mine.origin === "paste" ? mine.nextBatch - mine.skippedBatches.length : mine.readHashes.length,
            aboutMe: result.aboutMe, sharedNotes: result.entries,
            from: mine.readFrom, to: mine.readTo, hashes: mine.readHashes,
          });
        } catch (error) {
          log(`context import: ${mine.id} saved its facts but not its record: ${said(error)}`);
          throw new ImportError("The facts were saved, but the record of which conversations were read could not be written. The import is still here: save again once OpenMausBot's data folder can be written to.", 507);
        }
        log(`context import: ${mine.id} saved ${result.aboutMe} fact(s) to About me and ${result.entries} to shared notes`);
        forget();
        // told, not hidden: the promise is that the upload is gone after a save
        if (!removeFolder()) result.notDeleted = dir();
        return result;
      } finally {
        saving = false;
      }
    },

    expire() {
      try {
        if (!job || running || uploading || saving) return false;
        const touched = job.touchedAt ?? 0;
        if (now().getTime() - touched <= EXPIRES_MS) return false;
        log(`context import: ${job.id} was left for more than ${IMPORT_EXPIRES_DAYS} days and is deleted with its upload`);
        forget();
        removeFolder();
        return true;
      } catch {
        return false;
      }
    },

    start() {
      // Whatever a previous run left, in whatever state the folder is: never a reason not to start.
      try {
        let stored: StoredJob | null = null;
        let touched = 0;
        try {
          stored = JSON.parse(readFileSync(jobPath(), "utf8")) as StoredJob;
          touched = statSync(jobPath()).mtimeMs;
        } catch {
          stored = null;
        }
        const valid = stored !== null && typeof stored === "object" && typeof stored.id === "string" && /^[\w-]{1,64}$/.test(stored.id) && IMPORT_ORIGINS.includes(stored.origin) && STATUSES.includes(stored.status) &&
          Array.isArray(stored.candidates) && Array.isArray(stored.skippedBatches) && Array.isArray(stored.readHashes) && Number.isInteger(stored.batches) && Number.isInteger(stored.nextBatch);
        // No job, one that cannot be read, or an upload or a scan that a
        // restart cut short (it has cost nothing): whatever is there goes.
        if (!valid || ["created", "uploading", "scanning"].includes(stored!.status)) {
          if (existsSync(dir()) && !removeFolder()) log("context import: what an earlier import left could not be deleted; it is ignored");
          return;
        }
        job = stored;
        job!.touchedAt = typeof job!.touchedAt === "number" && Number.isFinite(job!.touchedAt) ? job!.touchedAt : touched;
        if (now().getTime() - (job!.touchedAt ?? 0) > EXPIRES_MS) {
          log(`context import: ${job!.id} was left for more than ${IMPORT_EXPIRES_DAYS} days and is deleted with its upload`);
          forget();
          removeFolder();
          return;
        }
        if (job!.status === "preparing") job!.status = existsSync(tmp(job!.id, "rows.json")) ? "scanned" : "failed";
        if (job!.status === "extracting" || job!.status === "consolidating") {
          job!.status = "paused";
          job!.pausedBy = "restart";
        }
        if (job!.status === "failed" && !job!.error) job!.error = "The import was interrupted. Cancel it and start again.";
        try {
          persist(false);
        } catch {
          // A folder that cannot be written holds no import this run can
          // carry on with: it is left as it is and nothing is shown.
          log("context import: the import an earlier run left cannot be written to; it is ignored until its folder can be");
          forget();
          return;
        }
      } catch (error) {
        forget();
        log(`context import: could not bring back an earlier import: ${said(error)}`);
      } finally {
        // once a day, and never a reason for the process to stay up
        if (!sweep) {
          sweep = setInterval(() => { this.expire(); }, DAY_MS);
          sweep.unref?.();
        }
      }
    },

    hold() {
      held = true;
    },
    release() {
      held = false;
      wake();
    },
    async idle() {
      while (running) await running;
    },
  };
}
