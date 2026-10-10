// The import job (docs/memory.md, "Shared notes and import"). One import at
// a time. Its state lives in $OMB_DATA_DIR/context-import/, so closing the
// app does not lose a review in progress:
//
//   job.json                 status, progress and the proposed facts
//   tmp/<id>.upload          the export as uploaded
//   tmp/<id>.paste.txt       pasted text
//   tmp/<id>.rows.json       the scan's row per conversation (no text)
//   tmp/<id>.batches.json    the cut text of the conversations being read
//
// Save and cancel delete the whole folder, and nothing reaches About me or
// the shared notes before save (save.ts). The folder is never part of a
// backup (server/workspace-backup.ts).
//
// Model calls are paced for subscription engines whose limits nobody has
// measured: one call at a time, a pause between calls, one retry after a
// longer pause, and after three batches in a row that fail the job pauses
// itself and gives those batches back, so a rate limit costs time and no
// facts. After a restart a running job comes back paused: usage is only
// spent in a run the person started.
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
import { freshCandidates, importPrompt, parseImportCandidates } from "./extract.ts";
import { appendImportRecord, importedHashes } from "./records.ts";
import { applyContradictions, capCore, consolidationChunks, contradictionEntries, patchCandidates, ReviewError } from "./review.ts";
import { saveImportedFacts } from "./save.ts";
import { CALL_GAP_MS, clampSlice, conversationHash, estimateSlice, parseConversation, proposeSlice, scanExport, scanPaste, selectSlice, type ScanRow } from "./scan.ts";
import { readExport } from "./zip-source.ts";
import {
  IMPORT_ORIGINS, MAX_SLICE_CAP, PASTE_MAX_CHARS, UPLOAD_MAX_BYTES,
  type CandidatePatch, type ImportCandidate, type ImportEstimate, type ImportJobView, type ImportOrigin, type ImportSaveResult, type ImportScanSummary, type ImportSlice, type ImportStatus,
} from "../../shared/context-import.ts";

