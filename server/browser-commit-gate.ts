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
// the address, the target and every control of its form or region; if any of
// them changed by the time the answer arrives, the approval is void and a new
// card is raised.
//
// The page is read twice at most. The first read says what the call would
// act on, from the element and its form or region alone, and most calls end
// there. Only a commitment gets the second: the evidence for its card.
//
// When the gate cannot tell what a call would act on, it refuses or asks. It
// never sends.
//
// Beside the runtime's own work on a call (browser-runtime.ts):
//
// - The runtime reads the page before and after an action and adds what
//   changed to the result. It does that inside agentRpc, and the gate calls
//   agentRpc only to send: a call that is held or refused is not read for
//   it, and a refusal is the gate's own words with nothing of the page. The
//   typed text, the separate Enter and an approved click are each read
//   around like any action. After its read the runtime asks the route once
//   more and looks at the session's gate, so a call whose request closed
//   meanwhile, or one a new hold or a person now stands before, is not sent.
// - A call the engine lost leaves the browser uncertain until the engine
//   answers again, and the runtime answers the next call in its place. The
//   gate asks the runtime first (CommitCall.recover), because its own reads
//   are refused in that state. An Allow that arrives in it reads nothing and
//   sends nothing. A ref is not acted on between a lost call and the bot's
//   next snapshot: the engine numbers its refs anew with every snapshot,
//   seen or not, and the snapshot's name for a ref is part of how a click
//   on one is judged.
//
// It is a guard against a bot over-acting on ordinary pages, not a wall. It
// goes by what a page shows (a label, a form, card fields), so it is tuned
// to pass ordinary browsing (shared/browser-commit.ts has the rules, and
// browser-commit-ordinary.test.ts the table of what must pass and what must
// be held), and a payment behind a neutral label on a page with no card
// signal gets past it. docs/approval-levels.md lists the limits.
//
// Every tool the bot has (server/browser-tool-shape.test.ts has the list),
// and why it can or cannot commit. Each row was run against agent-browser
// 0.37.0 on a local page.
//
// | Tool | What it does to a page | Here |
// |---|---|---|
// | click | A real click at the centre of the element's box. On a frame element it lands on whatever is inside the frame there. | Judged, in the page and in a frame of its own origin. Refused when the target is a frame itself. In a card region any button-like control is money. |
// | check, uncheck | The same real click, on any element: a Send button too. | Judged as a click. |
// | select | Sets the value and fires `change`. No click. Commits when the page submits on change. | Judged as a click on the element, and as its form's submit when an inline handler submits. |
// | press | A real key press at the focus, which may be inside a frame or a closed part of the page. Enter in any part of a chord submits or sends. Space, under any of its names, clicks a focused button. | Enter is judged, in any position, and Space as an activation of the focused element. With the focus where the read cannot look (another site's frame, a closed shadow root) both are refused. F5 and Ctrl+R do nothing in the pinned headless browser. |
// | type | Key presses for "\n" and "\r" (Enter, one for each: "\r\n" is two) and "\t" (Tab); other characters are inserted with no key press, so a typed space activates nothing. It tries to give its element the focus first, and when it cannot (no field, a modal in front, a disabled group, an inert or hidden parent, a selector it cannot resolve) it types the text and the Enter at whatever has it. | Text and its Enter never go to the engine in one call. For each line break at a text field, the gate types the text before it, reads the page afresh, and judges and presses the Enter as a step of its own when the field has the focus. A field that cannot take the focus gets nothing. Several lines run only into a focused multi-line field that is no composer. Anything else, and anything with a tab, is refused. |
// | fill | Sets the value and fires `input`. No key press, no click; "\n" is not Enter. | Not judged. Limit: a field whose own `input` handler submits. |
// | eval | Runs the bot's script in the page. | Refused when its text acts (scriptAction). A guard, not a wall. |
// | reload | Sends a POST again when the page came from one. | Held after a commitment in this browser, for as long as the browser lives. |
// | back, forward | Shows the page from history. Does not send a POST again, but a reload there does. | Not judged. |
// | tab_switch, tab_close | Brings another tab to the front. | Not judged. |
// | open | Navigates by GET. Refuses a `javascript:` address. | Not judged. It does not end the reload hold: the page's own link or script can bring the posted page back. |
// | tab_new | Opens a tab, by GET when given an address. | Not judged. |
// | read | Fetches an address as text by GET. The page does not move. | Not judged. |
// | scroll | Scrolls the page or an element. No click. | Not judged. |
// | snapshot, get_text, get_url, get_title, screenshot, tab_list, tools_profiles | Read only. | Not judged. |
// | wait_ms, wait_for_selector, wait_for_text, wait_for_load | Wait. | Not judged. |
// | close, restart_browser | Close the browser. | Not judged. End the reload hold. |
//
// Opening an address is a GET, and a GET can commit on a site built that way
// (a one-click unsubscribe link). That is outside what this gate reads.
//
// Frames (iframe, frame, object, embed). The page read runs in the page
// itself. It reads a frame of the page's own origin like the page; it cannot
// look into another site's. The engine can act in both: the snapshot lists a
// frame's elements with refs, and the engine measures such an element from
// the frame's own corner, so its box can be the box of another element
// outside the frame. A click on a ref is therefore judged both as the
// element read in that box (in the page and in every frame it can read) and
// as the element the snapshot named; in a payment frame it cannot read, a
// button-like ref is money whatever it is called. Enter or Space into a
// frame that cannot be read is refused.
//
// The engine's own word. The ref table the snapshot leaves behind carries a
// role and a name, and no address (not with `includeUrls` either; the
// snapshot's text has one, but a page can forge that text). For a ref the
// snapshot calls a link, that would be held for its name, the engine is
// asked for the `href` of the ref's own element (`get attr`): an address
// that goes to another document makes it a plain link, whatever the names.
import { createHash } from "node:crypto";

