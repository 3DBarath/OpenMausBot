// The screenshots open commit cards are showing (browser-commit-gate.ts).
//
// A card's picture is evidence for one decision and is deleted when the card
// settles. A server that stops while a card is open never settles it, so the
// picture would stay in the attachments folder for good. This list is how
// the next start finds those pictures: every one named here when the server
// starts was left behind, because no hold outlives the process that held it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** What saveImage names a JPEG: a UUID, so nothing here is ever a path. */
const SHOT_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jpe?g$/i;

export class HoldShots {
  private readonly file: string;
  private readonly dir: string;
  private readonly remove: (path: string) => void;
  private names = new Set<string>();

  /** `file` is the list on disk; `dir` the attachments folder the pictures
   * are in; `remove` deletes one attachment (deleteAttachment). */
  constructor(file: string, dir: string, remove: (path: string) => void) {
    this.file = file;
    this.dir = dir;
    this.remove = remove;
  }

  /** A card is about to show this picture. It is listed first: when it
   * cannot be, it is deleted and this throws, because a picture nothing
   * will ever delete must not be shown. */
  keep(path: string): string {
    const name = basename(path);
    if (!SHOT_NAME.test(name) || resolve(dirname(path)) !== resolve(this.dir)) throw new Error("not a screenshot in the attachments folder");
    this.names.add(name);
    try { this.save(); }
    catch (error) {
      this.names.delete(name);
      this.remove(path);
      throw error;
    }
    return path;
  }

  /** The card settled: delete its picture. */
  drop(path: string): void {
    this.remove(path);
    if (!this.names.delete(basename(path))) return;
    try { this.save(); } catch { /* the next start deletes what is listed; the file is already gone */ }
  }

  /** At server start: delete every picture the last run left listed.
   * Returns how many. A damaged list deletes nothing it cannot be sure of. */
  sweep(): number {
    let listed: unknown;
    try { listed = JSON.parse(readFileSync(this.file, "utf8")); }
    catch { return 0; }
    const names = (Array.isArray(listed) ? listed : []).filter((name): name is string => typeof name === "string" && SHOT_NAME.test(name));
    for (const name of names) this.remove(join(this.dir, name));
    this.names.clear();
    try { this.save(); } catch { /* nothing left to list */ }
    return names.length;
  }

  private save(): void {
    const draft = `${this.file}.tmp`;
    writeFileSync(draft, JSON.stringify([...this.names]), { mode: 0o600 });
    renameSync(draft, this.file);
  }
}
