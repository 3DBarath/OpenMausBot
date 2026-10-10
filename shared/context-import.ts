// Context import (docs/memory.md, "Shared notes and import"): the shapes the
// server and the import dialog exchange. An import reads a ChatGPT or Claude
// export, or pasted text, proposes lasting facts about the person, and saves
// only what the person keeps. Nothing here carries a conversation's text.

export type ImportOrigin = "chatgpt" | "claude" | "paste";
export const IMPORT_ORIGINS: readonly ImportOrigin[] = ["chatgpt", "claude", "paste"];
/** How an origin reads in an entry's mark, `(imported · ChatGPT)`, and in
 * About me, `learned by ChatGPT import`. */
export const IMPORT_ORIGIN_LABEL: Record<ImportOrigin, string> = { chatgpt: "ChatGPT", claude: "Claude", paste: "Pasted text" };

export type NamedSensitiveCategory = "health" | "money" | "relationships" | "politics" | "religion";
/** "other": the model called the fact sensitive without naming one of the five. */
export type SensitiveCategory = NamedSensitiveCategory | "other";
/** The categories the model is asked to name. */
export const SENSITIVE_CATEGORIES: readonly NamedSensitiveCategory[] = ["health", "money", "relationships", "politics", "religion"];

/** Core facts go to About me, which every bot reads on every turn. */
export const CORE_MAX = 30;
export const PASTE_MAX_CHARS = 100_000;
export const UPLOAD_MAX_BYTES = 4 * 1024 ** 3;
export const DEFAULT_SLICE_MONTHS = 12;
export const DEFAULT_SLICE_CAP = 500;
export const MAX_SLICE_CAP = 2_000;
/** One import files its facts under at most this many subjects; the rarest are folded into a general one before review. */
export const IMPORT_SUBJECTS_MAX = 40;
/** An import nobody touches for this many days is deleted, with its upload. */
export const IMPORT_EXPIRES_DAYS = 14;
/** An upload must arrive within this many minutes (the server's limit for one request). */
export const UPLOAD_MINUTES = 5;

export interface ImportCandidate {
  id: string;
  /** One sentence of fact, at most 300 characters. */
  text: string;
  kind: "core" | "subject";
  /** Where the fact is filed when it is not core, and where a core fact past the cap goes. */
  subject: string;
  aliases: string[];
  /** YYYY-MM-DD: the day of the chat the fact came from. */
  date: string;
  /** YYYY-MM-DD: the last day a temporary fact holds. */
  until?: string;
  sensitive: SensitiveCategory | null;
  chatTitle: string;
  /** The tick box. A sensitive fact starts unticked. */
  keep: boolean;
  /** The id of the newer fact that contradicts this one. */
  replacedBy?: string;
}

/** Which conversations are read: updated within [from, to], newest first, at most `cap`. */
export interface ImportSlice {
  from: number;
  to: number;
  cap: number;
}

export interface ImportEstimate {
  conversations: number;
  /** Characters that would be sent, after the cuts. */
  chars: number;
  /** Model calls when nothing goes wrong: one per batch, plus the checks for conflicting facts. */
  calls: number;
  /** The most calls there can be: every batch read twice (one retry each), plus every check. */
  maxCalls: number;
  minSeconds: number;
  maxSeconds: number;
}

export interface ImportScanSummary {
  format: "chatgpt" | "claude" | "paste" | "unknown";
  conversations: number;
  /** Conversations in which the person wrote something. */
  withOwnMessages: number;
  oldest: number | null;
  newest: number | null;
  /** Characters of the person's own messages, before any cut. */
  ownChars: number;
  /** Conversations an earlier import already read, left out of the slice. */
  alreadyRead: number;
  skipped: {
    /** Conversations of a shape no parser knows. */
    conversations: number;
    /** Messages of a shape no parser knows, or with no text. */
    messages: number;
    /** Conversations too large to hold in memory. */
    oversized: number;
    /** Archive entries refused, as `name: reason`. Names only, never content. */
    entries: string[];
    /** Messages that held a password, a card number or an identity or bank number: that value was cut out before any model read them. */
    secrets: number;
    /** Conversations past the most one scan keeps: counted, never read. */
    overLimit: number;
  };
  /** The file ended in the middle of the list. */
  truncated: boolean;
}

