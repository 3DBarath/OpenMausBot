import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { OptionCardData } from "../shared/wire.ts";
import type { BrowserCommitGate } from "./browser-commit-gate.ts";
import { settledWaitingChip } from "./waiting-on-person.ts";

// Execute the actual index callbacks and shared chip wiring, without starting
// a server or provider. The HTTP/browser recipe remains the integration check.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function between(start: string, end: string, from = 0) {
  const first = source.indexOf(start, from);
  const last = source.indexOf(end, first);
  if (first < 0 || last <= first) throw new Error(`Missing index wiring: ${start}`);
  return source.slice(first, last);
}
const code = ts.transpileModule(`${between("const waitingOnPersonChips =", "function activeRoutineRunForThread(")}
const hooks = {${between("  post: ({ botId, threadId, card }) => {", "  resume: (botId, threadId) => {", source.indexOf("const browserCommitGate ="))}};`,
{ compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
type Hooks = Pick<ConstructorParameters<typeof BrowserCommitGate>[0], "post" | "patch">;
type Message = { id: string; card?: OptionCardData; tool?: { name: string; ok?: boolean }; threadRef?: { botId: string; threadId: string; title: string } };

function fixture(delegated = true) {
  const threads = new Map<string, Message[]>();
  const messagesFor = (threadId: string) => {
    if (!threads.has(threadId)) threads.set(threadId, []);
    return threads.get(threadId)!;
  };
  let nextId = 0;
  const bot = { id: "pepper", name: "Pepper", color: "green" };
  const store = {
    bot: () => bot,
    messagesFor,
    appendMessage: (threadId: string, message: Omit<Message, "id">) => {
      const saved = { ...message, id: `message-${++nextId}` };
      messagesFor(threadId).push(saved);
      return saved;
    },
    patchMessage: (threadId: string, messageId: string, change: Partial<Message>) => {
      const message = messagesFor(threadId).find((row) => row.id === messageId);
      if (message) Object.assign(message, change);
    },
    taskByThread: () => ({ title: "Draft reply", busy: false }),
  };
  const hooks = new Function("store", "delegatorOf", "settledWaitingChip", "connectorThread", "activeGroupTurnForBot", "notify", "buildNotification",
    `${code}; return hooks;`)(store, () => delegated ? { threadId: "requester" } : undefined, settledWaitingChip, () => undefined, () => undefined, () => {}, () => ({})) as Hooks;
  const post = (requestId = "request-1", threadId = "teammate") => hooks.post({ botId: bot.id, threadId,
    card: { title: "Send on your behalf?", subtitle: "Send fixture reply", options: [], requestId } });
  return { ...hooks, post, messagesFor, store };
}

describe("delegated browser approval chips", () => {
  it("links the requesting conversation to the teammate's browser card", () => {
    const f = fixture();
    f.post();
    expect(f.messagesFor("requester")).toHaveLength(1);
    expect(f.messagesFor("requester")[0]).toMatchObject({
      tool: { name: "Waiting on your approval in @Pepper" },
      threadRef: { botId: "pepper", threadId: "teammate", title: "Draft reply" },
    });
  });

  it.each([
    ["allow", "@Pepper got your approval", true],
    ["deny", "@Pepper's request was denied", false],
    ["unavailable", "@Pepper's approval closed before anyone answered — that step did not run", false],
  ] as const)("settles %s from the stored card without attributing a system close to the person", (answered, name, ok) => {
    const f = fixture();
    const id = f.post();
    // The respond route stores the person's answer before the gate's final
    // picture cleanup. A system close instead supplies its final card here.
    if (answered !== "unavailable") f.store.patchMessage("teammate", id, { card: { ...f.messagesFor("teammate")[0]!.card!, answered } });
    f.patch("teammate", id, (card) => answered === "unavailable" ? { ...card, answered, dismissed: true } : card);
    expect(f.messagesFor("requester")[0]?.tool).toEqual({ name, ok });
    // A late patch cannot rewrite an already settled chip.
    f.patch("teammate", id, (card) => ({ ...card, answered: "unavailable" }));
    expect(f.messagesFor("requester")[0]?.tool).toEqual({ name, ok });
  });

  it("settles only the matching card, not another card or another thread with the same request id", () => {
    const f = fixture();
    const first = f.post("first");
    const second = f.post("second");
    const otherThread = f.post("first", "other-teammate");
    f.patch("teammate", first, (card) => ({ ...card, answered: "deny" }));
    expect(f.messagesFor("requester").map((row) => row.tool)).toEqual([
      { name: "@Pepper's request was denied", ok: false },
      { name: "Waiting on your approval in @Pepper" },
      { name: "Waiting on your approval in @Pepper" },
    ]);
    f.patch("teammate", second, (card) => ({ ...card, answered: "allow" }));
    f.patch("other-teammate", otherThread, (card) => ({ ...card, answered: "unavailable", dismissed: true }));
    expect(f.messagesFor("requester").map((row) => row.tool?.ok)).toEqual([false, true, false]);
    expect(f.messagesFor("requester").some((row) => row.tool?.name.startsWith("Waiting"))).toBe(false);
  });

  it("reports a now-unavailable approved card as closed, not as a successful approval", () => {
    const f = fixture();
    const id = f.post();
    f.store.patchMessage("teammate", id, { card: { ...f.messagesFor("teammate")[0]!.card!, answered: "allow" } });
    // Page changes, cancellation or a vanished turn can invalidate the stored
    // approval before dispatch. The gate's final state is authoritative.
    f.patch("teammate", id, (card) => ({ ...card, answered: "unavailable", dismissed: true }));
    expect(f.messagesFor("requester")[0]?.tool).toEqual({
      name: "@Pepper's approval closed before anyone answered — that step did not run", ok: false,
    });
  });

  it("keeps an unanswered card waiting, and creates no parent chip for direct work", () => {
    const f = fixture();
    const id = f.post();
    f.patch("teammate", id, (card) => ({ ...card, subtitle: "Updated description" }));
    expect(f.messagesFor("requester")[0]?.tool).toEqual({ name: "Waiting on your approval in @Pepper" });
    const direct = fixture(false);
    direct.post();
    expect(direct.messagesFor("requester")).toEqual([]);
  });
});
