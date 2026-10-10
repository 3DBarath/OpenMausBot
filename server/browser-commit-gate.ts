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
//
// When the gate cannot tell what a call would act on, it refuses or asks. It
// never sends.
//
// Every tool the bot has (server/browser-tool-shape.test.ts has the list),
// and why it can or cannot commit. Each row was run against agent-browser
// 0.37.0 on a local page.
//
// | Tool | What it does to a page | Here |
// |---|---|---|
// | click | A real click at the centre of the element's box. | Judged. |
// | check, uncheck | The same real click, on any element: a Send button too. | Judged as a click. |
// | select | Sets the value and fires `change`. No click. Commits when the page submits on change. | Judged as a click on the element, and as its form's submit when an inline handler submits. |
// | press | A real key press at the focus. Enter in any part of a chord submits or sends. | Enter is judged, in any position. Limit: Space on a focused button clicks it and is not judged. F5 and Ctrl+R do nothing in the pinned headless browser. |
// | type | Real key presses: "\n" is Enter and "\t" is Tab. It focuses the element, it does not click it. | Text ending in one line break is judged as Enter there. Any other text with a line break is refused: the focus may have moved. |
// | fill | Sets the value and fires `input`. No key press, no click; "\n" is not Enter. | Not judged. Limit: a field whose own `input` handler submits. |
// | eval | Runs the bot's script in the page. | Refused when its text acts (scriptAction). A guard, not a wall. |
// | reload | Sends a POST again when the page came from one. | Held after a commitment in this browser, until the bot opens another address. |
// | back, forward | Shows the page from history. Does not send a POST again, but a reload there does. | Not judged. Turns the reload hold back on. |
// | tab_switch, tab_close | Brings another tab to the front. | Not judged. Turns the reload hold back on. |
// | open | Navigates by GET. Refuses a `javascript:` address. | Not judged. Ends the reload hold when it goes to another address. |
// | tab_new | Opens a tab, by GET when given an address. | Not judged. |
// | read | Fetches an address as text by GET. The page does not move. | Not judged. |
// | scroll | Scrolls the page or an element. No click. | Not judged. |
// | snapshot, get_text, get_url, get_title, screenshot, tab_list, tools_profiles | Read only. | Not judged. |
// | wait_ms, wait_for_selector, wait_for_text, wait_for_load | Wait. | Not judged. |
// | close, restart_browser | Close the browser. | Not judged. End the reload hold. |
//
// Opening an address is a GET, and a GET can commit on a site built that way
// (a one-click unsubscribe link). That is outside what this gate reads.
import { createHash } from "node:crypto";

import { COMMIT_TITLE, classifyCommit, commitRule, enterPress, scriptAction } from "../shared/browser-commit.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../shared/outbound.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { HELD_NOTE } from "./auto-approve.ts";

import type { CommitClass, CommitField, CommitTarget, ScriptAction } from "../shared/browser-commit.ts";
import type { OutboundPolicy } from "../shared/outbound.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { BrowserPageReader, PageTarget } from "./browser-commit-page.ts";
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
const TYPED_BLIND = "OpenMausBot did not type this: with agent_browser_type a line break presses Enter and a tab moves the focus, so it could not check where Enter would land. Enter the text with agent_browser_fill, then press Enter or click the button as its own step.";
const UNDESCRIBED = "OpenMausBot did not do this: it could not check what this would act on. The element is inside a frame or has no visible area, and the last snapshot gave it no name. Take a new snapshot and use the element's @ref from a new snapshot.";
const BAD_SELECTOR = "OpenMausBot did not do this: it could not check that selector. Use an @ref from a snapshot, or a shorter selector that does not start with a dash.";

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
  /** Run these tools/call params: the bot's own, or the same call with its
   * selector tidied. What was judged is what is sent. */
  dispatch(params: unknown): Promise<unknown>;
}

interface Intent {
  via: "click" | "enter" | "reload";
  /** The bot's selector, tidied, or null for the focused element. */
  selector: string | null;
  shift: boolean;
  /** Enter arrives inside text typed with agent_browser_type. */
  typed: boolean;
  /** The call as it will be sent. */
  params: unknown;
}

