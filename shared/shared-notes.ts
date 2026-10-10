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
