// Every step of the import dialog, rendered from a job the way the server
// describes it: what the person is told before anything is spent, that
// sensitive facts start unticked under their own heading, and what the last
// page says about what was saved and deleted.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import type { ImportCandidate, ImportJobView, ImportSaveResult } from "../../shared/context-import";
import { ContextImportPanel, type ContextImportActions, type ContextImportDraft } from "./ContextImportDialog";

const actions = new Proxy({}, { get: () => () => undefined }) as ContextImportActions;
const DRAFT: ContextImportDraft = { origin: "chatgpt", fileName: null, text: "", from: "", to: "", cap: "", botId: "bot-1", busy: false, error: "", copied: false, result: null };
const ENGINES = [{ botId: "bot-1", name: "Scout", available: true }, { botId: "bot-2", name: "Relay", available: false }];
const SCAN = { format: "chatgpt" as const, conversations: 1_240, withOwnMessages: 1_180, oldest: new Date(2023, 0, 5).getTime(), newest: new Date(2026, 9, 8).getTime(), ownChars: 2_400_000, alreadyRead: 12, skipped: { conversations: 3, messages: 40, oversized: 1, entries: ["big/conversations.json: larger than 2 GB once unpacked"] }, truncated: true };

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
function render(job: ImportJobView | null, draft: Partial<ContextImportDraft> = {}): { html: string; words: string } {
  const html = renderToStaticMarkup(createElement(ContextImportPanel, { job, engines: ENGINES, draft: { ...DRAFT, ...draft }, actions }));
  return { html, words: text(html) };
}
const job = (over: Partial<ImportJobView>): ImportJobView => ({ id: "j1", origin: "chatgpt", status: "created", ...over });
const fact = (textOf: string, over: Partial<ImportCandidate> = {}): ImportCandidate =>
  ({ id: textOf, text: textOf, kind: "subject", subject: "Food", aliases: [], date: "2026-03-02", sensitive: null, chatTitle: "Dinner ideas", keep: true, ...over });

