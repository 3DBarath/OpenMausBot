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
const SEND_WORDS = ["send", "reply", "post", "publish", "comment", "share", "message", "submit", "invite", "list item", "forward", "tweet", "notify", "accept invitation"];
const MONEY_WORDS = [
  "pay", "buy", "place order", "checkout", "bid", "book", "reserve", "subscribe", "donate", "transfer",
  "deposit", "withdraw", "add funds", "upgrade", "renew", "get tickets", "sell", "trade", "sign transaction", "charge",
];

/** Whole words only, in any letter case: "Post" and "Post reply" match,
 * "Posts" and "Repost" do not. A space in an entry is any white space. */
function wholeWords(words: readonly string[]): RegExp {
  const any = words.map((word) => word.replace(/ /g, "\\s+")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${any})(?![\\p{L}\\p{N}_])`, "iu");
}
const SEND = wholeWords(SEND_WORDS);
/** "Apply" is a send only where something is being submitted: on a form or
 * region with a file to attach or a multi-line field, or when the label
 * itself says an application goes out. On a filter or a coupon it is not. */
const APPLY = wholeWords(["apply"]);
const APPLY_PHRASES = wholeWords(["apply (?:now|today|here|online)", "(?:easy|quick|one-click|1-click) apply", "apply (?:for|to) (?:this|the|a) (?:job|role|position|opening)"]);

/** The other ways a button says what the Money list says. Each is still a
 * whole word or phrase.
 * - "purchase" and "check out" are acts unless what follows makes them a
 *   thing or an invitation to look ("Purchase history", "Check out our
 *   new arrivals").
 * - "order" is an act when it is the whole label, or says when
 *   ("Order now"), or again ("Reorder", "Pre-order"). */
const MONEY_PHRASES = [
  "purchase(?! (?:history|orders?|details|summary|agreement|protection|price|date|receipts?|policy|terms|options|records?)(?![\\p{L}\\p{N}_]))",
  "check out(?! (?:the|our|this|these|those|what|how|why|more|my|all|some|other|new|latest|an?)(?![\\p{L}\\p{N}_]))",
  "order (?:now|again|online|here|today)",
  "(?:pre|re)-?order",
  "place (?:an? |your |my )?bets?",
  "top[- ]?up",
  "start (?:your |my |an? )?free trial",
];
const MONEY = wholeWords([...MONEY_WORDS, ...MONEY_PHRASES]);
const ORDER_ALONE = /^\s*order\s*$/i;
/** What money is spent on or through. Alone these name a thing ("Order
 * history", "Payment methods") and hold nothing. Beside a word for
 * committing, or a Send word, the button spends: "Confirm booking",
 * "Make a payment", "Send money", "Submit order". */
const MONEY_THINGS = wholeWords(["orders?", "purchases?", "payments?", "money", "bookings?", "reservations?", "donations?", "checkout"]);
const COMMIT_VERBS = wholeWords(["place", "complete", "confirm", "finish", "finali[sz]e", "make", "authori[sz]e", "process"]);

/** Does this label spend money? "Confirm" alone does not, and neither does
 * a money word alone. */
function spends(label: string): boolean {
  return MONEY.test(label) || ORDER_ALONE.test(label) || (MONEY_THINGS.test(label) && (COMMIT_VERBS.test(label) || SEND.test(label) || APPLY.test(label)));
}

/** Does this label send something, on this form or region? */
function sends(target: CommitTarget): boolean {
  return SEND.test(target.label) || APPLY_PHRASES.test(target.label) || (APPLY.test(target.label) && Boolean(target.carries || target.multiline));
}

/** Labels that are known to send nothing. A form with a multi-line field is
 * otherwise taken for a send whatever its button says (that is what catches
 * a send in another language); these are the buttons of a profile, a
 * settings page, a note. The whole label must be one of them. ("Apply" has
 * a rule of its own above: with a multi-line field it is a send.) */
const HARMLESS: ReadonlySet<string> = new Set([
  "save", "save changes", "update", "next", "continue", "back", "cancel", "close", "done", "ok", "okay", "search", "filter", "sort", "reset", "clear",
  "add", "edit", "preview", "upload", "sign in", "signin", "log in", "login", "sign up", "signup", "create account", "register",
]);
const harmless = (label: string): boolean => HARMLESS.has(label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim());

/** The words a message composer is called by. */
const COMPOSER = wholeWords(["message", "reply", "comment", "chat"]);
/** Is the multi-line field Enter was pressed in a message composer? It is
 * when its keyboard hint says send; or when it is the only text field in
 * its form or region and either a send-labelled control is there or its own
 * label or placeholder has a composer word. A read that said nothing of the
 * field (`only` unknown) is taken for one: not knowing is not a new line. */
function composer(target: CommitTarget): boolean {
  if (target.hint || target.only === undefined) return true;
  return target.only && (COMPOSER.test(target.label) || COMPOSER.test(target.says ?? "") || (target.near ?? []).some((label) => SEND.test(label)));
}

/** Controls a click only toggles or selects. Their label names a state
 * ("Subscribe to the newsletter"), not an action. */
const PASSIVE_ROLES: ReadonlySet<string> = new Set([
  "checkbox", "radio", "switch", "option", "combobox", "listbox", "slider", "spinbutton", "tab", "treeitem",
  "menuitemcheckbox", "menuitemradio",
]);

/** One visible field of the form a commitment would submit. A password, a
 * card field or a code is read only inside the page, to count it: the
 * server gets its length, never its value. */
export interface CommitField {
  name: string;
  type: string;
  value?: string;
  /** With no value: how long the hidden value is. Beside a value on a card:
   * the value was shortened, and this is its full length. */
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
  /** The control is in a card region: its form, or with no form the region
   * of the page around it, holds a card field (by its autofill hint, or by
   * the names of two fields), a payment frame, or a card number typed in. */
  card: boolean;
  /** The form has a multi-line text field. */
  multiline: boolean;
  /** A control a click, Enter or Space activates: a button, a link,
   * something with a button's role, or a plain element styled as one. */
  button?: boolean;
  /** A list or a tick box with a handler of its own, or its form's, that
   * runs when it changes. */
  changes?: boolean;
  /** A plain link: an anchor whose address loads another document (not "#",
   * not "javascript:"), with no button role and no click handler written
   * on it. What it says is where it goes, not what it does. */
  link?: boolean;
  /** The form or region is a sign-in: it has a password field and no
   * multi-line field. */
  signin?: boolean;
  /** The form or region holds a file to attach or a multi-line field:
   * something is being submitted there. */
  carries?: boolean;
  /** Enter with a key other than Shift held: never a new line. */
  chord?: boolean;
  /** For Enter in a multi-line field, what the read found that could make
   * it a message composer. `hint`: its keyboard hint is "send". `only`: it
   * is the only text field in its form or region. `says`: its own label and
   * placeholder. `near`: the labels of the button-like controls there. */
  hint?: boolean;
  only?: boolean;
  says?: string;
  near?: string[];
}

/** The roles a snapshot gives to what a click activates. */
const BUTTON_ROLES: ReadonlySet<string> = new Set(["button", "link", "menuitem"]);
export function isButtonRole(role: string): boolean {
  return BUTTON_ROLES.has(role);
}

/** Is this a commitment, and of which class? Money wins when both match. */
export function classifyCommit(target: CommitTarget): CommitClass | null {
  // A search is never a commitment of either class, whatever its button
  // says and whatever was typed into it.
  if (target.search) return null;
  // A plain link is never a commitment by its text: it opens a page. Inside
  // a card region it is a control like any other.
  if (target.link && !target.card) return null;
  // A click into a text box only puts the cursor there, so its label ("Message")
  // is not an action. Enter in a one-line field acts through the submit button.
  const passive = PASSIVE_ROLES.has(target.role);
  const activates = (target.box === null || target.submits) && !passive;
  if (activates && spends(target.label)) return "money";
  // In a card region what a control is called says nothing about what it
  // does. Any activation of a button-like control there is money, whatever
  // its type or label: a click, Enter or Space on it, a submit, a list or a
  // tick box whose handler runs on change, Enter in one of its one-line fields.
  if (target.card && (target.submits || target.changes || (target.button && target.box === null && !passive) || (target.via === "enter" && target.box === "single"))) return "money";
  // A sign-in form is never a send, whatever its button says.
  if (target.signin) return null;
  if (activates && sends(target)) return "send";
  // Enter in a multi-line field is a new line, unless the field is a
  // message composer or another key is held. Inside a card region nothing
  // is taken for a new line.
  if (target.via === "enter" && target.box === "multiline" && !target.shift && (target.chord || target.card || composer(target))) return "send";
  if (target.submits && target.multiline && !harmless(target.label)) return "send";
  return null;
}

const ENTER_NAMES: ReadonlySet<string> = new Set(["enter", "return", "numpadenter"]);
const isEnter = (part: string): boolean => part === "\n" || part === "\r" || part === "\r\n" || ENTER_NAMES.has(part.trim().toLowerCase());

/** Enter, alone or anywhere in a chord, the way agent_browser_press names
 * keys: the engine takes the key from any part ("Enter+Shift" is Shift+Enter,
 * "Enter+Control" is Ctrl+Enter). Null for every other key.
 *
 * `shift` is true only for Shift and Enter and nothing else, in either
 * order: the one chord the engine types as a line break in a multi-line
 * field (checked against agent-browser 0.37.0 in a text area and a
 * contenteditable box). With any other modifier nothing is typed, so the
 * press is whatever the page makes of it. */
export function enterPress(key: unknown): { shift: boolean } | null {
  if (typeof key !== "string") return null;
  const parts = key.split("+");
  const enters = parts.filter(isEnter).length;
  if (!enters) return null;
  const shifts = parts.filter((part) => part.trim().toLowerCase() === "shift").length;
  return { shift: enters === 1 && shifts > 0 && shifts === parts.length - 1 };
}

/** Enter with a key other than Shift held ("Control+Enter", "Enter+Meta").
 * Nothing is typed then, and many pages submit on it. */
export function chordPress(key: unknown): boolean {
  const enter = enterPress(key);
  return Boolean(enter) && !enter!.shift && (key as string).split("+").length > 1;
}

/** Space, alone or in a chord, under every name agent_browser_press takes
 * for it ("Space" in any letter case, or the character itself). With the
 * focus on a button it clicks it (checked against agent-browser 0.37.0,
 * with Shift, Control or Alt held too). */
export function spacePress(key: unknown): boolean {
  return typeof key === "string" && key.split("+").some((part) => part === " " || ["space", "spacebar"].includes(part.trim().toLowerCase()));
}

export type ScriptAction = "click" | "network" | "write" | "event" | "navigation";

/** A handler called by hand: `el.onclick()`, `el.onsubmit.call(el)`. */
const called = (names: string): string => `\\.\\s*on(?:${names})\\s*(?:\\.\\s*(?:call|apply)\\s*)?\\(`;
/** The handlers a person's own action on a page runs. Calling one by hand
 * acts on the page; `x.onload()` and `emitter.once()` do not. */
const INTERACTION = "change|input|beforeinput|key(?:down|up|press)|mouse(?:down|up|over|enter|leave|move)|pointer(?:down|up|over|enter|leave|move)|touch(?:start|end|move)|focus(?:in|out)?|blur|reset|select|contextmenu|auxclick|paste|cut|copy|drop|drag\\w*|wheel|scroll";

/** A property whose write changes a field's content, or what this gate
 * reads an element by: its label, its role, its type. */
const WRITES = /\.\s*(?:value|checked|textContent|innerText|innerHTML|outerHTML|outerText|role|type|autocomplete|contentEditable|aria[A-Z]\w*)\s*[+-]?=(?!=)/g;
const OTHER_WRITES = /\bsetRangeText\s*\(|\bexecCommand\s*\(|\b(?:set|remove|toggle)Attribute(?:NS|Node)?\s*\(/;

/** Does the script write one of those properties on anything but an object
 * of its own? `out.value = el.value` is a read when the script itself says
 * `const out = {}` (or `[]`): a plain name, declared once, as a literal.
 * Anything else (an element, a call, a longer chain, a `let`) is a write. */
function writesToPage(script: string): boolean {
  if (OTHER_WRITES.test(script)) return true;
  for (const write of script.matchAll(WRITES)) {
    const receiver = /(?:^|[^\w$.)\]])([A-Za-z_$][\w$]*)\s*$/.exec(script.slice(0, write.index))?.[1];
    const own = receiver !== undefined && new RegExp(`\\bconst\\s+${receiver.replace(/\$/g, "\\$")}\\s*=\\s*[{[]`).test(script);
    if (!own) return true;
  }
  return false;
}

const SCRIPT_ACTIONS: ReadonlyArray<[ScriptAction, (script: string) => boolean]> = [
  // A click or a submit, by the element's own method or by calling its handler.
  ["click", (script) => new RegExp(`\\.\\s*(?:click|submit|requestSubmit)\\s*\\(|${called("click|dblclick|submit")}`).test(script)],
  // The browser's own senders, and the libraries that wrap them: jQuery's $.post and friends, axios.
  ["network", (script) => /\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|(?:\$|\bjQuery)\s*\.\s*(?:ajax|post|get|getJSON|getScript)\s*\(|\baxios\s*(?:\.\s*\w+\s*)?\(/.test(script)],
  // A field's content, or what this gate reads an element by, written on the page.
  ["write", writesToPage],
  // An event made by hand: dispatchEvent, jQuery's trigger, or a handler of a person's own action called directly.
  ["event", (script) => new RegExp(`\\bdispatchEvent\\s*\\(|\\.\\s*trigger(?:Handler)?\\s*\\(|${called(INTERACTION)}`).test(script)],
  [
    "navigation",
    (script) => /(?<!\b(?:const|let|var)\s+)\blocation\s*(?:\.\s*(?:href|pathname|search|hash)\s*)?=(?!=)|\blocation\s*\.\s*(?:assign|replace|reload)\s*\(|\bhistory\s*\.\s*(?:pushState|replaceState|back|forward|go)\s*\(|\bwindow\s*\.\s*open\s*\(/.test(script),
  ],
];

/** What a page script would do besides read, by its text. A guard against a
 * bot acting through agent_browser_eval by habit, not a wall: a script that
 * hides its calls gets past a text check. */
export function scriptAction(script: string): ScriptAction | null {
  for (const [action, acts] of SCRIPT_ACTIONS) if (acts(script)) return action;
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
  /** The visible text of the row, list item, card or dialog the element is in. */
  context?: string;
  /** The first fields, each value shortened to fit. */
  fields: CommitField[];
  /** How many more fields the approval covers than `fields` shows. */
  more?: number;
  /** Filled fields elsewhere on the page that the approval is bound to but
   * the card does not list. */
  others?: number;
  /** The page changed under two approvals in a row, so this one is bound to
   * less: the element's place, its label and the fields. */
  changing?: boolean;
  /** The server's own screenshot, as an attachment path, while the card is open. */
  shot?: string;
  /** No screenshot was taken, while the card is open: the page shows a
   * field whose value the card masks, or could not be checked for one. */
  noShot?: boolean;
  /** The page changed after the answer, so the approval was not used. */
  pageChanged?: boolean;
}
