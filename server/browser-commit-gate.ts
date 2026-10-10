// The commit hold. A bot's browser tools are pre-approved on every engine,
// so a click that sends, posts, pays or books would otherwise happen with
// no card at any approval level. Every browser tools/call passes through
// here on its way to BrowserRuntime.agentRpc: a click or an Enter press is
// read from the page first (browser-commit-page.ts), judged by fixed rules
// (shared/browser-commit.ts), and a commitment waits for the person exactly
// the way an outbound connected-app call does — same request service, same
// card marker, same daily allowance, same respond route.
//
// The approval is for what the person was shown. It is bound to a digest of
// the address, the target and the form's fields; if any of them changed by
// the time the answer arrives, the approval is void and a new card is raised.
import { createHash } from "node:crypto";

import { COMMIT_TITLE, classifyCommit, commitRule, enterPress, scriptAction } from "../shared/browser-commit.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../shared/outbound.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { HELD_NOTE } from "./auto-approve.ts";

import type { CommitClass, CommitField, CommitTarget, ScriptAction } from "../shared/browser-commit.ts";
import type { OutboundPolicy } from "../shared/outbound.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { BrowserPageReader } from "./browser-commit-page.ts";
import type { BrowserRuntime } from "./browser-runtime.ts";
import type { DecisionRow } from "./decision-log.ts";
import type { OutboundCounts } from "./outbound-counts.ts";
import type { OutboundAnswer, OutboundRequestService } from "./outbound-requests.ts";

/** The stdio proxy must outlast a hold, or the bot's call dies while the
 * card is still open. */
const PROXY_MARGIN_MS = 30_000;
const PROXY_FLOOR_MS = 130_000;

/** How long harness-mcp-proxy may wait on one browser call: the hold window
 * and a margin, never more than the configured MCP call timeout, never less
 * than the limit every other harness tool keeps. */
export function browserCallTimeoutMs(holdMs: number, mcpCallTimeoutMs: number): number {
  return Math.max(PROXY_FLOOR_MS, Math.min(holdMs + PROXY_MARGIN_MS, mcpCallTimeoutMs));
}

const SCRIPT_REFUSAL: Record<ScriptAction, string> = {
  click: "it clicks or submits something",
  network: "it sends a network request",
  write: "it writes into the page",
  event: "it dispatches an event",
  navigation: "it navigates",
};
const DENIED = "OpenMausBot did not do this: the user declined. Do not retry it; ask the user what they would like instead.";
const UNANSWERED = "OpenMausBot did not do this: nobody answered the approval in time. Ask the user before trying again.";
const PAGE_CHANGED = "OpenMausBot did not do this: the page changed while it waited for approval, so the approval no longer matched. Take a new snapshot and continue from what the page shows now.";
const STILL_HELD = "OpenMausBot did not do this: the user approved it but is still using the browser. Wait for them to hand it back, take a new snapshot, and try again.";
const ALREADY_WAITING = "OpenMausBot did not do this: another approval is already waiting for this browser. Wait for the user's answer to that one first.";
const NOT_SAVED = "OpenMausBot did not do this: the daily allowance could not be saved. Nothing was sent.";
const UNREADABLE = "OpenMausBot did not do this: it could not read the page to check it first. Take a new snapshot and try again.";
const TYPED_ENTER = "OpenMausBot did not type this: a line break typed with agent_browser_type presses Enter, which would send or submit here. Enter the text with agent_browser_fill, then press Enter or click the button as its own step.";

export interface CommitGateDeps {
  runtime: Pick<BrowserRuntime, "hold" | "releaseHold" | "personReleased" | "ref" | "withAgentAction">;
  /** Shared with the connector hold, so the respond route settles both. */
  requests: Pick<OutboundRequestService, "open" | "forget">;
  counts: Pick<OutboundCounts, "reserve">;
  /** How long a hold waits for an answer. */
  holdMs: number;
  /** How long an approved call waits for a person to hand the browser back. */
  handBackMs?: number;
  /** The bot's outbound policy now, or null when the bot is gone. */
  policy(botId: string): OutboundPolicy | null;
  /** Put the card in the thread and tell the person; returns its message id. */
  post(input: { botId: string; threadId: string; card: OptionCardData }): string;
  /** Change a card this gate posted, if it is still there. */
  patch(threadId: string, messageId: string, change: (card: OptionCardData) => OptionCardData): void;
  /** The hold is over: the bot is working again. */
  resume(botId: string, threadId: string): void;
  log(row: Omit<DecisionRow, "at">): void;
  dropShot(path: string): void;
}

