// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { getDraftAttachments, isDraftAttachmentPending, restoreComposerDraft } from "@/lib/drafts";

const source = { botId: "source-bot", botName: "Research", threadId: "source-thread", title: "Source conversation" };
const draftId = "bot:recipient:recipient-thread";
const otherDraftId = "bot:other:other-thread";
let root: Root;
let container: HTMLDivElement;
let opener: HTMLButtonElement;
let onFiles: Mock<() => void>;
let onClose: Mock<() => void>;

beforeEach(() => {
  for (const id of [draftId, otherDraftId]) restoreComposerDraft(id, { text: "Keep this draft", attachments: [] });
  opener = document.createElement("button");
  container = document.createElement("div");
  document.body.append(opener, container);
  opener.focus();
  root = createRoot(container);
  onFiles = vi.fn();
  onClose = vi.fn(() => root.render(null));
  flushSync(() => root.render(createElement(ComposerAttachmentMenu, {
    threads: [source], threadId: "recipient-thread", draftId, onFiles, onClose,
  })));
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  opener.remove();
  for (const id of [draftId, otherDraftId]) restoreComposerDraft(id, { text: "", attachments: [] });
  vi.unstubAllGlobals();
});

function click(text: string) {
  const button = [...document.querySelectorAll("[role=dialog] button")].find(button => button.textContent?.includes(text));
  expect(button, text).toBeTruthy();
  flushSync(() => (button as HTMLButtonElement).click());
}
const settle = () => act(async () => { for (let round = 0; round < 8; round++) await Promise.resolve(); });

it("keeps file selection synchronous and restores focus when the menu closes", () => {
  click("Attach a file");
  expect(onFiles).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(opener);
});

it("fetches only the chosen authorized route, blocks Send while pending, and appends a frozen snapshot", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", fetcher);
  click("Add conversation");
  expect(fetcher).not.toHaveBeenCalled();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Search conversations");
  click(source.title);
  expect(isDraftAttachmentPending(draftId)).toBe(true);
  expect(fetcher).toHaveBeenCalledWith("/api/threads/source-thread/messages?limit=50", { signal: expect.any(AbortSignal) });
  resolve(new Response(JSON.stringify({ messages: [{ role: "user", kind: "text", text: "Frozen source" }] })));
  await settle();
  expect(isDraftAttachmentPending(draftId)).toBe(false);
  expect(getDraftAttachments(localStorage, draftId)).toEqual([expect.objectContaining({ kind: "conversation", text: expect.stringContaining("Frozen source") })]);
  expect(getDraftAttachments(localStorage, otherDraftId)).toEqual([]);
  expect(onClose).toHaveBeenCalledOnce();
});

it.each(["close", "unmount"])("aborts on %s and ignores even a response that arrives after cancellation", async mode => {
  let resolve!: (response: Response) => void;
  let signal!: AbortSignal;
  vi.stubGlobal("fetch", vi.fn((_url, options) => {
    signal = options.signal;
    return new Promise<Response>(done => { resolve = done; });
  }));
  click("Add conversation");
  click(source.title);
  if (mode === "close") {
    flushSync(() => document.querySelector("[role=dialog]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  } else {
    flushSync(() => root.render(null));
  }
  expect(signal.aborted).toBe(true);
  resolve(new Response(JSON.stringify({ messages: [{ role: "user", text: "Late source" }] })));
  await settle();
  expect(isDraftAttachmentPending(draftId)).toBe(false);
  expect(getDraftAttachments(localStorage, draftId)).toEqual([]);
  expect(getDraftAttachments(localStorage, otherDraftId)).toEqual([]);
});

it("shows revoked access without attaching anything and allows another choice", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ role: "bot", text: "Available now" }] })));
  vi.stubGlobal("fetch", fetcher);
  click("Add conversation");
  click(source.title);
  await settle();
  expect(document.querySelector("[role=alert]")?.textContent).toContain("access has changed");
  expect(isDraftAttachmentPending(draftId)).toBe(false);
  expect(getDraftAttachments(localStorage, draftId)).toEqual([]);
  click(source.title);
  await settle();
  expect(getDraftAttachments(localStorage, draftId)).toHaveLength(1);
});