import { COMMIT_TITLE, chordPress, classifyCommit, commitRule, enterPress, isButtonRole, linkGoes, scriptAction, spacePress } from "../shared/browser-commit.ts";
import { DEFAULT_OUTBOUND_POLICY } from "../shared/outbound.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { HELD_NOTE } from "./auto-approve.ts";

import type { CommitClass, CommitField, CommitTarget, ScriptAction } from "../shared/browser-commit.ts";
import type { OutboundPolicy } from "../shared/outbound.ts";
import type { OptionCardData } from "../shared/wire.ts";
import type { BrowserPageReader, PageDetail, PageEvidence, PageTarget } from "./browser-commit-page.ts";
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
const TYPED_UNFOCUSED = "OpenMausBot did not type this: a line break typed with agent_browser_type presses Enter, and the field it is aimed at does not have the focus, so that Enter could land on something else. Click the field first and then type, or enter the text with agent_browser_fill, then press Enter or click the button as its own step.";
const TYPED_LINES = "OpenMausBot did not type this: it has several line breaks, and each one is an Enter key press. In a one-line field the first Enter may submit the form, and the rest of the text would land somewhere else. Enter the text with agent_browser_fill, then press Enter or click the button as its own step.";
const TYPED_UNREACHABLE = "OpenMausBot did not type this: the field it is aimed at cannot take the focus right now (it is disabled, hidden, or behind something else), so the text and its Enter would have gone to whatever has the focus. Nothing was typed. If the field should be usable, take a new snapshot; otherwise enter the text with agent_browser_fill, then press Enter or click the button as its own step.";
const TYPED_NOT_TAKEN = "OpenMausBot typed the text, but the field did not take the focus, so it did not press Enter: that Enter would have landed on something else. Take a new snapshot to see where the text went, then press Enter or click the button as its own step.";
/** Before the reason an Enter was not pressed, once its text is in the field. */
const TYPED_THEN = "OpenMausBot typed the text and did not press Enter. ";
/** A step the engine lost may have happened. What the runtime said of it follows; nothing is claimed about it here. */
const TYPED_LOST = "OpenMausBot typed this in steps: the text, and each Enter as a key press of its own. The steps before this one were made, and this one did not come back. ";
/** Several lines, stopped part-way. */
const TYPED_PART = "OpenMausBot typed the text up to a line break and stopped: it could not press Enter there as a plain new line. The rest was not typed. Enter text of several lines with agent_browser_fill. ";
/** How many line breaks one typed text may have: each is an Enter the gate checks and presses by itself. */
const MAX_TYPED_BREAKS = 50;
const TYPED_MANY = `OpenMausBot did not type this: it has more than ${MAX_TYPED_BREAKS} line breaks, and each one is an Enter key press it checks by itself. Enter the text with agent_browser_fill instead.`;
const UNDESCRIBED = "OpenMausBot did not do this: it could not check what this would act on. The element is inside a frame or has no visible area, and the last snapshot gave it no name. Take a new snapshot and use the element's @ref from a new snapshot.";
/** A ref, after a call the engine lost: it may have numbered its refs anew since the snapshot the bot saw. */
const REFS_LOST = "OpenMausBot did not do this: an earlier browser call was lost, and the browser may have renumbered its refs since your last snapshot, so it could not check what this ref would act on. Take a new snapshot and use the @ref it gives.";
const BAD_SELECTOR = "OpenMausBot did not do this: it could not check that selector. Use an @ref from a snapshot, or a shorter selector that does not start with a dash.";
/** Enter or Space with the focus where the read cannot look. */
const KEY_UNSEEN = (key: string, where: string): string => `OpenMausBot did not press ${key}: the focus is inside ${where} it cannot read, so it could not check what ${key} would send or pay for there. Click the button for this step instead, by its @ref from a snapshot.`;
const TYPED_IN_FRAME = "OpenMausBot did not type this: a line break typed with agent_browser_type presses Enter, and here that would be inside a frame it cannot read. Enter the text with agent_browser_fill, then click the button for this step by its @ref from a snapshot.";
const FRAME_CLICK = "OpenMausBot did not do this: it would land inside a frame it cannot read, on whatever is at that point. Take a snapshot and use the @ref of the element inside the frame.";