/** A commitment as the server saw it on the page. */
interface Sighting {
  class: CommitClass;
  host: string;
  /** What the card calls the action. */
  label: string;
  /** The visible text around the element, redacted: which one it is. */
  context: string;
  /** The fields the card and the log show: the first of them, redacted and
   * shortened. The digest covers every field at full length. */
  shown: CommitField[];
  /** How many fields the card does not show. */
  more: number;
  digest: string;
  /** The server may take its own picture of the page for the card. */
  picture: boolean;
  /** A reload that would repeat an earlier commitment, not a new one. */
  repeat?: boolean;
}

/** Why a call cannot be judged: each is refused, none is sent.
 * - "unreadable": the engine or the page did not answer.
 * - "undescribed": the engine found an element this read cannot describe,
 *   and the snapshot never named it.
 * - "unusable": the selector is one the read will not hand to the engine. */
type Blind = "unreadable" | "undescribed" | "unusable";
const BLIND: Record<Blind, string> = { unreadable: UNREADABLE, undescribed: UNDESCRIBED, unusable: BAD_SELECTOR };

/** The last commitment this gate let through in a browser session: a
 * reload there can send it again. */
interface Sent {
  id: number;
  class: CommitClass;
  label: string;
  shown: CommitField[];
  more: number;
  /** The bot has opened another address since, so a reload repeats nothing. */
  movedOn: boolean;
}

/** A card that is settled, or that nobody can answer any more, shows no
 * picture and no note about one: the screenshot was evidence for the
 * decision, and it is deleted with it. */
export function cardWithoutPicture(card: OptionCardData): OptionCardData {
  if (!card.browserCommit) return card;
  const { shot: _shot, noShot: _noShot, ...evidence } = card.browserCommit;
  return { ...card, browserCommit: evidence };
}

function refusal(text: string): { isError: true; content: Array<{ type: "text"; text: string }> } {
  return { isError: true, content: [{ type: "text", text }] };
}

function toolCall(params: unknown): { name: string; args: Record<string, unknown> } {
  const call = params && typeof params === "object" ? (params as { name?: unknown; arguments?: unknown }) : {};
  const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments) ? (call.arguments as Record<string, unknown>) : {};
  return { name: typeof call.name === "string" ? call.name : "", args };
}

/** The engine trims a selector before it resolves it ("@e4 " is ref e4),
 * with Rust's notion of white space; JavaScript's differs by a character or
 * two. Tidying with both means the engine has nothing left to trim, so the
 * string judged here is the string it resolves. */
const EDGES = /^[\s\u0085]+|[\s\u0085]+$/g;

/** Calls that are a click on their selector's element. agent_browser_check
 * and agent_browser_uncheck make a real click on any element, and
 * agent_browser_select changes a control the page may submit on. */
const CLICKS: ReadonlySet<string> = new Set(["agent_browser_click", "agent_browser_check", "agent_browser_uncheck", "agent_browser_select"]);
/** Calls after which the page in front may again be one a form posted to. */
const RETURNS: ReadonlySet<string> = new Set(["agent_browser_back", "agent_browser_forward", "agent_browser_tab_switch", "agent_browser_tab_close"]);
/** Calls that close the browser, and its history with it. */
const CLOSES: ReadonlySet<string> = new Set(["agent_browser_close", "restart_browser"]);

/** The calls that can commit, as the header table has them. Null for a call
 * that never does; "blind" for typed text whose Enter cannot be placed. */
function commitIntent(params: unknown, name: string, args: Record<string, unknown>, reloadHeld: boolean): Intent | "blind" | null {
  if (name === "agent_browser_reload") return reloadHeld ? { via: "reload", selector: null, shift: false, typed: false, params } : null;
  if (name === "agent_browser_press") {
    const enter = enterPress(args.key);
    return enter ? { via: "enter", selector: null, shift: enter.shift, typed: false, params } : null;
  }
  const typed = name === "agent_browser_type";
  if (!CLICKS.has(name) && !typed) return null;
  if (typeof args.selector !== "string") return null;
  if (typed) {
    if (typeof args.text !== "string" || !/[\r\n]/.test(args.text)) return null;
    // One Enter, at the end, lands on the selector's element. After a tab
    // or an earlier Enter the focus is somewhere this gate has not read.
    if (!/^[^\r\n\t]*[\r\n]$/.test(args.text)) return "blind";
  }
  const selector = args.selector.replace(EDGES, "");
  const sent = selector === args.selector ? params : { ...(params as object), arguments: { ...args, selector } };
  return { via: typed ? "enter" : "click", selector, shift: false, typed, params: sent };
}

