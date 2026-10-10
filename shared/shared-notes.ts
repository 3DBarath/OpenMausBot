// Shared notes as the app lists them (server/shared-notes.ts): facts about
// the person that belong to no single bot, one file per subject.

export interface SharedNoteInfo {
  /** The file name, `<subject>.md`. */
  name: string;
  title: string;
  aliases: string[];
  bytes: number;
  /** Dated entries in the file. */
  entries: number;
  /** How many of them an import wrote. */
  imported: number;
}

export interface SharedNoteDoc extends SharedNoteInfo {
  text: string;
}

/** Why "Use my notes in my existing conversations" left a conversation as it
 * was (server/shared-notes-adopt.ts). */
export type AdoptionSkipReason = "room" | "routine" | "relayed" | "sender" | "card" | "later";

/** What adopting older conversations did: how many it adopted, how many were
 * the owner's alone already (or adopted before), how many held nothing a
 * person wrote, and how many it left alone, by reason. */
export interface AdoptionResult {
  adopted: number;
  already: number;
  empty: number;
  skipped: Record<AdoptionSkipReason, number>;
}
