// Browser commitments: the clicks and Enter presses that send something to
// another person, or spend money. They get the same confirmation as an
// outbound connected-app call (shared/outbound.ts), at every approval level,
// because the built-in browser is otherwise pre-approved.
//
// Shared between the harness (which holds the call) and the app (which labels
// the card), so both agree on what a commitment is.

export type CommitClass = "send" | "money";

/** English in the first version. The form rules in classifyCommit are the
 * fallback for every other language. */
const SEND_WORDS = ["send", "reply", "post", "publish", "comment", "share", "message", "submit", "invite", "apply", "list item"];
const MONEY_WORDS = ["pay", "buy", "place order", "checkout", "bid", "book", "reserve", "subscribe", "donate", "transfer"];

/** Whole words only, in any letter case: "Post" and "Post reply" match,
 * "Posts" and "Repost" do not. */
function wholeWords(words: readonly string[]): RegExp {
  const any = words.map((word) => word.replace(/ /g, "\\s+")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${any})(?![\\p{L}\\p{N}_])`, "iu");
}
const SEND = wholeWords(SEND_WORDS);
const MONEY = wholeWords(MONEY_WORDS);

/** Controls a click only toggles or selects. Their label names a state
 * ("Subscribe to the newsletter"), not an action. */
const PASSIVE_ROLES: ReadonlySet<string> = new Set([
  "checkbox", "radio", "switch", "option", "combobox", "listbox", "slider", "spinbutton", "tab", "treeitem",
  "menuitemcheckbox", "menuitemradio",
]);

/** One visible field of the form a commitment would submit. A password or a
 * card number is never read, only how long it is. */
export interface CommitField {
  name: string;
  type: string;
  value?: string;
  length?: number;
}

/** What a click or an Enter press would act on, as the server read it from
 * the page (server/browser-commit-page.ts). */
export interface CommitTarget {
  via: "click" | "enter";
  /** Shift+Enter: a new line in a message box, a plain Enter anywhere else. */
  shift?: boolean;
  /** The control that would be activated. For Enter in a one-line field of
   * a form, that is the form's submit button. */
  label: string;
  role: string;
  /** The text box the click lands in or the focus is in, when it is one. */
  box: "multiline" | "search" | "single" | null;
  /** Activating the control submits its form. */
  submits: boolean;
  /** A search field, something inside role="search", or a form whose only
   * text field is a search field. */
  search: boolean;
  /** The form has a card field (autocomplete="cc-*"). */
  card: boolean;
  /** The form has a multi-line text field. */
  multiline: boolean;
}

/** Is this a commitment, and of which class? Money wins when both match. */
export function classifyCommit(target: CommitTarget): CommitClass | null {
  // A click into a text box only puts the cursor there, so its label ("Message")
  // is not an action. Enter in a one-line field acts through the submit button.
  const activates = (target.box === null || target.submits) && !PASSIVE_ROLES.has(target.role);
  if (activates && MONEY.test(target.label)) return "money";
  if (target.submits && target.card) return "money";
  // Search is never a send, whatever the button says.
  if (target.search) return null;
  if (activates && SEND.test(target.label)) return "send";
  if (target.via === "enter" && target.box === "multiline" && !target.shift) return "send";
  if (target.submits && target.multiline) return "send";
  return null;
}

/** Enter, alone or in a chord, the way agent_browser_press names keys.
 * Null for every other key. */
export function enterPress(key: unknown): { shift: boolean } | null {
  if (typeof key !== "string") return null;
  const parts = key.split("+");
  const last = parts.at(-1) ?? "";
  const name = last === "\n" || last === "\r" || last === "\r\n" ? "enter" : last.trim().toLowerCase();
  if (name !== "enter" && name !== "return") return null;
  return { shift: parts.slice(0, -1).some((part) => part.trim().toLowerCase() === "shift") };
}

export type ScriptAction = "click" | "network" | "write" | "event" | "navigation";

const SCRIPT_ACTIONS: ReadonlyArray<[ScriptAction, RegExp]> = [
  ["click", /\.\s*(?:click|submit|requestSubmit)\s*\(/],
  ["network", /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b/],
  ["write", /\.\s*(?:value|checked|textContent|innerText|innerHTML)\s*[+-]?=(?!=)|\bsetRangeText\s*\(|\bexecCommand\s*\(/],
  ["event", /\bdispatchEvent\s*\(/],
  [
    "navigation",
    /(?<!\b(?:const|let|var)\s+)\blocation\s*(?:\.\s*(?:href|pathname|search|hash)\s*)?=(?!=)|\blocation\s*\.\s*(?:assign|replace|reload)\s*\(|\bhistory\s*\.\s*(?:pushState|replaceState|back|forward|go)\s*\(|\bwindow\s*\.\s*open\s*\(/,
  ],
];

/** What a page script would do besides read, by its text. A guard against a
 * bot acting through agent_browser_eval by habit, not a wall: a script that
 * hides its calls gets past a text check. */
export function scriptAction(script: string): ScriptAction | null {
  for (const [action, pattern] of SCRIPT_ACTIONS) if (pattern.test(script)) return action;
  return null;
}

/** The card title for each class, as every client shows it. */
export const COMMIT_TITLE: Record<CommitClass, string> = {
  send: "Send on your behalf?",
  money: "Spend money?",
};

/** How a browser commitment is named in the decision log's `rule`: this
 * prefix, its class, then what happened to it
 * ("browser-commit:send:page-changed"). */
const COMMIT_RULE = "browser-commit";

export function commitRule(kind: CommitClass, outcome?: string): string {
  return outcome ? `${COMMIT_RULE}:${kind}:${outcome}` : `${COMMIT_RULE}:${kind}`;
}

/** The class a decision-log rule names, or null for any other rule. */
export function commitRuleClass(rule: string | undefined): CommitClass | null {
  const [prefix, kind] = (rule ?? "").split(":");
  return prefix === COMMIT_RULE && (kind === "send" || kind === "money") ? kind : null;
}

/** What a held browser commitment carries on its card, beside the
 * outboundRequest marker every send card has. */
export interface BrowserCommitCard {
  class: CommitClass;
  host: string;
  label: string;
  fields: CommitField[];
  /** The server's own screenshot, as an attachment path, while the card is open. */
  shot?: string;
  /** The page changed after the answer, so the approval was not used. */
  pageChanged?: boolean;
}