/** The address without its fragment, and its host as a card names it. */
function place(url: string | null): { address: string; host: string } {
  try {
    const parsed = new URL(url ?? "");
    parsed.hash = "";
    return { address: parsed.href, host: parsed.host || "this page" };
  } catch { return { address: "", host: "this page" }; } // an address the engine would not give is part of the digest as ""
}

/** Does opening `url` leave the document at `from`? Only a different
 * address (the fragment aside) does; anything unreadable counts as staying. */
function leaves(from: string | null, url: unknown): boolean {
  if (!from || typeof url !== "string" || !url.trim()) return false;
  // The engine opens "example.com/x" as https://example.com/x.
  const to = [url.trim(), `https://${url.trim()}`].map((candidate) => place(candidate).address).find(Boolean);
  const here = place(from).address;
  return Boolean(to) && Boolean(here) && to !== here;
}

const failed = (result: unknown): boolean => (result as { isError?: unknown } | null)?.isError === true;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** How much of a value the card shows, how many fields, and how long the
 * whole subtitle may be. The approval itself is bound to everything. */
const SHOWN_VALUE = 200;
const SHOWN_FIELDS = 12;
const SUBTITLE_MAX = 1_500;

/** Thirteen to nineteen digits, in groups or not, that pass the Luhn check. */
function cardNumber(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - index) - 48;
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Text as the card and the log may carry it: anything that looks like a
 * credential masked, and a card number written inside other text too. (A
 * field that holds a card number and nothing else never leaves the page.) */