export interface CommitGateDeps {
  runtime: Pick<BrowserRuntime, "hold" | "releaseHold" | "personReleased" | "ref" | "refsStale" | "interrupted" | "withAgentAction">;
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
  /** What the runtime answers this call with while an earlier call of this
   * browser is lost (it timed out in the engine and may still be running):
   * the call is not run. Null when nothing is lost. */
  recover(): Promise<unknown>;
  /** The turn that made this call is still running. */
  active(): boolean;
  /** Aborts when the bot's request went away. */
  signal: AbortSignal;
  /** Run these tools/call params: the bot's own, or the same call with its
   * selector tidied. The hold identity comes only from this gate, never
   * the bot's parameters. What was judged is what is sent. */
  dispatch(params: unknown, holdId?: string): Promise<unknown>;
}

interface Intent {
  via: "click" | "enter" | "reload";
  /** The bot's selector, tidied, or null for the focused element. */
  selector: string | null;
  shift: boolean;
  /** Enter arrives inside text typed with agent_browser_type. */
  typed: boolean;
  /** The key a press is for, as a refusal names it. */
  key?: "Enter" | "Space";
  /** Enter with a key other than Shift held: never a new line. */
  chord?: boolean;
  /** Typed text with more than its one line break at the end. */
  lines?: boolean;
  /** Typed text as what lies between its line breaks: each gap is one Enter. */
  pieces?: string[];
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
  /** Filled fields elsewhere on the page that are bound, not listed. */
  others: number;
  /** Part of the form or region could not be read. */
  partial: boolean;
  digest: string;
  /** A digest of less: the element's place, its label and the fields. What
   * an approval is bound to once the page has changed under two in a row. */
  loose: string;
  /** The server may take its own picture of the page for the card. */
  picture: boolean;
  /** A reload that would repeat an earlier commitment, not a new one. */
  repeat?: boolean;
}

/** Why a call cannot be judged: each is refused, none is sent.
 * - "unreadable": the engine or the page did not answer.
 * - "undescribed": the engine found an element this read cannot describe,
 *   and the snapshot never named it; or it named another element than the
 *   one the read found.
 * - "untypable": text with a line break, for a target that is not a text
 *   field that will itself take it. The engine would type at the focus.
 * - "unreachable": text with a line break, for a text field that cannot
 *   take the focus. The engine would type it into whatever has the focus.
 * - "one-line": text of several lines, for a field of one line that has
 *   the focus. Its first Enter may submit, and the rest land elsewhere.
 * - "framed": the call would act inside a frame the read cannot look into.
 * - "sealed": the focus is inside a closed part of the page.
 * - "unusable": the selector is one the read will not hand to the engine. */
type Blind = "unreadable" | "undescribed" | "untypable" | "unreachable" | "one-line" | "framed" | "sealed" | "unusable" | "renumbered";

/** What the bot is told when its call could not be judged. */
function blindReason(intent: Intent, blind: Blind): string {
  if (blind === "framed" || blind === "sealed") {
    if (intent.typed) return TYPED_IN_FRAME;
    if (intent.key) return KEY_UNSEEN(intent.key, blind === "sealed" ? "a closed part of the page" : "a frame");
    return FRAME_CLICK;
  }
  if (blind === "untypable") return TYPED_UNFOCUSED;
  if (blind === "unreachable") return TYPED_UNREACHABLE;
  if (blind === "one-line") return TYPED_LINES;
  if (blind === "undescribed") return intent.typed ? TYPED_BLIND : UNDESCRIBED;
  if (blind === "renumbered") return REFS_LOST;
  return blind === "unusable" ? BAD_SELECTOR : UNREADABLE;
}

/** Two names for one element, as the snapshot and the page read give them. */
const sameName = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** A commitment went out from this browser session, so a reload there can
 * send it again. Only the class is kept: the reload card names the site and
 * the class, and repeats nothing of what was sent (on a shared browser the
 * bot reloading may not be the bot that sent it). */