describe("the import dialog, step by step", () => {
  it("offers the three sources and says where each export comes from", () => {
    const { html, words } = render(null);
    expect(words).toContain("ChatGPT export");
    expect(words).toContain("Settings → Data controls → Export data");
    expect(words).toContain("Claude export");
    expect(words).toContain("Settings → Privacy → Export data");
    expect(words).toContain("Pasted text");
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>.*?ChatGPT export/s);
  });

  it("asks for the file, with the size limit and what to do past it", () => {
    const { html, words } = render(job({ status: "created" }));
    expect(html).toContain('type="file"');
    expect(words).toContain("Up to 4 GB. If the zip is larger, unzip it and choose conversations.json by itself.");
    expect(words).toContain("deleted when you save or cancel");
    // nothing to upload yet
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Upload and scan/);
    expect(render(job({ status: "created" }), { fileName: "export.zip" }).html).not.toMatch(/<button[^>]*disabled=""[^>]*>Upload and scan/);
  });

  it("asks for pasted text, with where ChatGPT keeps its memories and a prompt to copy", () => {
    const { html, words } = render(job({ origin: "paste" }), { origin: "paste", text: "I am vegetarian." });
    expect(words).toContain("Settings → Personalization → Memory → Manage");
    expect(words).toContain("Write out everything you know about me");
    expect(words).toContain("Copy prompt");
    expect(words).toContain("16 of 100,000 characters");
    expect(html).toContain('maxLength="100000"');
  });

  it("says no model is used while it uploads and scans", () => {
    expect(render(job({ status: "uploading", uploadedBytes: 734_003_200 })).words).toContain("Uploading… 700 MB");
    expect(render(job({ status: "scanning" })).words).toContain("No AI model is used for this step.");
  });

  it("shows what was found, the default read, the estimate and which bots can read it, before anything is spent", () => {
    const slice = { from: new Date(2025, 9, 10).getTime(), to: new Date(2026, 9, 10, 12).getTime(), cap: 500 };
    const { html, words } = render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 500, chars: 1_900_000, calls: 81, minSeconds: 810, maxSeconds: 3_807 } }));
    expect(words).toContain("Conversations: 1,240. With messages of yours: 1,180. Characters you wrote: 2,400,000.");
    expect(words).toContain("From 2023-01-05 to 2026-10-08.");
    expect(words).toContain("Read by an earlier import and left out: 12.");
    expect(words).toContain("Skipped because this version does not know their shape: 4.");
    expect(words).toContain("Not read: big/conversations.json: larger than 2 GB once unpacked");
    expect(words).toContain("The file ended early");
    expect(html).toMatch(/<input type="date"[^>]*value="2025-10-10"/);
    expect(html).toMatch(/<input type="date"[^>]*value="2026-10-10"/);
    expect(html).toMatch(/<input type="number" min="1" max="2000"[^>]*value="500"/);
    expect(words).toContain("Conversations to read: 500. AI calls: about 81. Time: about 14 to 64 min.");
    expect(words).toContain("Nothing the assistant said.");
    expect(html).toMatch(/<option value="bot-1"[^>]*>Scout<\/option>/);
    expect(html).toMatch(/<option value="bot-2" disabled="">Relay \(its engine cannot make the quick call an import uses\)<\/option>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Start reading/);
    // nothing in range, or no bot picked: the button is off
    const none = render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 0, chars: 0, calls: 0, minSeconds: 0, maxSeconds: 0 } }));
    expect(none.words).toContain("Nothing to read in this range. Widen the dates.");
    expect(none.html).toMatch(/<button[^>]*disabled=""[^>]*>Start reading/);
    expect(render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 500, chars: 1_900_000, calls: 81, minSeconds: 810, maxSeconds: 3_807 } }), { botId: "" }).html).toMatch(/<button[^>]*disabled=""[^>]*>Start reading/);
  });

  it("shows progress with pause, and a paused job with its reason and resume", () => {
    const progress = { batches: 81, done: 20, skipped: 2, candidates: 143, duplicates: 9 };
    const reading = render(job({ status: "extracting", progress }));
    expect(reading.words).toContain("Parts read: 20 of 81. Facts found so far: 143.");
    expect(reading.words).toContain("Parts that could not be read and were skipped: 2.");
    expect(reading.html).toMatch(/<progress[^>]*max="81"[^>]*value="20"/);
    expect(reading.words).toContain("Pause");
    expect(reading.words).toContain("You can close this window.");
    const paused = render(job({ status: "paused", pausedBy: "engine", progress, note: "The engine failed 3 times in a row, so the import paused itself." }));
    expect(paused.words).toContain("The engine failed 3 times in a row");
    expect(paused.words).toContain("Resume");
    expect(render(job({ status: "paused", pausedBy: "restart", progress })).words).toContain("Paused because OpenMausBot restarted.");
    expect(render(job({ status: "consolidating", progress })).words).toContain("Checking for facts that disagree");
  });

  it("lists facts for review: Core first, sensitive ones unticked under their own heading, a replaced one marked", () => {
    const candidates = [
      fact("The person loves Irani cafes"),
      fact("The person is vegetarian", { kind: "core" }),
      fact("The person takes medication for asthma", { subject: "Health", sensitive: "health", keep: false }),
      fact("The person lives in Mumbai", { subject: "Home", keep: false, replacedBy: "x", chatTitle: "" }),
      fact("The person is in Goa", { subject: "Home", until: "2099-01-05" }),
    ];
    const { html, words } = render(job({ status: "review", candidates, progress: { batches: 3, done: 3, skipped: 1, candidates: 5, duplicates: 0 } }));
    expect(words.indexOf("Core")).toBeLessThan(words.indexOf("Sensitive"));
    expect(words).toContain("Goes to About me, which every bot reads on every message. At most 30 facts.");
    expect(words).toContain("Nothing is saved until you press Save.");
    expect(words).toContain("from “Dinner ideas”, 2026-03-02");
    expect(words).toContain("Replaced by a newer fact");
    expect(words).toContain("until 2099-01-05");
    expect(words).toContain("Health, money, relationships, politics or religion. Left unticked unless you choose to keep them.");
    expect(words).toContain("Parts that could not be read and were skipped: 1.");
    expect(words).toContain("1 to About me, 2 to shared notes.");
    // five tick boxes, three ticked; the asthma fact is not one of them
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    expect(html.match(/<input type="checkbox"[^>]*checked=""/g)).toHaveLength(3);
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*\/>(?:(?!type="checkbox").)*medication for asthma/s);
    expect(html).toContain('value="The person is vegetarian"');
    expect(html).toContain('value="Food"');
    expect(words).toContain("Move to Core");
    expect(words).toContain("Move to Food");
    expect(render(job({ status: "review", candidates: [] })).words).toContain("Nothing new was found.");
  });

  it("says what was saved, what did not fit and that the export is gone", () => {
    const result: ImportSaveResult = { aboutMe: 12, continued: 3, subjects: 9, entries: 85, duplicates: 4, full: [{ subject: "Work", dropped: 6, reason: "bytes" }], aboutMeText: "" };
    const { words } = render(null, { result });
    expect(words).toContain("Saved: 12 to About me, 88 to shared notes.");
    expect(words).toContain("About me was full. Core facts saved to a shared note called “About me, continued” instead: 3.");
    expect(words).toContain("“Work” is full. Facts not saved: 6.");
    expect(words).toContain("Already known and left out: 4.");
    expect(words).toContain("The export and everything read from it have been deleted.");
  });

  it("shows why a job failed, and an error from the last request", () => {
    const failed = render(job({ status: "failed", error: "No ChatGPT or Claude conversations were found in that file." }));
    expect(failed.words).toContain("The import could not continue");
    expect(failed.words).toContain("No ChatGPT or Claude conversations were found in that file.");
    expect(failed.words).toContain("Start again");
    expect(render(null, { error: "An import is already open." }).html).toContain('role="alert"');
  });
});
