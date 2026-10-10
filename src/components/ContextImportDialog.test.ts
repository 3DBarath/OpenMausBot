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
const ENGINES = [{ botId: "bot-1", name: "Scout", available: true, keepsText: false }, { botId: "bot-2", name: "Relay", available: false }, { botId: "bot-3", name: "Agent", available: true, keepsText: true }, { botId: "bot-4", name: "Older", available: true }];
const SCAN = { format: "chatgpt" as const, conversations: 1_240, withOwnMessages: 1_180, oldest: new Date(2023, 0, 5).getTime(), newest: new Date(2026, 9, 8).getTime(), ownChars: 2_400_000, alreadyRead: 12, skipped: { conversations: 3, messages: 40, oversized: 1, entries: ["big/conversations.json: larger than 2 GB once unpacked"], secrets: 7, overLimit: 0 }, truncated: true };

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
    const { html, words } = render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 500, chars: 1_900_000, calls: 81, maxCalls: 160, minSeconds: 810, maxSeconds: 3_807 } }));
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
    // An engine that cannot be told to keep no record of the text, or that
    // does not say, is named as such beside the choice, before reading starts.
    const KEEPS = "This engine may keep its own record of the text it is sent. OpenMausBot deletes its own copies either way.";
    const scanned = (botId: string) => render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 500, chars: 1_900_000, calls: 81, maxCalls: 160, minSeconds: 810, maxSeconds: 3_807 } }), { botId });
    expect(words).not.toContain(KEEPS);
    expect(scanned("bot-3").words).toContain(KEEPS);
    expect(scanned("bot-3").html).toMatch(/role="note"[^>]*>This engine may keep its own record/);
    // an answer the server did not give is not a "no"
    expect(scanned("bot-4").words).toContain(KEEPS);
    // nothing is chosen yet: nothing to say
    expect(scanned("").words).not.toContain(KEEPS);
    const none = render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 0, chars: 0, calls: 0, maxCalls: 0, minSeconds: 0, maxSeconds: 0 } }));
    expect(none.words).toContain("Nothing to read in this range. Widen the dates.");
    expect(none.html).toMatch(/<button[^>]*disabled=""[^>]*>Start reading/);
    expect(render(job({ status: "scanned", scan: SCAN, slice, estimate: { conversations: 500, chars: 1_900_000, calls: 81, maxCalls: 160, minSeconds: 810, maxSeconds: 3_807 } }), { botId: "" }).html).toMatch(/<button[^>]*disabled=""[^>]*>Start reading/);
  });

  it("shows progress with pause, and a paused job with its reason and resume", () => {
    const progress = { batches: 81, done: 20, skipped: 2, candidates: 143, duplicates: 9, droppedSecrets: 0, droppedInstructions: 0 };
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
    const { html, words } = render(job({ status: "review", candidates, progress: { batches: 3, done: 3, skipped: 1, candidates: 5, duplicates: 0, droppedSecrets: 0, droppedInstructions: 0 } }));
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
    const result: ImportSaveResult = { aboutMe: 12, overflowed: 3, subjects: 9, entries: 88, duplicates: 4, full: [{ subject: "Work", dropped: 6, reason: "bytes" }], aboutMeText: "" };
    const { words } = render(null, { result });
    expect(words).toContain("Saved: 12 to About me, 88 to shared notes.");
    expect(words).toContain("About me was full. Core facts filed under their subject in shared notes instead: 3.");
    expect(words).toContain("“Work” is full. Facts not saved: 6.");
    expect(words).toContain("Already known and left out: 4.");
    expect(words).toContain("The export and everything read from it have been deleted.");
    // after a save: the way to have what was saved used in conversations from before
    expect(words).toContain("Use my notes in my existing conversations");
    expect(words).toContain("Use it only if nobody else has written in them.");
    // an export that could not be deleted is said, with where it is, and never called deleted
    const left = render(null, { result: { ...result, notDeleted: "/data/context-import" } });
    expect(left.words).toContain("the export could not be deleted from this computer. Delete this folder yourself: /data/context-import");
    expect(left.words).not.toContain("have been deleted");
  });

  it("says what the screen left out, what an import costs at most, and how long an unfinished one is kept", () => {
    const scanned = render(job({ status: "scanned", scan: SCAN, slice: { from: 0, to: 1, cap: 500 }, estimate: { conversations: 500, chars: 1_000_000, calls: 44, maxCalls: 86, minSeconds: 440, maxSeconds: 2_068 } }));
    expect(scanned.words).toContain("Messages that held a password, a card number or an identity or bank number: 7. That part was cut out before any AI model read them.");
    expect(scanned.words).toContain("At most 86 calls, if every part has to be read twice.");
    expect(scanned.words).toContain("An import you leave unfinished is deleted, with the export, after 14 days.");
    expect(render(job({ status: "created" })).words).toContain("The upload has to arrive within 5 minutes.");
    // a list that was read only in part is named, with how far the read got
    const cut = render(job({ status: "scanned", scan: { ...SCAN, skipped: { ...SCAN.skipped, cut: ["conversations.json: stopped after its first 2,000,000 items"] } }, slice: { from: 0, to: 1, cap: 500 }, estimate: { conversations: 1, chars: 1, calls: 2, maxCalls: 3, minSeconds: 1, maxSeconds: 2 } }));
    expect(cut.words).toContain("Read in part: conversations.json: stopped after its first 2,000,000 items. The rest of that list was not read.");
    expect(scanned.words).not.toContain("Read in part");
    const over = render(job({ status: "scanned", scan: { ...SCAN, skipped: { ...SCAN.skipped, overLimit: 1_900_000 } }, slice: { from: 0, to: 1, cap: 500 }, estimate: { conversations: 1, chars: 1, calls: 2, maxCalls: 3, minSeconds: 1, maxSeconds: 2 } }));
    expect(over.words).toContain("This export holds more conversations than one import scans. Not scanned: 1,900,000.");
  });

  it("offers to skip the parts the engine failed, and shows a save that will not fit before it is pressed", () => {
    const progress = { batches: 9, done: 3, skipped: 0, candidates: 40, duplicates: 2, droppedSecrets: 2, droppedInstructions: 1 };
    const paused = render(job({ status: "paused", pausedBy: "engine", failedBatches: 3, note: "The engine failed 3 times in a row.", progress }));
    expect(paused.words).toContain("Skip 3 parts and continue");
    expect(paused.words).toContain("Resume reads the 3 parts the engine failed again.");
    expect(paused.words).toContain("Proposed facts left out: 2 held a password or a number that identifies you, and 1 read like an instruction or held a command, code or a link.");
    // paused by the person: nothing failed, so nothing to skip
    expect(render(job({ status: "paused", pausedBy: "person", progress })).words).not.toContain("Skip");
    const review = render(job({
      status: "review", candidates: [fact("The person is vegetarian")], unreadAtLimit: 30, progress,
      fit: [{ kind: "files", needed: 5, room: 2 }, { kind: "bytes", subject: "Work", over: 12 }],
    }));
    expect(review.words).toContain("This import reached its limit of 2,000 facts. Conversations left unread: 30.");
    expect(review.words).toContain("Not everything you ticked fits, so nothing can be saved yet.");
    expect(review.words).toContain("These facts need 5 new shared notes and there is room for 2.");
    expect(review.words).toContain("“Work” would be too large: 12 facts do not fit.");
    expect(review.html).toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    expect(render(job({ status: "review", candidates: [fact("The person is vegetarian")], progress })).html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save/);
    // a fact the model called sensitive without naming a category says so
    expect(render(job({ status: "review", candidates: [fact("Reads tarot", { sensitive: "other", keep: false })] })).words).toContain("Sensitive");
  });

  it("lets a selection that does not fit be put right in a few clicks, and asks for a last look for secrets", () => {
    const candidates = [
      fact("The person is vegetarian", { kind: "core" }),
      fact("The person loves Irani cafes"),
      fact("The person ships on Fridays", { subject: "Work" }),
      fact("The person takes medication for asthma", { subject: "Health", sensitive: "health", keep: false }),
    ];
    const { html, words } = render(job({ status: "review", candidates, fit: [{ kind: "bytes", subject: "Work", over: 12 }] }));
    // one action for the whole selection
    expect(words).toContain("Keep what fits and untick the rest");
    expect(words).toContain("The newest facts stay ticked. Unticked facts stay in this list and are not saved.");
    // a tick and an untick for each group
    expect(html.match(/>Tick all</g)).toHaveLength(4);
    expect(html.match(/>Untick all</g)).toHaveLength(4);
    // each fact filed under a subject can be moved to another one, or to a new one, by name
    expect(html.match(/aria-label="Subject for this fact"/g)).toHaveLength(3);
    expect(html).toMatch(/<datalist id="context-import-subjects">.*<option value="Food"><\/option>.*<option value="Work"><\/option>/s);
    // a last look, because the screen does not catch everything
    expect(words).toContain("Before you save, look through these for passwords, PINs and codes.");
    // without a problem there is no such action
    expect(render(job({ status: "review", candidates })).words).not.toContain("Keep what fits");
  });

  it("shows why a job failed, and an error from the last request", () => {
    const failed = render(job({ status: "failed", error: "No ChatGPT or Claude conversations were found in that file." }));
    expect(failed.words).toContain("The import could not continue");
    expect(failed.words).toContain("No ChatGPT or Claude conversations were found in that file.");
    expect(failed.words).toContain("Start again");
    expect(render(null, { error: "An import is already open." }).html).toContain('role="alert"');
  });
});