interface Sent {
  id: number;
  class: CommitClass;
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
/** Calls that close the browser, and its history with it. */
const CLOSES: ReadonlySet<string> = new Set(["agent_browser_close", "restart_browser"]);

/** The calls that can commit, as the header table has them. Null for a call
 * that never does; "blind" for typed text whose Enter cannot be placed. */
function commitIntent(params: unknown, name: string, args: Record<string, unknown>, reloadHeld: boolean): Intent | "blind" | "many" | null {
  if (name === "agent_browser_reload") return reloadHeld ? { via: "reload", selector: null, shift: false, typed: false, params } : null;
  if (name === "agent_browser_press") {
    const enter = enterPress(args.key);
    if (enter) return { via: "enter", selector: null, shift: enter.shift, typed: false, key: "Enter", chord: chordPress(args.key), params };
    // Space on a focused button clicks it: an activation of whatever has the focus.
    return spacePress(args.key) ? { via: "click", selector: null, shift: false, typed: false, key: "Space", params } : null;
  }
  const typed = name === "agent_browser_type";
  if (!CLICKS.has(name) && !typed) return null;
  if (typeof args.selector !== "string") return null;
  let pieces: string[] | undefined;
  if (typed) {
    if (typeof args.text !== "string" || !/[\r\n]/.test(args.text)) return null;
    // A tab moves the focus: after one, the Enter that follows lands
    // somewhere this gate has not read.
    if (args.text.includes("\t")) return "blind";
    // The engine presses Enter for a line feed and for a carriage return
    // (measured: for both of a pair, so "a\r\n" submitted a form twice).
    // Here a pair is one line break, like either alone. The gate types what
    // lies between the line breaks and presses each Enter itself.
    pieces = args.text.split(/\r\n|\r|\n/);
    if (pieces.length - 1 > MAX_TYPED_BREAKS) return "many";
  }
  const selector = args.selector.replace(EDGES, "");
  const sent = selector === args.selector ? params : { ...(params as object), arguments: { ...args, selector } };
  // One Enter, at the end, lands on the selector's element. Text with more
  // line breaks than that runs only into a multi-line field where Enter is
  // a new line: anywhere else the first Enter may move on.
  const lines = pieces !== undefined && (pieces.length > 2 || pieces.at(-1) !== "");
  return { via: typed ? "enter" : "click", selector, shift: false, typed, ...(pieces ? { pieces } : {}), ...(lines ? { lines } : {}), params: sent };
}

/** The address without its fragment, and its host as a card names it. */
function place(url: string | null): { address: string; host: string } {
  try {
    const parsed = new URL(url ?? "");
    parsed.hash = "";
    return { address: parsed.href, host: parsed.host || "this page" };
  } catch { return { address: "", host: "this page" }; } // an address the engine would not give is part of the digest as ""
}

const failed = (result: unknown): boolean => (result as { isError?: unknown } | null)?.isError === true;
/** The parts of a tool result, and what they say. */
const content = (result: unknown): unknown[] => { const parts = (result as { content?: unknown } | null)?.content; return Array.isArray(parts) ? parts : []; };
const text = (result: unknown): string => content(result).map((part) => (typeof (part as { text?: unknown } | null)?.text === "string" ? (part as { text: string }).text : "")).join("\n");

/** The text around an element with relative times and clocks evened out,
 * as the page script does it: a row that says "3s ago", then "4s ago", has
 * not changed. Any other number is part of what was approved. */
const steady = (text: string): string => text
  .replace(/\b(?:(?:\d+|an?|a few) ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?|moments?) ago|just now|in \d+ ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)|\d\d?:\d\d(?::\d\d)?)\b/gi, "~");
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
const othersLine = (others: number): string => `${others.toLocaleString("en-US")} other filled field${others === 1 ? "" : "s"} on this page ${others === 1 ? "is" : "are"} covered by this approval, not listed`;
const PARTIAL_LINE = "Part of this form could not be read: a component keeps its inside closed. This approval does not cover what is in there.";
const CHANGING_LINE = "The page keeps changing by itself: this approval is for the button and the fields, not the text around them.";

/** The card's plain text: host and label first, the way every send card's
 * subtitle starts, then where the element is, then the fields, then how
 * many fields are left out. Enough to decide on for a client that knows
 * nothing else. */
function subtitle(seen: Pick<Sighting, "host" | "label" | "context" | "shown" | "more" | "others" | "partial">, changing = false): string {
  return [
    `${seen.host} · ${seen.label}`,
    ...(seen.context ? [`Where: ${seen.context}`] : []),
    ...seen.shown.map(fieldLine),
    ...(seen.more ? [moreLine(seen.more)] : []),
    ...(seen.others ? [othersLine(seen.others)] : []),
    ...(seen.partial ? [PARTIAL_LINE] : []),
    ...(changing ? [CHANGING_LINE] : []),
  ].join("\n");
}

/** As many of the fields as the card has room for, from the first. What
 * does not fit is counted, so the card can say so, and is never cut off
 * mid-line: the last lines always say how many are missing. Room is kept
 * for the line a third card adds. */
