import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import { ImportedNotesPanel, type ImportedNotesActions } from "./ImportedNotes";

const actions = new Proxy({}, { get: () => () => undefined }) as ImportedNotesActions;
const NOTES = [
  { name: "food.md", title: "Food", aliases: ["dinner"], bytes: 120, entries: 3, imported: 2 },
  { name: "family.md", title: "Family", aliases: [], bytes: 60, entries: 1, imported: 0 },
];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const render = (props: Partial<Parameters<typeof ImportedNotesPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(ImportedNotesPanel, { notes: NOTES, open: null, canDeleteImported: true, busy: false, error: false, actions, ...props }));

describe("the imported notes list", () => {
  it("lists each subject with what it holds, open and delete, and the way to take back everything imported", () => {
    const html = render();
    const words = text(html);
    expect(words).toContain("Imported notes");
    expect(words).toContain("Food facts: 3, imported: 2");
    expect(words).toContain("Family facts: 1, imported: 0");
    expect(html.match(/>Open</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Delete Food"');
    expect(words).toContain("Delete everything imported");
  });

  it("shows the open note's text in an editor with Save", () => {
    const html = render({ open: { name: "food.md", text: "- Hates olives\n" } });
    expect(html).toContain('aria-label="Text of Food"');
    expect(html).toContain("- Hates olives");
    expect(text(html)).toContain("Save");
    expect(html.match(/<textarea/g)).toHaveLength(1);
  });

  it("is not shown when there is nothing to list or take back, and offers no bulk delete without imports", () => {
    expect(render({ notes: [], canDeleteImported: false })).toBe("");
    expect(text(render({ canDeleteImported: false }))).not.toContain("Delete everything imported");
    // only About me lines were imported: the list is empty but the way back is there
    expect(text(render({ notes: [], canDeleteImported: true }))).toContain("Delete everything imported");
    expect(text(render({ error: true }))).toContain("Could not update shared notes. Try again.");
  });
});