export const CALL_TIMEOUT_MS = 120_000;
export const RETRY_DELAY_MS = 15_000;
/** This many batches in a row failing (each after its retry) pauses the job. */
export const ENGINE_FAILURES_BEFORE_PAUSE = 3;
/** One import proposes at most this many facts; a person cannot review more. */
export const MAX_CANDIDATES = 2_000;
export const ENGINE_UNAVAILABLE = "This bot's engine cannot make the quick model call an import uses. Pick another bot.";

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
  resume(id: string): ImportJobView;
  cancel(id: string): Promise<void>;
  patch(id: string, patch: CandidatePatch): ImportJobView;
  save(id: string): ImportSaveResult;
  /** At boot: bring back the job a previous run left, paused if it was running. */
  start(): void;
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
  let readBefore: Set<string> | null = null;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let held = false;
  let waiting: Array<() => void> = [];
  let lastError = "";

  const persist = () => {
    if (!job) return;
    mkdirSync(join(dir(), "tmp"), { recursive: true, mode: 0o700 });
    writeFileAtomic(jobPath(), `${JSON.stringify(job)}\n`, { mode: 0o600 });
  };
  const writeTmp = (id: string, suffix: string, text: string) => {
    mkdirSync(join(dir(), "tmp"), { recursive: true, mode: 0o700 });
    writeFileAtomic(tmp(id, suffix), text, { mode: 0o600 });
  };
  const discard = () => {
    job = null;
    rows = null;
    batches = null;
    readBefore = null;
    rmSync(dir(), { recursive: true, force: true });
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
    return job;
  };
  const alreadyRead = () => (readBefore ??= importedHashes());
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
    const view: ImportJobView = {
      id: mine.id, origin: mine.origin, status: mine.status,
      ...(mine.error ? { error: mine.error } : {}),
      ...(mine.pausedBy ? { pausedBy: mine.pausedBy } : {}),
      ...(mine.note ? { note: mine.note } : {}),
      ...(mine.uploadedBytes !== undefined ? { uploadedBytes: mine.uploadedBytes } : {}),
      ...(mine.scan ? { scan: mine.scan } : {}),
      ...(mine.botId ? { botId: mine.botId } : {}),
    };
    if (mine.status === "scanned" && mine.slice) {
      view.slice = mine.origin === "paste" ? mine.slice : clampSlice(wanted ?? {}, mine.slice);
      view.estimate = estimateSlice(selectSlice(loadRows(mine), view.slice, mine.origin === "paste" ? new Set() : alreadyRead()));
    } else if (mine.slice) {
      view.slice = mine.slice;
      if (mine.estimate) view.estimate = mine.estimate;
    }
    if (mine.batches) view.progress = { batches: mine.batches, done: mine.nextBatch, skipped: mine.skippedBatches.length, candidates: mine.candidates.length, duplicates: mine.duplicates };
    if (mine.status === "review") view.candidates = mine.candidates;
    return view;
  }

  /** Run one background pass. A pass that was stopped (pause, cancel) ends quietly; any other failure fails the job. */
  function begin(work: (signal: AbortSignal, mine: StoredJob) => Promise<void>): void {
    const mine = job!;
    const own = new AbortController();
    controller = own;
    const pass = work(own.signal, mine)
      .catch((error: unknown) => {
        if (own.signal.aborted || job !== mine) return;
        mine.status = "failed";
        mine.error = error instanceof ImportError ? error.message : "The import stopped on an unexpected error. Cancel it and start again.";
        log(`context import: ${mine.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        persist();
      })
      .finally(() => {
        if (controller === own) controller = null;
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

  async function scanPass(signal: AbortSignal, mine: StoredJob): Promise<void> {
    const result = await scanExport(tmp(mine.id, "upload"), { alreadyRead: alreadyRead(), signal });
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
        const text = conversationText(parsed.conversation.messages);
        if (text) found[index] = { hash, title: parsed.conversation.title, date: day(parsed.conversation.updatedAt), updatedAt: parsed.conversation.updatedAt, text };
      }, { signal });
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
        engine.generateText(prompt, { signal: expiry }),
        new Promise<never>((_, reject) => expiry.addEventListener("abort", () => reject(new Error("The engine did not answer in time.")), { once: true })),
      ]);
      return typeof answer === "string" ? answer : null;
    } catch (error) {
      if (!signal.aborted) lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  function pauseForEngine(mine: StoredJob): void {
    mine.status = "paused";
    mine.pausedBy = "engine";
    const said = redactSecretsInText(lastError).replace(/\s+/g, " ").trim().slice(0, 200);
    mine.note = `The engine failed ${ENGINE_FAILURES_BEFORE_PAUSE} times in a row, so the import paused itself. It may have reached a usage limit. Resume later, and nothing read so far is lost.${said ? ` It said: ${said}` : ""}`;
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
    let failed = 0;
    while (mine.nextBatch < mine.batches) {
      await gate(signal);
      if (signal.aborted || job !== mine) return;
      const batch = batches[mine.nextBatch] ?? [];
      const prompt = importPrompt({ origin: mine.origin, conversations: batch, today });
      const read = async () => {
        const answer = await ask(engine, prompt, signal);
        if (answer === null) return null;
        const found = parseImportCandidates(answer, batch, today);
        if (found === null) lastError = "The answer was not the list that was asked for.";
        return found;
      };
      let found = await read();
      if (found === null && !signal.aborted) {
        await sleep(retryDelayMs, signal);
        found = await read();
      }
      // paused or cancelled while the model answered: this batch is read again on resume
      if (signal.aborted || job !== mine) return;
      await gate(signal);
      if (signal.aborted || job !== mine) return;
      if (found === null) {
        failed += 1;
        mine.skippedBatches.push(mine.nextBatch);
        mine.nextBatch += 1;
        if (failed >= ENGINE_FAILURES_BEFORE_PAUSE) {
          // the engine is not answering at all: give the batches back and stop spending
          mine.nextBatch -= failed;
          mine.skippedBatches.splice(-failed);
          pauseForEngine(mine);
          return;
        }
      } else {
        failed = 0;
        const { fresh, duplicates } = freshCandidates(found, known);
        mine.candidates.push(...fresh.slice(0, Math.max(0, MAX_CANDIDATES - mine.candidates.length)));
        mine.duplicates += duplicates;
        for (const conversation of batch) {
          if (!conversation.hash) continue;
          mine.readHashes.push(conversation.hash);
          if (conversation.updatedAt) {
            mine.readFrom = mine.readFrom === null ? conversation.updatedAt : Math.min(mine.readFrom, conversation.updatedAt);
            mine.readTo = mine.readTo === null ? conversation.updatedAt : Math.max(mine.readTo, conversation.updatedAt);
          }
        }
        mine.nextBatch += 1;
      }
      persist();
      if (mine.nextBatch < mine.batches) await sleep(callGapMs, signal);
      if (signal.aborted || job !== mine) return;
    }

    mine.status = "consolidating";
    persist();
    if (!mine.consolidated) {
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
      if (job) throw new ImportError("An import is already open. Finish or cancel it first.", 409);
      if (!IMPORT_ORIGINS.includes(origin)) throw new ImportError("source must be chatgpt, claude or paste", 400);
      job = { id: randomUUID(), origin, status: "created", batches: 0, nextBatch: 0, skippedBatches: [], duplicates: 0, consolidated: false, candidates: [], readHashes: [], readFrom: null, readTo: null };
      persist();
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
      persist();
      const counted = async function* () {
        for await (const chunk of body) {
          mine.uploadedBytes = (mine.uploadedBytes ?? 0) + chunk.length;
          if (mine.uploadedBytes > uploadMax) throw tooLarge();
          yield chunk;
        }
      };
      try {
        await pipeline(Readable.from(counted()), createWriteStream(tmp(id, "upload"), { mode: 0o600 }), { signal: own.signal });
      } catch (error) {
        if (controller === own) controller = null;
        if (job === mine) {
          rmSync(tmp(id, "upload"), { force: true });
          mine.status = "created";
          delete mine.uploadedBytes;
          persist();
        }
        if (error instanceof ImportError) throw error;
        throw new ImportError(own.signal.aborted ? "The import was cancelled." : "The upload was interrupted. Try again.", own.signal.aborted ? 409 : 400);
      }
      if (controller === own) controller = null;
      if (job !== mine) throw new ImportError("The import was cancelled.", 409);
      if (!mine.uploadedBytes) {
        rmSync(tmp(id, "upload"), { force: true });
        mine.status = "created";
        persist();
        throw new ImportError("That file is empty.", 400);
      }
      mine.status = "scanning";
      persist();
      begin(scanPass);
      return viewOf(mine);
    },

    receiveText(id, text) {
      const mine = need(id);
      if (mine.origin !== "paste") throw new ImportError("This import takes an export file, not pasted text.", 409);
      if (mine.status !== "created") throw new ImportError("This import already has its text.", 409);
      if (!text.trim()) throw new ImportError("Paste some text first.", 400);
      if (text.length > PASTE_MAX_CHARS) throw new ImportError(`Pasted text can be at most ${PASTE_MAX_CHARS.toLocaleString("en-US")} characters. Paste it in parts, one import each.`, 413);
      writeTmp(id, "paste.txt", text);
      const result = scanPaste(text, now().getTime());
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
      persist();
      begin(extractPass);
      return viewOf(mine);
    },

    pause(id) {
      const mine = need(id);
      if (mine.status !== "extracting" && mine.status !== "consolidating") throw new ImportError("Nothing is running to pause.", 409);
      mine.status = "paused";
      mine.pausedBy = "person";
      controller?.abort();
      wake();
      persist();
      return viewOf(mine);
    },

    resume(id) {
      const mine = need(id);
      if (mine.status !== "paused") throw new ImportError("This import is not paused.", 409);
      if (!mine.botId || !deps.engine(mine.botId)?.generateText) throw new ImportError(ENGINE_UNAVAILABLE, 409);
      mine.status = "extracting";
      delete mine.pausedBy;
      delete mine.note;
      persist();
      begin(extractPass);
      return viewOf(mine);
    },

    async cancel(id) {
      need(id);
      const pass = running;
      job = null;
      controller?.abort();
      wake();
      // let the pass in flight let go of its files before they are removed
      await pass?.catch(() => undefined);
      discard();
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

    save(id) {
      const mine = need(id);
      if (mine.status !== "review") throw new ImportError("Review the facts before saving.", 409);
      const result = saveImportedFacts(mine.origin, mine.candidates, { aboutMe: deps.aboutMe, saveAboutMe: deps.saveAboutMe, now });
      appendImportRecord({
        id: mine.id, origin: mine.origin, at: now().getTime(),
        conversations: mine.origin === "paste" ? mine.nextBatch - mine.skippedBatches.length : mine.readHashes.length,
        aboutMe: result.aboutMe, sharedNotes: result.entries + result.continued,
        from: mine.readFrom, to: mine.readTo, hashes: mine.readHashes,
      });
      log(`context import: ${mine.id} saved ${result.aboutMe} fact(s) to About me and ${result.entries + result.continued} to shared notes`);
      discard();
      return result;
    },

    start() {
      let stored: StoredJob;
      try {
        stored = JSON.parse(readFileSync(jobPath(), "utf8")) as StoredJob;
      } catch {
        // no job, or one that cannot be read: whatever an earlier run left behind goes
        rmSync(dir(), { recursive: true, force: true });
        return;
      }
      const valid = stored && typeof stored.id === "string" && /^[\w-]{1,64}$/.test(stored.id) && IMPORT_ORIGINS.includes(stored.origin) && STATUSES.includes(stored.status) && Array.isArray(stored.candidates);
      // an upload or a scan that a restart cut short has cost nothing: it starts again
      if (!valid || ["created", "uploading", "scanning"].includes(stored.status)) {
        rmSync(dir(), { recursive: true, force: true });
        return;
      }
      job = stored;
      if (job.status === "preparing") job.status = existsSync(tmp(job.id, "rows.json")) ? "scanned" : "failed";
      if (job.status === "extracting" || job.status === "consolidating") {
        job.status = "paused";
        job.pausedBy = "restart";
      }
      if (job.status === "failed" && !job.error) job.error = "The import was interrupted. Cancel it and start again.";
      persist();
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