function fit(seen: Pick<Sighting, "host" | "label" | "context" | "others" | "partial">, fields: CommitField[]): { shown: CommitField[]; more: number } {
  const shown: CommitField[] = [];
  for (const field of fields) {
    const more = fields.length - shown.length - 1;
    if (shown.length >= SHOWN_FIELDS || subtitle({ ...seen, shown: [...shown, field], more: Math.max(more, 1) }, true).length > SUBTITLE_MAX) break;
    shown.push(field);
  }
  return { shown, more: fields.length - shown.length };
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
    const intent = commitIntent(call.params, name, args, this.sent.has(call.session));
    if (!intent) return this.relay(call, name);
    if (intent === "blind") return refusal(TYPED_BLIND);
    if (intent === "many") return refusal(TYPED_MANY);
    call.admit();
    // An earlier call of this browser was lost. The runtime waits for the
    // engine and answers in this call's place, as it does for a call that
    // is not judged. Nothing is read or judged meanwhile: the gate's own
    // reads would be refused, and the bot told to restart a browser that
    // recovers by itself, with the page that shows what the lost call did.
    const lost = await call.recover();
    if (lost !== null) return lost;
    const deadline = Date.now() + this.deps.holdMs;
    let first: Awaited<ReturnType<BrowserCommitGate["look"]>>;
    try {
      first = await this.look(call, intent);
    } catch (error) {
      // A call can be lost while this one is being looked at, and the
      // runtime then refuses the rest of the reads. Nothing of this call
      // has run: it gets the runtime's answer here too, when there is one.
      const since = await call.recover();
      if (since !== null) return since;
      throw error;
    }
    if (!intent.typed) return this.judged(call, intent, name, first, deadline);
    // Typed text with a line break. The text and its Enter never go to the
    // engine in one call: what Enter does at a field can only be judged once
    // the text is in it (a "Pay now" button disabled until then).
    if (first === "typed-commit" && intent.lines) return refusal(TYPED_ENTER);
    if (typeof first === "string" && first !== "typed-commit" && first !== "typed-apart") return refusal(blindReason(intent, first));
    return this.stepped(call, intent, name, args, first !== "typed-apart", deadline);
  }

  /** Text with line breaks, aimed at a text field. The engine would type
   * the text and press Enter in one go, and what Enter does there could
   * only be judged before the text was in: a button that is disabled until
   * its field has text would be pressed unseen. So the gate does it in
   * steps. It types what lies before a line break, at that field. It reads
   * the page afresh: when the field has the focus, the Enter is judged
   * exactly as an Enter press there and pressed by itself; when the focus
   * is anywhere else it is not pressed at all, because it would land on
   * something else. Then the next piece. The call as the bot wrote it is
   * never sent, so the text is typed once.
   *
   * One line break, at the end: its Enter is passed, held on a card or
   * refused like any Enter press. Several lines run only where each Enter
   * is a plain new line; at the first that is not, the gate stops. */
  private async stepped(call: CommitCall, intent: Intent, name: string, args: Record<string, unknown>, focused: boolean, deadline: number): Promise<unknown> {
    const selector = intent.selector as string;
    const pieces = intent.pieces ?? [];
    const press: Intent = { via: "enter", selector: null, shift: false, typed: false, key: "Enter", params: { name: "agent_browser_press", arguments: { key: "Enter" } } };
    /** What was typed first, and what the engine answered last. */
    let typed: unknown;
    let last: unknown;
    /** Is the selector's own field known to have the focus? */
    let sure = focused;
    // A step the engine lost (it never answered, and the browser is left
    // uncertain) is not a step that failed: it may have happened. The bot
    // is then told what the runtime said of it, and never that the text was
    // not typed or that Enter was not pressed.
    let lost = false;
    const step: CommitCall = {
      ...call,
      dispatch: async (params, holdId) => {
        const result = await call.dispatch(params, holdId);
        lost = failed(result) && this.deps.runtime.interrupted(call.session);
        return result;
      },
    };
    const stopped = (why: string): unknown => typed === undefined ? last : refusal((lost ? TYPED_LOST : why) + text(last));
    for (let at = 0; at < pieces.length; at += 1) {
      const words = pieces[at]!;
      lost = false;
      if (words) {
        last = await step.dispatch({ ...(intent.params as object), arguments: { ...args, selector, text: words } });
        if (failed(last)) return stopped(TYPED_PART);
        typed ??= last;
        sure = false;
      }
      if (at === pieces.length - 1) break;
      // An Enter is next. Where is the focus now? The same read as before
      // the text: is the selector's own element a text field that has it?
      if (!sure) {
        // A line break with nothing typed before it, at a field without the focus: nothing gives the field the focus.
        if (typed === undefined) return refusal(TYPED_UNFOCUSED);
        const now = await this.deps.runtime.withAgentAction(call.session, () => call.page.target(selector, true), "read").catch(() => "unreadable" as const);
        if (typeof now === "string" || now.also || !now.typable) return refusal(TYPED_NOT_TAKEN);
      }
      const seen = await this.look(call, press);
      if (intent.lines) {
        // Several lines: every Enter has to be a plain new line.
        if (seen !== null) return refusal(TYPED_PART);
        last = await step.dispatch(press.params);
        if (failed(last)) return lost && typed === undefined ? last : refusal((lost ? TYPED_LOST : TYPED_PART) + text(last));
      } else {
        last = await this.judged(step, press, name, seen, deadline);
        if (failed(last)) return stopped(TYPED_THEN);
      }
      // The Enter may have moved the focus.
      sure = false;
    }
    // The bot is told what became of the text and of the last step.
    return typed === undefined || typed === last ? last : { ...(last as object), content: [...content(typed), ...content(last)] };
  }

  /** What becomes of one call once it has been looked at: sent, refused, or
   * held on a card until the person answers. */
  private async judged(call: CommitCall, intent: Intent, name: string, first: Awaited<ReturnType<BrowserCommitGate["look"]>>, deadline: number): Promise<unknown> {
    // Not knowing is not the same as nothing to hold.
    if (first === "typed-commit" || first === "typed-apart") return refusal(TYPED_ENTER);
    if (typeof first === "string") return refusal(blindReason(intent, first));
    if (!first) return call.dispatch(intent.params);
    let seen: Sighting = first;

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

    // An approval the page changed under is void, and a new card is raised.
    // On a page that keeps changing by itself that would never end: after
    // two voids in a row the next card says so and is bound to less.
    for (let voids = 0; ; voids += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !call.active()) return refusal(UNANSWERED);
      const answer = await this.ask(call, intent, seen, row, remaining, voids >= 2);
      if (answer.next === "refuse") return refusal(answer.why);
      if (answer.next === "sent") return answer.result;
      seen = answer.seen;
    }
  }

  /** One card for what was seen, and the person's answer to it: send the
   * call, refuse it with a reason, or ask again because the page changed.
   * Whatever happens in here, dispatch, a timeout or a throw, the hold on
   * the browser, the waiting request and the screenshot are gone when it
   * returns, and the card is not left looking answerable. A hold that
   * outlived a failure would refuse every action in that browser until the
   * server restarted. */
  private async ask(
    call: CommitCall, intent: Intent, seen: Sighting, row: Pick<DecisionRow, "threadId" | "botId" | "botName" | "tool">, timeoutMs: number, changing: boolean,
  ): Promise<{ next: "sent"; result: unknown } | { next: "refuse"; why: string } | { next: "ask"; seen: Sighting }> {
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
      messageId = this.deps.post({ botId: call.botId, threadId: call.threadId, card: this.card(seen, tool, held.requestId, shot, changing) });
      this.deps.log({ ...row, requestId: held.requestId, summary: this.summary(seen, changing), decision: "card-shown", source: "outbound", rule: commitRule(seen.class) });

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
      // A card that said the page keeps changing is bound to less.
      if (now && typeof now !== "string" && (changing ? now.loose === seen.loose : now.digest === seen.digest)) {
        // The answer was Allow, but the bot's request may have closed while
        // the person had the browser or the page was read again. Then
        // nobody is waiting for this click, and it is not made.
        if (this.gone(call)) {
          settle(unavailable);
          close("gone");
          return { next: "refuse", why: UNANSWERED };
        }
        settle();
        // Keep other agents out until the approved action finishes, including
        // the runtime's pre-action page read. Only this dispatch owns the hold.
        this.remember(call.session, seen);
        return { next: "sent", result: await call.dispatch(intent.params, held.requestId) };
      }
      if (typeof now === "string") {
        settle(unavailable);
        close("unreadable");
        return { next: "refuse", why: now === "typed-commit" || now === "typed-apart" ? TYPED_ENTER : blindReason(intent, now) };
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

  /** A call that is not judged. It goes through as the bot sent it. Closing
   * the browser is the one thing that ends the reload hold: its history
   * goes with it. Opening another address does not, because the page's own
   * link or script can bring the posted page back to the front. */
  private async relay(call: CommitCall, name: string): Promise<unknown> {
    const result = await call.dispatch(call.params);
    if (CLOSES.has(name) && !failed(result)) this.sent.delete(call.session);
    return result;
  }

  /** The bot's call is no longer waiting: its request closed or its turn ended. */
  private gone(call: CommitCall): boolean {
    return call.signal.aborted || !call.active();
  }

  /** A commitment is about to be sent: from now on a reload in this browser
   * can repeat it, for as long as the browser lives. Money stays the class
   * once money was spent here. */
  private remember(session: string, seen: Sighting): void {
    if (seen.repeat) return;
    this.sentCount += 1;
    this.sent.set(session, { id: this.sentCount, class: this.sent.get(session)?.class === "money" ? "money" : seen.class });
  }

  /** What the call would act on right now. Null when it is no commitment
   * (or the engine has no such element and will say so itself); a Blind
   * reason when that could not be told. Throws what the runtime gate throws
   * when a person has the browser. */
  private async look(call: CommitCall, intent: Intent): Promise<Sighting | null | Blind | "typed-commit" | "typed-apart"> {
    if (intent.via === "reload") {
      const sent = this.sent.get(call.session);
      if (!sent) return null;
      const { address, host } = place(await this.deps.runtime.withAgentAction(call.session, () => call.page.url(), "read"));
      const digest = createHash("sha256").update(JSON.stringify([address, "reload", sent.id])).digest("hex");
      // No fields and no picture: what was sent is not this call's to show.
      return { class: sent.class, host, label: `Reload, which can repeat an earlier ${sent.class === "money" ? "payment" : "send"}`, context: "", shown: [], more: 0, others: 0, partial: false, digest, loose: digest, picture: false, repeat: true };
    }
    const enter = intent.via === "enter";
    const ref = intent.selector ? /^(?:@|ref=)?(e\d+)$/.exec(intent.selector)?.[1] : undefined;
    // A call was lost since the bot's last snapshot, and the engine numbers
    // its refs anew with every snapshot it takes, seen or not. The name the
    // bot's snapshot gave this ref may be another element's by now, and
    // that name is part of what a ref is judged by. Not knowing, the gate
    // does not act on the ref; the bot's next snapshot settles it.
    if (ref && this.deps.runtime.refsStale(call.session)) return "renumbered";
    // The first read: what the call would act on, enough to judge it.
    const found = await this.deps.runtime.withAgentAction(call.session, () => call.page.target(intent.selector, enter), "read");
    // Only "missing" says there is nothing to act on. For typed text it
    // says something else: the engine types at the focus when its selector
    // resolves to nothing (measured), so that Enter would land unseen.
    if (found === "missing") return intent.typed ? "untypable" : null;
    if (found === "unreadable" || found === "unusable" || found === "framed" || found === "sealed") return found;
    const known = ref ? this.deps.runtime.ref(call.session, ref) : undefined;
    // The snapshot's own name for a ref, as a target of its own: a click on
    // it, with nothing known about a form. `card` when it is most likely
    // inside a payment frame the read cannot look into.
    const bySnapshot = (card: boolean): CommitTarget => {
      const box = known?.role === "searchbox" ? "search" : known?.role === "textbox" ? "single" : null;
      return { via: "click", label: known?.name ?? "", role: known?.role ?? "", box, submits: false, search: box === "search", card, multiline: false, button: isButtonRole(known?.role ?? "") };
    };
    // What the page read described, and beside it what the snapshot named.
    let read: PageTarget[] = [];
    let targets: CommitTarget[];
    /** The element as the snapshot named it, when it is judged beside what was read. */
    let snapshot: CommitTarget | undefined;
    if (found === "hidden" || found === "hidden-pay") {
      // The engine found an element the page read cannot describe: it is
      // inside a frame, or it has no area. The snapshot's own name for the
      // ref is all there is to judge a click by; with no name, or for a key,
      // nothing is. In a payment frame a button is money whatever it says.
      if (!known || intent.via !== "click" || !intent.selector) return "undescribed";
      targets = [bySnapshot(found === "hidden-pay")];
    } else {
      // More than one element can share the box. Each is judged.
      read = [found, ...(found.also ?? [])];
      const named = Boolean(known && read.some((target) => sameName(target.label, known.name)));
      if (intent.typed) {
        // The engine measures an element inside a frame from the frame's own
        // corner, so on a page with a frame the element found in a ref's box
        // may be another one, outside the frame. When the snapshot does not
        // call it by the same name, nothing says where that Enter would land.
        if (ref && found.frames && !named) return "undescribed";
        if (intent.lines) {
          // Several lines go only into a multi-line field that already has
          // the focus: in a one-line field the first Enter may submit, and
          // the rest lands elsewhere.
          if (!read.every((target) => target.typable)) return "untypable";
          if (!read.every((target) => target.box === "multiline")) return "one-line";
        } else if (!read.every((target) => target.typable)) {
          // One line break at the end. At anything but a text field of its
          // own the engine types at the focus. At a text field that does
          // not have the focus the gate types the text itself and judges
          // the Enter afterwards, when the field can take the focus at all:
          // one that cannot would see its text go to whatever has it.
          if (read.length !== 1 || !found.field) return "untypable";
          return found.reach ? "typed-apart" : "unreachable";
        }
      }
      targets = read.map((target) => ({
        via: intent.via as "click" | "enter", shift: intent.shift, chord: intent.chord, label: target.label, role: target.role, box: target.box,
        submits: target.submits, search: target.search, card: target.card, multiline: target.multiline, button: target.button, changes: target.changes,
        link: target.link, signin: target.signin, carries: target.carries, hint: target.hint, only: target.only, says: target.says, near: target.near, lang: target.lang,
      }));
      // For a click, the element as the snapshot named it is judged beside
      // the element as it was read: whichever the box really belongs to, a
      // commitment by either is held. When the names differ on a page with
      // a payment frame, and the box could be inside that frame (it starts
      // within the frame's own size, where the engine measures from), the
      // ref is most likely in it.
      if (intent.via === "click" && known) {
        // The snapshot is naming the element that was read when it calls it
        // by the same name, or when the page has no frame for the ref to be
        // in and only one element has that box. Then what the read found
        // around that element holds for the snapshot's name too: a sign-in,
        // a form where something is attached, and (for a ref the snapshot
        // itself calls a link) a plain link.
        const twin = read.find((target) => sameName(target.label, known.name)) ?? (!found.frames && read.length === 1 ? read[0] : undefined);
        const seen = bySnapshot(found.inPay && !named);
        snapshot = twin ? { ...seen, link: twin.link && known.role === "link", signin: twin.signin, carries: twin.carries } : seen;
        targets.push(snapshot);
      }
    }
    // A ref the snapshot calls a link, that would be held for what the
    // snapshot calls it: the engine is asked where that link goes. Its own
    // word for the ref's element, whatever the names say and whichever
    // document the element is in. A link whose address goes to another page
    // is a plain link. (Inside a payment frame it is still a control like
    // any other; and an element the read itself found to act as a button
    // is judged as one beside it.)
    if (snapshot && !snapshot.link && known?.role === "link" && intent.selector && classifyCommit(snapshot)) {
      const selector = intent.selector;
      const [address, here] = await this.deps.runtime.withAgentAction(call.session, () => Promise.all([call.page.href(selector), call.page.url()]), "read");
      if (linkGoes(address, here)) snapshot.link = true;
    }
    // The snapshot's name is the browser's own; the page read's is ours. A
    // click is held when either one names a commitment, on any element the
    // engine might act on. The most serious one is the one shown.
    let pick: { kind: CommitClass; at: number; named: string } | undefined;
    targets.forEach((target, at) => {
      const labels = intent.via === "click" && known?.name && known.name !== target.label ? [target.label, known.name] : [target.label];
      const classes = labels.map((label) => classifyCommit({ ...target, label }));
      const kind: CommitClass | null = classes.includes("money") ? "money" : classes.includes("send") ? "send" : null;
      if (!kind || (pick && (pick.kind === "money" || kind === "send"))) return;
      pick = { kind, at, named: labels[classes.indexOf(kind)] || labels.find(Boolean) || `unlabelled ${target.role || "control"}` };
    });
    // Nothing to hold: the call goes on, and nothing more of the page is read.
    if (!pick) return null;
    if (intent.typed) return "typed-commit";
    const { kind, at, named } = pick as { kind: CommitClass; at: number; named: string };
    const target = targets[at]!;
    const label = enter && target.box === "multiline" && !target.submits ? `Enter in ${named}` : named;

    // The second read, only for a commitment: the evidence for its card and
    // what its approval is bound to.
    const [detail, url] = await this.deps.runtime.withAgentAction(
      call.session,
      () => Promise.all([read.length ? call.page.evidence(intent.selector, enter) : Promise.resolve<PageDetail>({ parts: [], secrets: false }), call.page.url()]),
      "read",
    );
    // The page moved between the two reads, or would not answer the second.
    if (typeof detail === "string" || detail.parts.length !== read.length) return "unreadable";
    const NONE: PageEvidence = { opaque: false, fields: [], others: 0, bound: "", identity: "", context: "", around: "" };
    const part = (index: number): PageEvidence => detail.parts[index] ?? NONE;
    const { address, host } = place(url);
    // What the approval is bound to: the address; which element it is and
    // the text around it (relative times and clocks evened out); every field
    // the card lists, at full length; and the page's own hash of every
    // control of the form or region, shown or not. For every element the
    // call might act on. The card shows less; this is all of it.
    const listed = (index: number) => part(index).fields.map((field) => [field.name, field.type, field.value ?? null, field.length ?? null]);
    const digest = createHash("sha256").update(JSON.stringify([
      address, intent.via, intent.key ?? null, known?.name ?? null,
      targets.map((each, index) => [each.label, each.role, part(index).identity, part(index).around, steady(part(index).context), part(index).bound, part(index).others, part(index).opaque, listed(index)]),
    ])).digest("hex");
    // What a third card is bound to, on a page that keeps changing by
    // itself: the address, the label and the controls. Not the text around
    // the element, and not its place in the page: a list that gains rows
    // above a button moves it every time.
    const loose = createHash("sha256").update(JSON.stringify([
      address, intent.via, intent.key ?? null, known?.name ?? null,
      targets.map((each, index) => [each.label, each.role, part(index).bound, part(index).others, part(index).opaque, listed(index)]),
    ])).digest("hex");
    const evidence = part(at);
    // The text around the element is carried only when nothing in it had to
    // be masked. When something did, the page is saying a secret out loud.
    const context = masked(evidence.context) === evidence.context ? evidence.context : "";
    const head = { host, label: clip(label, 120), context, others: evidence.others, partial: detail.parts.some((each) => each.opaque) };
    // No picture of a page that shows something the card masks, nor of one
    // the read could not look at: the picture would show what the card hides.
    const picture = read.length > 0 && !detail.secrets && context === evidence.context;
    return { class: kind, ...head, ...fit(head, evidence.fields.map(shownField)), digest, loose, picture };
  }

  private summary(seen: Sighting, changing = false): string {
    return clip(subtitle(seen, changing), SUBTITLE_MAX);
  }

  private card(seen: Sighting, tool: string, requestId: string, shot: string | undefined, changing: boolean): OptionCardData {
    const money = seen.class === "money";
    return {
      title: COMMIT_TITLE[seen.class],
      subtitle: this.summary(seen, changing),
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
        ...(seen.others ? { others: seen.others } : {}),
        ...(seen.partial ? { partial: true } : {}),
        ...(changing ? { changing: true } : {}),
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