function masked(text: string): string {
  return redactSecretsInText(text).replace(/(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, (run) => (cardNumber(run.replace(/[ -]/g, "")) ? "«card number»" : run));
}

/** A field as a person reads it on the card and as the log keeps it:
 * credentials masked, line breaks flattened, a long value shortened with
 * its full length beside it. */
function shownField(field: CommitField): CommitField {
  if (field.value === undefined) return { name: field.name, type: field.type, length: field.length ?? 0 };
  const flat = masked(field.value.replace(/\s+/g, " ").trim());
  return flat.length > SHOWN_VALUE
    ? { name: field.name, type: field.type, value: `${flat.slice(0, SHOWN_VALUE)}…`, length: field.value.length }
    : { name: field.name, type: field.type, value: flat };
}

function fieldLine(field: CommitField): string {
  if (field.value === undefined) return `${field.name}: ${field.length ?? 0} characters, not shown`;
  return field.length === undefined ? `${field.name}: ${field.value}` : `${field.name}: ${field.value} (${field.length.toLocaleString("en-US")} characters in all)`;
}

const moreLine = (more: number): string => `and ${more.toLocaleString("en-US")} more field${more === 1 ? "" : "s"}, not shown here`;

/** The card's plain text: host and label first, the way every send card's
 * subtitle starts, then where the element is, then the fields, then how
 * many fields are left out. Enough to decide on for a client that knows
 * nothing else. */
function subtitle(seen: Pick<Sighting, "host" | "label" | "context" | "shown" | "more">): string {
  return [
    `${seen.host} · ${seen.label}`,
    ...(seen.context ? [`Where: ${seen.context}`] : []),
    ...seen.shown.map(fieldLine),
    ...(seen.more ? [moreLine(seen.more)] : []),
  ].join("\n");
}

/** As many of the fields as the card has room for, from the first. What
 * does not fit is counted, so the card can say so, and is never cut off
 * mid-line: the last line always says how many are missing. */
function fit(seen: Pick<Sighting, "host" | "label" | "context">, fields: CommitField[], unseen = 0): { shown: CommitField[]; more: number } {
  const shown: CommitField[] = [];
  for (const field of fields) {
    const more = fields.length - shown.length - 1 + unseen;
    if (shown.length >= SHOWN_FIELDS || subtitle({ ...seen, shown: [...shown, field], more: Math.max(more, 1) }).length > SUBTITLE_MAX) break;
    shown.push(field);
  }
  return { shown, more: fields.length - shown.length + unseen };
}

export class BrowserCommitGate {
  private readonly deps: CommitGateDeps;
  /** Per browser session: the commitment a reload there could send again. */
  private readonly sent = new Map<string, Sent>();
  private sentCount = 0;

  constructor(deps: CommitGateDeps) {
    this.deps = deps;
  }

  /** Run one browser tools/call: refuse it, hold it, or let it through.
   * Resolves with the tool result the bot receives. */
  async guard(call: CommitCall): Promise<unknown> {
    const { name, args } = toolCall(call.params);
    if (name === "agent_browser_eval") {
      const action = typeof args.script === "string" ? scriptAction(args.script) : null;
      if (!action) return call.dispatch(call.params);
      return refusal(`OpenMausBot did not run this script: ${SCRIPT_REFUSAL[action]}. Scripts are for reading the page. Use agent_browser_click, agent_browser_fill, agent_browser_press and agent_browser_open to act on it.`);
    }
    const repeatable = this.sent.get(call.session);
    const intent = commitIntent(call.params, name, args, Boolean(repeatable && !repeatable.movedOn));
    if (!intent) return this.relay(call, name, args);
    if (intent === "blind") return refusal(TYPED_BLIND);
    call.admit();
    const deadline = Date.now() + this.deps.holdMs;
    let seen = await this.look(call, intent);
    // Not knowing is not the same as nothing to hold.
    if (typeof seen === "string") return refusal(intent.typed && seen === "undescribed" ? TYPED_BLIND : BLIND[seen]);
    if (!seen) return call.dispatch(intent.params);
    if (intent.typed) return refusal(TYPED_ENTER);

    const policy = this.deps.policy(call.botId) ?? DEFAULT_OUTBOUND_POLICY;
    const row = { threadId: call.threadId, botId: call.botId, botName: call.botName, tool: name };
    // Money always asks. A send spends from the bot's daily allowance when it
    // has one, and asks once that is used up.
    if (seen.class === "send" && policy.policy === "allow") {
      if (this.gone(call)) return refusal(UNANSWERED);
      let reserved: number | null;
      try { reserved = this.deps.counts.reserve(call.botId, 1, policy.dailyCap); }
      catch { return refusal(NOT_SAVED); }
      if (reserved !== null) {
        this.deps.log({ ...row, summary: this.summary(seen), decision: "auto-approved", source: "outbound", rule: commitRule(seen.class, `daily-allowance:${reserved}/${policy.dailyCap}`) });
        this.remember(call.session, seen);
        return call.dispatch(intent.params);
      }
    }

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !call.active()) return refusal(UNANSWERED);
      const answer = await this.ask(call, intent, seen, row, remaining);
      if (answer.next === "refuse") return refusal(answer.why);
      if (answer.next === "send") {
        // The hold is released and the card settled: the call goes out as it was judged.
        this.remember(call.session, seen);
        return call.dispatch(intent.params);
      }
      seen = answer.seen;
    }
  }

  /** One card for what was seen, and the person's answer to it: send the
   * call, refuse it with a reason, or ask again because the page changed.
   * Whatever happens in here, an answer, a timeout or a throw, the hold on
   * the browser, the waiting request and the screenshot are gone when it
   * returns, and the card is not left looking answerable. A hold that
   * outlived a failure would refuse every action in that browser until the
   * server restarted. */
  private async ask(
    call: CommitCall, intent: Intent, seen: Sighting, row: Pick<DecisionRow, "threadId" | "botId" | "botName" | "tool">, timeoutMs: number,
  ): Promise<{ next: "send" } | { next: "refuse"; why: string } | { next: "ask"; seen: Sighting }> {
    const tool = row.tool ?? "";
    const held = this.deps.requests.open({ botId: call.botId, threadId: call.threadId, tool, timeoutMs });
    if (!this.deps.runtime.hold(call.session, held.requestId)) {
      this.deps.requests.forget(held.requestId);
      return { next: "refuse", why: ALREADY_WAITING };
    }
    const close = (outcome: string) => this.deps.log({ ...row, requestId: held.requestId, decision: "auto-denied", source: "outbound", rule: commitRule(seen.class, outcome) });
    const unavailable = () => ({ answered: "unavailable" as const, dismissed: true });
    let messageId: string | undefined;
    let shot: string | undefined;
    /** The card was given its last state (or the attempt was made). */
    let settled = false;
    const settle = (change: (card: OptionCardData) => Partial<OptionCardData> = () => ({}), pageChanged = false) => {
      settled = true;
      if (messageId === undefined) return;
      this.deps.patch(call.threadId, messageId, (card) => {
        const last = { ...cardWithoutPicture(card), ...change(card) };
        return pageChanged && last.browserCommit ? { ...last, browserCommit: { ...last.browserCommit, pageChanged: true } } : last;
      });
    };
    try {
      shot = seen.picture ? await call.shot().catch(() => undefined) : undefined;
      messageId = this.deps.post({ botId: call.botId, threadId: call.threadId, card: this.card(seen, tool, held.requestId, shot) });
      this.deps.log({ ...row, requestId: held.requestId, summary: this.summary(seen), decision: "card-shown", source: "outbound", rule: commitRule(seen.class) });

      const answer = await this.answerOrGone(held.answer, call);
      if (call.active()) this.deps.resume(call.botId, call.threadId);

      if (answer === "deny") {
        settle();
        return { next: "refuse", why: DENIED };
      }
      if (answer !== "allow") {
        // Nobody can answer this card any more: close it, as a connector hold's is.
        settle((card) => (card.answered ? {} : unavailable()));
        close("unanswered");
        return { next: "refuse", why: UNANSWERED };
      }

      // The person may be using the browser. Wait for it to come back, then
      // look again: the approval covers the page they were shown, no other.
      if (!await this.deps.runtime.personReleased(call.session, this.deps.handBackMs ?? 60_000)) {
        settle();
        close("browser-in-use");
        return { next: "refuse", why: STILL_HELD };
      }
      const now = await this.look(call, intent).catch(() => "unreadable" as const);
      if (now && typeof now !== "string" && now.digest === seen.digest) {
        // The answer was Allow, but the bot's request may have closed while
        // the person had the browser or the page was read again. Then
        // nobody is waiting for this click, and it is not made.
        if (this.gone(call)) {
          settle(unavailable);
          close("gone");
          return { next: "refuse", why: UNANSWERED };
        }
        settle();
        return { next: "send" };
      }
      if (typeof now === "string") {
        settle(unavailable);
        close("unreadable");
        return { next: "refuse", why: BLIND[now] };
      }
      settle(unavailable, true);
      close("page-changed");
      return now ? { next: "ask", seen: now } : { next: "refuse", why: PAGE_CHANGED };
    } finally {
      this.deps.requests.forget(held.requestId);
      this.deps.runtime.releaseHold(call.session, held.requestId);
      // The screenshot is evidence for the decision, not a record: it goes
      // once the card is settled.
      if (shot) this.deps.dropShot(shot);
      if (!settled) {
        // Something above threw. The error goes on to the caller; the card
        // must not stay open, or go on saying Allowed, for a call that was
        // never sent.
        try { settle(unavailable); close("failed"); } catch { /* the first failure is the one reported */ }
      }
    }
  }

  /** A call that is not judged. It goes through as the bot sent it; all
   * that is kept is whether a reload could still repeat a commitment. */
  private async relay(call: CommitCall, name: string, args: Record<string, unknown>): Promise<unknown> {
    const sent = this.sent.get(call.session);
    if (!sent) return call.dispatch(call.params);
    // Where the page is before an open moves it: only another address
    // leaves the document a form may have posted to.
    const from = name === "agent_browser_open" && !sent.movedOn
      ? await this.deps.runtime.withAgentAction(call.session, () => call.page.url(), "read").catch(() => null)
      : null;
    const result = await call.dispatch(call.params);
    if (failed(result)) return result;
    if (CLOSES.has(name)) this.sent.delete(call.session);
    else if (RETURNS.has(name)) sent.movedOn = false;
    else if (leaves(from, args.url)) sent.movedOn = true;
    return result;
  }

  /** The bot's call is no longer waiting: its request closed or its turn ended. */
  private gone(call: CommitCall): boolean {
    return call.signal.aborted || !call.active();
  }

  /** A commitment is about to be sent: a reload in this browser can repeat
   * it. Money stays the class once money was spent here. */
  private remember(session: string, seen: Sighting): void {
    if (seen.repeat) return;
    const before = this.sent.get(session);
    this.sentCount += 1;
    this.sent.set(session, { id: this.sentCount, class: before?.class === "money" ? "money" : seen.class, label: seen.label, shown: seen.shown, more: seen.more, movedOn: false });
  }

  /** What the call would act on right now. Null when it is no commitment
   * (or the engine has no such element and will say so itself); a Blind
   * reason when that could not be told. Throws what the runtime gate throws
   * when a person has the browser. */
  private async look(call: CommitCall, intent: Intent): Promise<Sighting | null | Blind> {
    if (intent.via === "reload") {
      const sent = this.sent.get(call.session);
      if (!sent || sent.movedOn) return null;
      const { address, host } = place(await this.deps.runtime.withAgentAction(call.session, () => call.page.url(), "read"));
      const digest = createHash("sha256").update(JSON.stringify([address, "reload", sent.id])).digest("hex");
      const head = { host, label: `Reload, which can repeat “${clip(sent.label, 80)}”`, context: "" };
      // No picture: the page a form posted to was never read for secrets.
      return { class: sent.class, ...head, ...fit(head, sent.shown, sent.more), digest, picture: false, repeat: true };
    }
    const [found, url] = await this.deps.runtime.withAgentAction(
      call.session,
      () => Promise.all([call.page.target(intent.selector, intent.via === "enter"), call.page.url()]),
      "read",
    );
    // Only "missing" says there is nothing to act on.
    if (found === "missing") return null;
    if (found === "unreadable" || found === "unusable") return found;
    const ref = intent.selector ? /^(?:@|ref=)?(e\d+)$/.exec(intent.selector)?.[1] : undefined;
    const known = ref ? this.deps.runtime.ref(call.session, ref) : undefined;
    let targets: Array<CommitTarget & Pick<PageTarget, "fields" | "identity" | "context">>;
    if (found === "hidden") {
      // The engine found an element the page read cannot describe: it is
      // inside a frame, or it has no area. The snapshot's own name for the
      // ref is all there is to judge a click by; with no name, or for an
      // Enter, nothing is.
      if (!known || intent.via !== "click") return "undescribed";
      const box = known.role === "searchbox" ? "search" : known.role === "textbox" ? "single" : null;
      targets = [{ via: "click", label: known.name, role: known.role, box, submits: false, search: box === "search", card: false, multiline: false, fields: [], identity: "", context: "" }];
    } else {
      // More than one element can share the box. Each is judged.
      targets = [found, ...(found.also ?? [])].map((target: PageTarget) => ({
        via: intent.via as "click" | "enter", shift: intent.shift, label: target.label, role: target.role, box: target.box,
        submits: target.submits, search: target.search, card: target.card, multiline: target.multiline,
        fields: target.fields, identity: target.identity, context: target.context,
      }));
    }
    // The snapshot's name is the browser's own; the page read's is ours. A
    // click is held when either one names a commitment, on any element the
    // engine might act on. The most serious one is the one shown.
    let pick: { kind: CommitClass; target: (typeof targets)[number]; named: string } | undefined;
    for (const target of targets) {
      const labels = intent.via === "click" && known?.name && known.name !== target.label ? [target.label, known.name] : [target.label];
      const classes = labels.map((label) => classifyCommit({ ...target, label }));
      const kind: CommitClass | null = classes.includes("money") ? "money" : classes.includes("send") ? "send" : null;
      if (!kind || (pick && (pick.kind === "money" || kind === "send"))) continue;
      pick = { kind, target, named: labels[classes.indexOf(kind)] || labels.find(Boolean) || `unlabelled ${target.role || "control"}` };
    }
    if (!pick) return null;
    const { target, named } = pick;
    const label = intent.via === "enter" && target.box === "multiline" && !target.submits ? `Enter in ${named}` : named;

    const { address, host } = place(url);
    // What the approval is bound to: the address, which element it is and
    // what is around it, and every field at full length, for every element
    // the call might act on. The card shows less; this is all of it.
    const digest = createHash("sha256").update(JSON.stringify([
      address, intent.via, known?.name ?? null,
      targets.map((each) => [each.label, each.role, each.identity, each.context, each.fields.map((field) => [field.name, field.type, field.value ?? null, field.length ?? null])]),
    ])).digest("hex");
    const head = { host, label: clip(label, 120), context: masked(target.context) };
    // No picture of a page that shows a field the card masks, nor of one
    // the read could not look at: the picture would show what the card hides.
    const picture = found !== "hidden" && !found.secrets;
    return { class: pick.kind, ...head, ...fit(head, target.fields.map(shownField)), digest, picture };
  }

  private summary(seen: Sighting): string {
    return clip(subtitle(seen), SUBTITLE_MAX);
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
      browserCommit: {
        class: seen.class, host: seen.host, label: seen.label,
        ...(seen.context ? { context: seen.context } : {}),
        fields: seen.shown,
        ...(seen.more ? { more: seen.more } : {}),
        ...(shot ? { shot } : {}),
        ...(seen.picture ? {} : { noShot: true }),
      },
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