/** One browser tools/call on its way to the engine. */
export interface CommitCall {
  botId: string;
  botName: string;
  threadId: string;
  session: string;
  /** The tools/call params as the bot sent them. */
  params: unknown;
  page: BrowserPageReader;
  /** The server's own screenshot, saved as an attachment; its path. */
  shot(): Promise<string | undefined>;
  /** The route's admission checks. Throws when the call may not touch this browser. */
  admit(): void;
  /** The turn that made this call is still running. */
  active(): boolean;
  /** Aborts when the bot's request went away. */
  signal: AbortSignal;
  /** Run the call as the bot sent it. */
  dispatch(): Promise<unknown>;
}

interface Intent {
  via: "click" | "enter";
  /** The bot's selector, or null for the focused element. */
  selector: string | null;
  shift: boolean;
  /** Enter arrives inside text typed with agent_browser_type. */
  typed: boolean;
}

/** A commitment as the server saw it on the page. */
interface Sighting {
  class: CommitClass;
  host: string;
  /** What the card calls the action. */
  label: string;
  /** Fields as the card and the log show them: redacted and bounded. */
  shown: CommitField[];
  digest: string;
}

function refusal(text: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text }] };
}

function toolCall(params: unknown): { name: string; args: Record<string, unknown> } {
  const call = params && typeof params === "object" ? (params as { name?: unknown; arguments?: unknown }) : {};
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>) : {};
  return { name: typeof call.name === "string" ? call.name : "", args };
}

/** The calls that can commit. Everything else never does: fill, scroll, open,
 * every read. agent_browser_type is here only for a line break, which the
 * engine types as a real Enter key press. */
