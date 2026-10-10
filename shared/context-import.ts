// Context import (docs/memory.md, "Shared notes and import"): the shapes the
// server and the import dialog exchange. An import reads a ChatGPT or Claude
// export, or pasted text, proposes lasting facts about the person, and saves
// only what the person keeps. Nothing here carries a conversation's text.

export type ImportOrigin = "chatgpt" | "claude" | "paste";
export const IMPORT_ORIGINS: readonly ImportOrigin[] = ["chatgpt", "claude", "paste"];
/** How an origin reads in an entry's mark, `(imported · ChatGPT)`, and in
 * About me, `learned by ChatGPT import`. */
export const IMPORT_ORIGIN_LABEL: Record<ImportOrigin, string> = { chatgpt: "ChatGPT", claude: "Claude", paste: "Pasted text" };

export type SensitiveCategory = "health" | "money" | "relationships" | "politics" | "religion";
export const SENSITIVE_CATEGORIES: readonly SensitiveCategory[] = ["health", "money", "relationships", "politics", "religion"];

/** Core facts go to About me, which every bot reads on every turn. */
export const CORE_MAX = 30;
export const PASTE_MAX_CHARS = 100_000;
export const UPLOAD_MAX_BYTES = 4 * 1024 ** 3;
export const DEFAULT_SLICE_MONTHS = 12;
export const DEFAULT_SLICE_CAP = 500;
export const MAX_SLICE_CAP = 2_000;

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
  /** Model calls: one per batch, plus the check for conflicting facts. */
  calls: number;
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
}

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
}

export interface ImportSaveResult {
  /** Lines added to About me. */
  aboutMe: number;
  /** Core facts About me had no room for, saved to the "About me, continued" note. */
  continued: number;
  /** Subject notes written to. */
  subjects: number;
  /** Entries added across them. */
  entries: number;
  /** Facts left out because About me or the notes already had them. */
  duplicates: number;
  /** Subjects that took fewer entries than asked, with how many did not fit. */
  full: Array<{ subject: string; dropped: number; reason: "files" | "bytes" }>;
  /** About me after the save. */
  aboutMeText: string;
}