export type ImportStatus = "created" | "uploading" | "scanning" | "scanned" | "preparing" | "extracting" | "paused" | "consolidating" | "review" | "failed";

export interface ImportProgress {
  batches: number;
  done: number;
  /** Batches that failed twice and were left out. */
  skipped: number;
  candidates: number;
  /** Facts dropped because About me, the shared notes or this import already had them. */
  duplicates: number;
  /** Proposed facts dropped because they held a secret: never masked, never kept. */
  droppedSecrets: number;
  /** Proposed facts dropped because they read like an instruction, or held a command, code or a link. */
  droppedInstructions: number;
}

/** Why saving the ticked facts would not fit the shared notes as they stand. */
export type ImportFitProblem =
  /** More new notes than there is room for: `needed` new subjects, room for `room`. */
  | { kind: "files"; needed: number; room: number }
  /** One subject's note would pass its size limit: `over` facts do not fit. */
  | { kind: "bytes"; subject: string; over: number };

export interface ImportJobView {
  id: string;
  origin: ImportOrigin;
  status: ImportStatus;
  /** Why the job failed, in the person's words. */
  error?: string;
  /** Who paused it: the person, the engine failing three batches in a row, or a restart. */
  pausedBy?: "person" | "engine" | "restart";
  /** A remark about the run: what the engine last said, or that conflicts were not checked. */
  note?: string;
  uploadedBytes?: number;
  scan?: ImportScanSummary;
  slice?: ImportSlice;
  estimate?: ImportEstimate;
  botId?: string;
  progress?: ImportProgress;
  candidates?: ImportCandidate[];
  /** Parts given back when the engine stopped answering: resume reads them again, or skips them when asked to. */
  failedBatches?: number;
  /** The import stopped at its limit of facts: this many conversations of the range were left unread, for a later import of the same file. */
  unreadAtLimit?: number;
  /** In review: why saving the ticked facts would be refused, when it would. */
  fit?: ImportFitProblem[];
  /** When an import nobody touches is deleted (epoch milliseconds). */
  expiresAt?: number;
}

/** A bot whose engine could read the export, or the reason it cannot. */
export interface ImportEngineChoice {
  botId: string;
  name: string;
  available: boolean;
  reason?: string;
}

/** One finished import, as kept in context-imports.json. No text. */
export interface ImportRecordView {
  id: string;
  origin: ImportOrigin;
  at: number;
  conversations: number;
  aboutMe: number;
  sharedNotes: number;
  from: number | null;
  to: number | null;
}

export interface ImportOverview {
  job: ImportJobView | null;
  engines: ImportEngineChoice[];
  imports: ImportRecordView[];
}

export interface CandidateChange {
  id: string;
  keep?: boolean;
  text?: string;
  kind?: "core" | "subject";
  subject?: string;
}

export interface CandidatePatch {
  changes?: CandidateChange[];
  /** Rename a subject for every fact filed under it. */
  renameSubject?: { from: string; to: string };
  /** After the changes above: untick whatever of the ticked facts does not
   * fit the shared notes, keeping the newest. Nothing is removed from the list. */
  keepWhatFits?: boolean;
}

export interface ImportSaveResult {
  /** Lines added to About me. */
  aboutMe: number;
  /** Core facts About me had no room for, filed under their subject instead (counted in `entries`). */
  overflowed: number;
  /** Subject notes written to. */
  subjects: number;
  /** Entries added across them. */
  entries: number;
  /** Facts left out because About me or the notes already had them. */
  duplicates: number;
  /** Always empty: a save that would not fit is refused whole, never cut short. Kept for clients written before that. */
  full: Array<{ subject: string; dropped: number; reason: "files" | "bytes" }>;
  /** About me after the save. */
  aboutMeText: string;
  /** Set when the upload and what was read from it could not be deleted afterwards: the folder that is left. */
  notDeleted?: string;
}