function commitIntent(name: string, args: Record<string, unknown>): Intent | null {
  if (name === "agent_browser_click") {
    return typeof args.selector === "string" ? { via: "click", selector: args.selector, shift: false, typed: false } : null;
  }
  if (name === "agent_browser_press") {
    const enter = enterPress(args.key);
    return enter ? { via: "enter", selector: null, shift: enter.shift, typed: false } : null;
  }
  if (name === "agent_browser_type" && typeof args.selector === "string" && typeof args.text === "string" && /[\r\n]/.test(args.text)) {
    return { via: "enter", selector: args.selector, shift: false, typed: true };
  }
  return null;
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A field as a person reads it on the card and as the log keeps it. */
function shownField(field: CommitField): CommitField {
  if (field.value === undefined) return { name: field.name, type: field.type, length: field.length ?? 0 };
  return { name: field.name, type: field.type, value: clip(redactSecretsInText(field.value.replace(/\s+/g, " ").trim()), 200) };
}

function fieldLine(field: CommitField): string {
  return field.value === undefined ? `${field.name}: ${field.length ?? 0} characters, not shown` : `${field.name}: ${field.value}`;
}

export class BrowserCommitGate {
  private readonly deps: CommitGateDeps;

  constructor(deps: CommitGateDeps) {
    this.deps = deps;
  }

  /** Run one browser tools/call: refuse it, hold it, or let it through.
   * Resolves with the tool result the bot receives. */
  async guard(call: CommitCall): Promise<unknown> {
    const { name, args } = toolCall(call.params);
    if (name === "agent_browser_eval") {
      const action = typeof args.script === "string" ? scriptAction(args.script) : null;
      if (!action) return call.dispatch();
      return refusal(`OpenMausBot did not run this script: ${SCRIPT_REFUSAL[action]}. Scripts are for reading the page. Use agent_browser_click, agent_browser_fill, agent_browser_press and agent_browser_open to act on it.`);
    }
    const intent = commitIntent(name, args);
    if (!intent) return call.dispatch();
    call.admit();
    const deadline = Date.now() + this.deps.holdMs;
    let seen = await this.look(call, intent);
    // Not knowing is not the same as nothing to hold.
    if (seen === "unreadable") return refusal(UNREADABLE);
    if (!seen) return call.dispatch();
    if (intent.typed) return refusal(TYPED_ENTER);

    const policy = this.deps.policy(call.botId) ?? DEFAULT_OUTBOUND_POLICY;
    const row = { threadId: call.threadId, botId: call.botId, botName: call.botName, tool: name };
    // Money always asks. A send spends from the bot's daily allowance when it
    // has one, and asks once that is used up.
    if (seen.class === "send" && policy.policy === "allow") {
      let reserved: number | null;
      try { reserved = this.deps.counts.reserve(call.botId, 1, policy.dailyCap); }
      catch { return refusal(NOT_SAVED); }
      if (reserved !== null) {
        this.deps.log({ ...row, summary: this.summary(seen), decision: "auto-approved", source: "outbound", rule: commitRule(seen.class, `daily-allowance:${reserved}/${policy.dailyCap}`) });
        return call.dispatch();
      }
    }

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !call.active()) return refusal(UNANSWERED);
      const held = this.deps.requests.open({ botId: call.botId, threadId: call.threadId, tool: name, timeoutMs: remaining });
      if (!this.deps.runtime.hold(call.session, held.requestId)) {
        this.deps.requests.forget(held.requestId);
        return refusal(ALREADY_WAITING);
      }
      const release = () => this.deps.runtime.releaseHold(call.session, held.requestId);
      let messageId: string;
      let shot: string | undefined;
      try {
        shot = await call.shot().catch(() => undefined);
        messageId = this.deps.post({ botId: call.botId, threadId: call.threadId, card: this.card(seen, name, held.requestId, shot) });
      } catch (error) {
        this.deps.requests.forget(held.requestId);
        release();
        if (shot) this.deps.dropShot(shot);
        throw error;
      }
      this.deps.log({ ...row, requestId: held.requestId, summary: this.summary(seen), decision: "card-shown", source: "outbound", rule: commitRule(seen.class) });

      const answer = await this.answerOrGone(held.answer, call);
      this.deps.requests.forget(held.requestId);
      // The screenshot is evidence for the decision, not a record: it goes
      // once the card is settled.
      if (shot) this.deps.dropShot(shot);
      const settle = (change: (card: OptionCardData) => Partial<OptionCardData> = () => ({}), pageChanged = false) => {
        this.deps.patch(call.threadId, messageId, (card) => {
          if (!card.browserCommit) return { ...card, ...change(card) };
          const { shot: _shot, ...evidence } = card.browserCommit;
          return { ...card, ...change(card), browserCommit: pageChanged ? { ...evidence, pageChanged: true } : evidence };
        });
      };
      const kind = seen.class;
      const close = (outcome: string) => this.deps.log({ ...row, requestId: held.requestId, decision: "auto-denied", source: "outbound", rule: commitRule(kind, outcome) });
      if (call.active()) this.deps.resume(call.botId, call.threadId);

      if (answer === "deny") {
        release();
        settle();
        return refusal(DENIED);
      }
      if (answer !== "allow") {
        // Nobody can answer this card any more: close it, as a connector hold's is.
        release();
        settle((card) => (card.answered ? {} : { answered: "unavailable", dismissed: true }));
        close("unanswered");
        return refusal(UNANSWERED);
      }

      // The person may be using the browser. Wait for it to come back, then
      // look again: the approval covers the page they were shown, no other.
      if (!await this.deps.runtime.personReleased(call.session, this.deps.handBackMs ?? 60_000)) {
        release();
        settle();
        close("browser-in-use");
        return refusal(STILL_HELD);
      }
      const now = await this.look(call, intent).catch(() => "unreadable" as const);
      if (now && now !== "unreadable" && now.digest === seen.digest) {
        settle();
        release();
        return call.dispatch();
      }
      release();
      if (now === "unreadable") {
        settle(() => ({ answered: "unavailable", dismissed: true }));
        close("unreadable");
        return refusal(UNREADABLE);
      }
      settle(() => ({ answered: "unavailable", dismissed: true }), true);
      close("page-changed");
      if (!now) return refusal(PAGE_CHANGED);
      seen = now;
    }
  }

  /** What the call would act on right now; null when it is no commitment (or
   * the engine has no such element and will say so itself); "unreadable"
   * when the page could not be read. Throws what the runtime gate throws
   * when a person has the browser. */
  private async look(call: CommitCall, intent: Intent): Promise<Sighting | null | "unreadable"> {
    const [found, url] = await this.deps.runtime.withAgentAction(
      call.session,
      () => Promise.all([call.page.target(intent.selector, intent.via === "enter"), call.page.url()]),
      "read",
    );
    if (found === "missing") return null;
    if (found === "unreadable") return "unreadable";
    const ref = intent.selector ? /^(?:@|ref=)?(e\d+)$/.exec(intent.selector)?.[1] : undefined;
    const known = ref ? this.deps.runtime.ref(call.session, ref) : undefined;
    let target: CommitTarget;
    let fields: CommitField[] = [];
    if (found === "hidden") {
      // Inside a frame the page read cannot reach. The snapshot's own name
      // for the ref is all there is to judge a click by.
      if (!known || intent.via !== "click") return null;
      const box = known.role === "searchbox" ? "search" : known.role === "textbox" ? "single" : null;
      target = { via: "click", label: known.name, role: known.role, box, submits: false, search: box === "search", card: false, multiline: false };
    } else {
      fields = found.fields;
      target = { via: intent.via, shift: intent.shift, label: found.label, role: found.role, box: found.box, submits: found.submits, search: found.search, card: found.card, multiline: found.multiline };
    }
    // The snapshot's name is the browser's own; the page read's is ours. A
    // click is held when either one names a commitment.
    const labels = intent.via === "click" && known?.name && known.name !== target.label ? [target.label, known.name] : [target.label];
    const classes = labels.map((label) => classifyCommit({ ...target, label }));
    const kind: CommitClass | null = classes.includes("money") ? "money" : classes.includes("send") ? "send" : null;
    if (!kind) return null;
    const named = labels[classes.indexOf(kind)] || labels.find(Boolean) || `unlabelled ${target.role || "control"}`;
    const label = intent.via === "enter" && target.box === "multiline" && !target.submits ? `Enter in ${named}` : named;

    let address = "";
    let host = "this page";
    try {
      const parsed = new URL(url ?? "");
      parsed.hash = "";
      address = parsed.href;
      host = parsed.host || host;
    } catch { /* an address the engine would not give is part of the digest as "" */ }
    const digest = createHash("sha256").update(JSON.stringify([
      address, intent.via, target.label, known?.name ?? null, target.role,
      fields.map((field) => [field.name, field.type, field.value ?? null, field.length ?? null]),
    ])).digest("hex");
    return { class: kind, host, label: clip(label, 120), shown: fields.map(shownField), digest };
  }

  /** Host and label first, the way every send card's subtitle starts, then
   * the fields: enough to decide on for a client that knows nothing else. */
  private summary(seen: Sighting): string {
    return clip([`${seen.host} · ${seen.label}`, ...seen.shown.map(fieldLine)].join("\n"), 1_500);
  }

  private card(seen: Sighting, tool: string, requestId: string, shot: string | undefined): OptionCardData {
    const money = seen.class === "money";
    return {
      title: COMMIT_TITLE[seen.class],
      subtitle: this.summary(seen),
      options: ["Allow", "Deny"],
      requestId,
      tool,
      held: HELD_NOTE[money ? "approval.held.money" : "approval.held.outbound"],
      heldCode: money ? "approval.held.money" : "approval.held.outbound",
      // The marker every send card carries, so every rule written for sends
      // applies to a browser hold unchanged.
      outboundRequest: { tool, app: seen.host, calls: [{ app: seen.host, label: seen.label }] },
      browserCommit: { class: seen.class, host: seen.host, label: seen.label, fields: seen.shown, ...(shot ? { shot } : {}) },
    };
  }

  /** The person's answer, a timeout, or "gone" when the bot's call is: its
   * turn ended or its request closed, so nobody is waiting for the answer. */
  private answerOrGone(answer: Promise<OutboundAnswer>, call: CommitCall): Promise<OutboundAnswer | "gone"> {
    return new Promise((resolve) => {
      const done = (value: OutboundAnswer | "gone") => {
        clearInterval(watch);
        call.signal.removeEventListener("abort", gone);
        resolve(value);
      };
      const gone = () => done("gone");
      const watch = setInterval(() => { if (!call.active()) gone(); }, 1_000);
      watch.unref?.();
      call.signal.addEventListener("abort", gone, { once: true });
      if (call.signal.aborted) gone();
      void answer.then(done);
    });
  }
}
