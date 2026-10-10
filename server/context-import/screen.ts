// The import's own screen: what never reaches the model, the batches file,
// About me or a shared note, and what starts unticked. An export is years of
// someone's chats, so it holds things bot memory never sees: a password said
// in passing, a card number, an identity or bank number, and text written to
// steer an assistant. The general scrub (shared/redact.ts) masks key shapes
// in logs and is left as it is for every other feature; this screen is
// stricter and belongs to the import alone.
//
//   secrets            A proposed fact that holds one is dropped, never
//                      masked: a masked secret in a note still says where the
//                      secret was. A message is different: it is read, with
//                      only the secret's value cut out of it, because a
//                      message that mentions a password is nearly always
//                      about something else.
//   instructions       A fact that is an order to an assistant, a grant of
//                      permission to one, a command, code or a full link is
//                      dropped: an imported note is later put in front of a
//                      bot. A preference said as a statement about the
//                      person ("prefers replies without emoji") is a fact.
//   aliases, subjects  An alias may not be a common word; a subject goes
//                      through the same rules as a fact.
//   sensitive          The model's label and the fact's own words, as one of
//                      the categories; a sensitive fact starts unticked.
//
// Pure. The rules work on wording and shapes, so they are a net, not a
// guarantee, and they are held to a written sample from both sides
// (server/testing/context-import-ordinary.ts): what is ordinary stays, and
// what is a secret or an instruction goes.
import { redactSecretsInText } from "../redact.ts";
import { isCommonWord } from "../shared-notes.ts";
import { cutMessage } from "./cuts.ts";
import { SENSITIVE_CATEGORIES, type NamedSensitiveCategory, type SensitiveCategory } from "../../shared/context-import.ts";

// ── secrets ───────────────────────────────────────────────────────────

/** What stands where a secret's value was cut out of a message. */
export const SECRET_CUT = "[removed]";

type Span = [start: number, end: number];

/** Words that name something a person types to get in. */
const PASSWORD_WORD = "pass(?:word|code|phrase|wd)s?|pwd|otp|secret\\s+(?:key|code|word)|recovery\\s+(?:code|key|phrase)|seed\\s+phrase|api[\\s_-]?key|access\\s+(?:code|key|token)|(?:auth(?:entication)?|verification|login|unlock|2fa|mfa|backup)\\s+code";
/** Words that name a short number that opens something. */
const CODE_WORD = "pin(?:\\s*(?:code|number))?|(?:door|gate|alarm|safe|garage|locker|entry|building|lock|keypad|voicemail|sim|security)\\s+(?:code|pin|combination|combo|passcode)|(?:safe|lock)\\s+combination";
const LINKER = "(?:\\bis\\b|\\bwas\\b|\\bare\\b|[:=])";
const OPEN_QUOTE = "[\"'“‘]?";
const TOKEN = "([^\\s\"'”’,;]+)";
/** A short number as a door or a phone takes it: digits, with spaces or dashes, perhaps a # after. */
const CODE_VALUE = "(\\d(?:[ -]?\\d){2,11}#?)";

/** `the password is VALUE`, with a few words in between allowed ("for the wifi"). */
const PASSWORD_THEN_VALUE = new RegExp(`\\b(?:${PASSWORD_WORD})\\b(?:\\s+(?!is\\b|was\\b|are\\b)[\\w'’.-]+){0,4}?\\s*${LINKER}\\s*${OPEN_QUOTE}${TOKEN}`, "gi");
/** A value written in groups of four, as an app password or a recovery
 * code is: three to eight groups, with spaces or dashes between them. */
const GROUPED_VALUE = "([A-Za-z0-9]{4}(?:[ -][A-Za-z0-9]{4}){2,7})(?![A-Za-z0-9])";
/** `the recovery code is 4f7a 9c2d 11be 03aa`: one value, when it holds a
 * digit. Four short words after "the password is" are a sentence. */
const PASSWORD_THEN_GROUPS = new RegExp(`\\b(?:${PASSWORD_WORD})\\b(?:\\s+(?!is\\b|was\\b|are\\b)[\\w'’.-]+){0,4}?\\s*${LINKER}\\s*${OPEN_QUOTE}${GROUPED_VALUE}`, "gi");
/** `my app password is abcd efgh ijkl mnop`: an app password is sixteen
 * letters in four groups, so there letters alone are enough. */
const APP_PASSWORD_THEN_GROUPS = new RegExp(`\\bapp(?:lication)?(?:[\\s-]+specific)?[\\s-]+passwords?\\b(?:\\s+(?!is\\b|was\\b|are\\b)[\\w'’.-]+){0,4}?\\s*${LINKER}\\s*${OPEN_QUOTE}${GROUPED_VALUE}`, "gi");
/** `the password VALUE`, the value straight after the word. */
const PASSWORD_VALUE = new RegExp(`\\b(?:${PASSWORD_WORD})\\b\\s+${OPEN_QUOTE}${TOKEN}`, "gi");
/** `VALUE is the wifi password`. The word ends its phrase: "1Password is my password manager" names no password. */
const VALUE_THEN_PASSWORD = new RegExp(`(?<![\\w@.-])${TOKEN}\\s+(?:is|was|as)\\s+(?:(?:my|the|our|his|her|their|your|a)\\s+)?(?:[\\w'’-]+\\s+){0,3}?(?:${PASSWORD_WORD}|${CODE_WORD})\\b(?=\\s*(?:$|[.,;!?)]|\\b(?:for|on|to|at|in|of)\\b))`, "gi");
/** `the door code is 4821`, `PIN 4821`, `alarm code: 9911`. */
const CODE_THEN_VALUE = new RegExp(`\\b(?:${CODE_WORD})\\b(?:\\s+(?!is\\b|was\\b)[\\w'’-]+){0,4}?\\s*(?:\\bis\\b|\\bwas\\b|[:=#])\\s*${CODE_VALUE}(?![\\d/.-])`, "gi");
const CODE_VALUE_NEXT = new RegExp(`\\b(?:${CODE_WORD})\\b\\s+${CODE_VALUE}(?![\\d/.-])`, "gi");
/** A card's security code: three or four digits near its name. */
const SECURITY_CODE = /\b(?:cvv2?|cvc2?|cid|csc|(?:card\s+)?security\s+code|card\s+code)\b\D{0,16}(\d{3,4})\b/gi;
/** What a site asks to prove it is you, and the answer given. */
const SECURITY_ANSWERS: readonly RegExp[] = [
  /\b(?:security|secret)\s+(?:question\s+)?answers?\b[^.!?\n]{0,40}?(?:\bis\b|\bwas\b|[:=])\s*["'“‘]?([^\s"'”’.,;!?]+)/gi,
  /\bsecurity\s+questions?\b[^.!?\n]{0,60}?\banswers?\b[^.!?\n]{0,20}?(?:\bis\b|\bwas\b|\bare\b|[:=])\s*["'“‘]?([^\s"'”’.,;!?]+)/gi,
  /\banswers?\s+to\b[^.!?\n]{0,40}?\bsecurity\s+questions?\b[^.!?\n]{0,10}?(?:\bis\b|\bwas\b|[:=])\s*["'“‘]?([^\s"'”’.,;!?]+)/gi,
  /\bmother['’]?s\s+maiden\s+name\b[^.!?\n]{0,20}?(?:\bis\b|\bwas\b|[:=])\s*["'“‘]?([^\s"'”’.,;!?]+)/gi,
];
/** Runs of 13 to 19 digits, grouped by spaces or dashes or not at all. */
const DIGIT_RUN = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const CARD_WORD = /\bcards?\b/gi;

/** Identity numbers by their shape: a US social security number, an Indian
 * Aadhaar (three groups of four) and PAN, a UK National Insurance number. */
const ID_SHAPES: readonly RegExp[] = [
  /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g,
  /(?<!\d)(?<!\d[ -])[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![ -]?\d)/g,
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g,
];
/** …and by their name: the document, then a value with digits in it. */
const NAMED_ID = /\b(?:passport|driv(?:er|ing)['’]?s?\s+licen[cs]e|licen[cs]e|national\s+(?:id(?:entity)?|insurance)|identity\s+card|id\s+(?:card|number)|tax\s+(?:id|number)|taxpayer|social\s+(?:security|insurance)|ssn|itin|ein|nino|aadhaa?r|voter\s+id)\b[^.\n]{0,28}?(?:\bnumber\b|\bno\b\.?|#|\bis\b|:)?\s*[:#]?\s*(?<![A-Z0-9/-])((?=[A-Z0-9-]*\d[A-Z0-9-]*\d[A-Z0-9-]*\d[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,19})(?![A-Z0-9/-])/gi;
/** Bank details: an account, routing or sort-code number by name, an Indian
 * IFSC code by shape, and an IBAN that passes its own check. */
const NAMED_BANK = /\b(?:(?:bank\s+)?account|acct|a\/c|routing|aba|sort\s*code|swift|bic|ifsc|iban)\b[^.\n]{0,16}?(?:\bnumber\b|\bno\b\.?|\bcode\b|#|\bis\b|:)?\s*[:#]?\s*(?:\bis\b\s*)?(?<![\d/-])(\d[\d -]{4,24}\d)(?![\d/-])/gi;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;

/** The check every payment card number passes. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let at = digits.length - 1; at >= 0; at -= 1) {
    let digit = digits.charCodeAt(at) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

function validIban(candidate: string): boolean {
  const compact = candidate.replace(/ /g, "");
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of moved) {
    const value = char >= "0" && char <= "9" ? char : String(char.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** A date, a year, a time or a plain small number: what a sentence about a
 * password or a document usually has near it, and never the secret itself. */
function dateOrCount(value: string): boolean {
  return /^\d{1,2}$/.test(value) || /^(?:19|20)\d{2}$/.test(value) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(value) ||
    /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value) || /^\d{1,2}[/.-]\d{2,4}$/.test(value) || /^\d{1,2}:\d{2}$/.test(value);
}

/** Whether a word after "the password is" can be a password: it has a digit,
 * or a sign and some length, or is long, or mixes its capitals. "too",
 * "stored" and "sent" are what such a sentence says when it gives none. */
function passwordLike(raw: string): boolean {
  const value = raw.replace(/[.!?)\]]+$/, "");
  if (value.length < 4 || dateOrCount(value)) return false;
  if (/\d/.test(value)) return true;
  if (/[^A-Za-z0-9'’-]/.test(value) && value.length >= 6) return true;
  return value.length >= 14 || (/[a-z][A-Z]/.test(value) && value.length >= 8);
}

/** Where the secrets in a piece of text are: the value of each, not the words around it. */
function secretSpans(text: string): Span[] {
  const spans: Span[] = [];
  const value = (match: RegExpMatchArray, ok: (found: string) => boolean = () => true) => {
    const found = match[1];
    if (found === undefined || !ok(found)) return;
    const start = match.index! + match[0].lastIndexOf(found);
    spans.push([start, start + found.replace(/[.!?)\]]+$/, "").length]);
  };
  for (const match of text.matchAll(PASSWORD_THEN_VALUE)) value(match, passwordLike);
  // written in groups, the whole of it is the value, not its first group
  for (const match of text.matchAll(PASSWORD_THEN_GROUPS)) value(match, (found) => /\d/.test(found));
  for (const match of text.matchAll(APP_PASSWORD_THEN_GROUPS)) value(match);
  for (const match of text.matchAll(PASSWORD_VALUE)) value(match, (found) => /\d/.test(found) && passwordLike(found));
  for (const match of text.matchAll(VALUE_THEN_PASSWORD)) {
    const found = match[1];
    if (found === undefined || !passwordLike(found) && !/^\d{3,12}#?$/.test(found)) continue;
    if (/^(?:19|20)\d{2}$/.test(found)) continue;
    spans.push([match.index!, match.index! + found.length]);
  }
  for (const match of text.matchAll(CODE_THEN_VALUE)) value(match);
  for (const match of text.matchAll(CODE_VALUE_NEXT)) value(match);
  for (const match of text.matchAll(SECURITY_CODE)) value(match);
  for (const pattern of SECURITY_ANSWERS) for (const match of text.matchAll(pattern)) value(match, (found) => found.length >= 2);
  // a payment card: a run that passes the card check anywhere, and any run of that length near the word "card"
  const cards = [...text.matchAll(CARD_WORD)].map((match) => match.index!);
  for (const match of text.matchAll(DIGIT_RUN)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (passesLuhn(match[0].replace(/[ -]/g, "")) || cards.some((at) => at >= start - 48 && at <= end + 48)) spans.push([start, end]);
  }
  for (const shape of ID_SHAPES) for (const match of text.matchAll(shape)) spans.push([match.index!, match.index! + match[0].length]);
  for (const match of text.matchAll(NAMED_ID)) value(match, (found) => !dateOrCount(found));
  for (const match of text.matchAll(NAMED_BANK)) value(match, (found) => !dateOrCount(found.trim()) && found.replace(/\D/g, "").length >= 6);
  for (const match of text.matchAll(IFSC)) spans.push([match.index!, match.index! + match[0].length]);
  for (const match of text.matchAll(IBAN)) if (validIban(match[0])) spans.push([match.index!, match.index! + match[0].length]);
  // what was cut before is not found again
  return spans.filter(([start, end]) => end > start && !text.startsWith(SECRET_CUT, start)).sort((a, b) => a[0] - b[0]);
}

const REDACTED = /«redacted \d+ chars»/g;

/** A piece of text with every secret's value cut out of it, and how many
 * were cut: keys the general scrub knows, and whatever secretSpans finds. */
export function cutSecrets(text: string): { text: string; cut: number } {
  if (!text) return { text, cut: 0 };
  let cut = 0;
  let out = "";
  let at = 0;
  for (const [start, end] of secretSpans(text)) {
    if (start < at) {
      // overlapping finds are one secret: only stretch the cut
      if (end > at) at = end;
      continue;
    }
    out += text.slice(at, start) + SECRET_CUT;
    at = end;
    cut += 1;
  }
  out += text.slice(at);
  const scrubbed = redactSecretsInText(out);
  if (scrubbed !== out) {
    cut += scrubbed.match(REDACTED)?.length ?? 1;
    out = scrubbed.replace(REDACTED, SECRET_CUT);
  }
  return { text: out, cut };
}

/** Whether a piece of text holds something that must not be kept or sent: a
 * key the general scrub would mask, a password, passcode or PIN, a door,
 * gate, alarm or safe code, the answer to a security question, a payment
 * card number, a card's security code, or a common identity or bank number. */
export function holdsSecret(text: string): boolean {
  if (!text) return false;
  return redactSecretsInText(text) !== text || secretSpans(text).length > 0;
}

// ── instructions, commands, code and links ────────────────────────────

/** Endings a site's name commonly has, for telling `example.com/path` from `Node.js/Express`. */
const SITE_ENDINGS = "com|net|org|io|dev|app|ai|co|sh|xyz|me|info|biz|gov|edu|test|ly|to|gg|tv|cc|uk|de|fr|in|us|ca|au|jp|ru|ch|nl|se|es|it|br|eu|site|online|store|page|link|click|top|cloud";
/** A full link: with a scheme, as a markdown link, as a site with a path, or
 * as a bare network address. A site's bare name ("amazon.com") is a name. In any case. */
const LINK = new RegExp([
  "\\b[a-z][a-z0-9+.-]{1,15}:\\/\\/\\S",
  "\\]\\(\\s*\\S",
  `(?<![@\\w.-])(?:[a-z0-9-]+\\.)+(?:${SITE_ENDINGS})(?::\\d{2,5})?\\/[^\\s)]`,
  "(?<![\\d.])(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?![\\d.])",
].join("|"), "i");
/** Something a shell or an interpreter would run, in any case. Each is a
 * shape only code has: a word that is also English ("drop", "select",
 * "import", "curl") is not one by itself. */
const CODE = new RegExp([
  "`", "\\$\\(", "&&", "\\|\\|", "=>", "<\\/?[a-z][\\w-]*(?:\\s[^<>]*)?>", "\\bjavascript:",
  "\\|\\s*(?:sh|bash|zsh|python\\d?|node|perl|ruby|powershell|pwsh|cmd)\\b",
  "\\b(?:curl|wget|ssh|scp)\\s+(?:-{1,2}\\w|\\S*[./@:]\\S)", "\\bnc\\s+-[a-z]",
  "\\bsudo\\s+[a-z]", "\\bchmod\\s+[+\\-\\d]", "\\bchown\\s+\\S+\\s+\\S", "\\brm\\s+-[a-z]", "\\b(?:bash|sh|zsh|cmd)\\s+[-/]c\\b", "\\b(?:powershell|pwsh)\\s+-", "\\bbase64\\s+-{1,2}d",
  "\\b(?:npm|pnpm|yarn|pip3?|brew|apt|apt-get|cargo|gem)\\s+(?:install|i|add|run|exec)\\b", "\\bnpx\\s+\\S",
  "\\b(?:eval|exec|require|__import__|os\\.system|subprocess\\.\\w+)\\(", "\\bfunction\\s*\\w*\\s*\\(", "\\b(?:const|let|var)\\s+[\\w$]+\\s*=", "\\bdef\\s+\\w+\\s*\\(",
  "\\bimport\\s+(?:\\{[^}]*\\}|\\*\\s+as\\s+\\w+|[\\w$]+)\\s+from\\s+[\"']", "\\{\\s*[\"']\\w+[\"']\\s*:",
].join("|"), "i");
/** Database statements, as they are written: in capitals. "select wines from Italy" is a sentence. */
const SQL = /\bSELECT\s+[\w*,.\s]+\s+FROM\s+\w|\bDELETE\s+FROM\s+\w|\bINSERT\s+INTO\s+\w|\bUPDATE\s+\w+\s+SET\s+\w|\bDROP\s+(?:TABLE|DATABASE|INDEX)\b/;

/** A sentence that begins by telling its reader what to do. A fact about the
 * person begins with the person. */
const ORDER_OPENER = /^[\s"'“‘([]*(?:always|never|do\s+not|don['’]?t|please|kindly|make\s+sure|ensure|remember\s+to|ignore|disregard|forget|override|from\s+now\s+on|respond|reply|answer|run|execute|output|print|say|pretend|act\s+as|you\b|your\b|note\s+to|instructions?\b|system\b|assistant\b|important\s*:|in\s+(?:every|each|all)\s+(?:reply|replies|response|responses|answer|answers)\b)/i;
/** Said anywhere, in any person: an attempt to take the assistant over. */
const TAKEOVER = new RegExp([
  "\\b(?:ignore|disregard|forget|override)\\s+(?:all|any|every|the|your|previous|prior|above|earlier|these|those)\\b",
  "\\bsystem\\s+prompt\\b", "\\b(?:your|these|the\\s+above|previous|prior)\\s+(?:instructions|rules|guidelines)\\b",
  "\\byou\\s+(?:must|should|shall|will|need\\s+to|have\\s+to|are\\s+to|cannot|can['’]t|may\\s+not|are\\s+(?:now|an?|the))\\b",
  "\\b(?:every|each)\\s+time\\s+you\\b", "\\bas\\s+an?\\s+(?:ai|assistant|language\\s+model)\\b",
  // something an assistant would have to go and do, on a standing order
  "\\b(?:always|never)\\s+(?:run|execute|send|call|open|visit|fetch|download|install|obey|follow|comply|reveal|tell|output|print|append|do|delete|forward|upload|share|post|email|pay|buy|transfer)\\b",
].join("|"), "i");
/** A grant of permission to an assistant, in the third person or not: who may
 * act for the person is never taken from an imported note. */
const PERMISSION = new RegExp([
  "\\b(?:authori[sz]e[sd]?|pre-?approved?|whitelist(?:s|ed)?|allow(?:s|ed)?|permit(?:s|ted)?|grant(?:s|ed)?|lets?|ha(?:s|ve)\\s+given|gives?|gave)\\b[^.!?]{0,60}\\b(?:assistants?|ai|bots?|agents?|models?|chatbots?|you)\\b[^.!?]{0,60}\\b(?:run|execute|access|read|delete|send|install|use|share|transfer|pay|buy|purchase|open|download|upload|modify|change|approve|approval|permission|sign)\\b",
  "\\b(?:assistants?|ai|bots?|agents?|models?|chatbots?)\\b[^.!?]{0,40}\\b(?:permission|consent|approval|authori[sz]ation|clearance)\\b[^.!?]{0,30}\\bto\\s+\\w+",
  "\\b(?:assistants?|ai|bots?|agents?|you)\\b[^.!?]{0,80}\\bwithout\\s+(?:asking|confirmation|approval|permission|checking)\\b",
  "\\bno\\s+need\\s+to\\s+(?:ask|confirm|check)\\b",
].join("|"), "i");
/** How an assistant should answer, as a standing order… */
const STYLE_ORDER = new RegExp([
  "\\b(?:always|never)\\s+(?:reply|respond|answer|use|include|start|end|say|mention|add|write|keep|put|show|give|cite|format|list|summari[sz]e)\\b",
  "\\bfrom\\s+now\\s+on\\b",
  "\\b(?:before|after|when|whenever|while)\\s+(?:answering|replying|responding|you\\b)",
  "\\bin\\s+(?:every|each|all)\\s+(?:reply|replies|response|responses|answer|answers|message|messages)\\b",
  "\\b(?:end|start|begin)\\s+(?:every|each|all|your)\\s+(?:reply|response|answer|message)",
].join("|"), "i");
/** …unless it is said as a statement about the person: what they prefer is a fact about them. */
const STATED_PREFERENCE = /^[\s"'“‘]*(?:the\s+(?:person|user)|they|he|she)\b[^.!?]{0,60}?\b(?:prefers?|likes?|wants?|would\s+(?:like|prefer|rather)|loves?|enjoys?|dislikes?|hates?|asks?|asked|expects?|needs?|finds?)\b/i;

/** Whether text holds a command, code or a full link. */
export function holdsCodeOrLink(text: string): boolean {
  return LINK.test(text) || CODE.test(text) || SQL.test(text);
}

/** Whether a proposed fact is an instruction to an assistant, a grant of
 * permission to one, or carries a command, code or a full link. Such text is
 * never a fact about the person, and recalled later it would sit in front of
 * a bot. */
export function readsAsInstruction(text: string): boolean {
  if (holdsCodeOrLink(text) || ORDER_OPENER.test(text) || TAKEOVER.test(text) || PERMISSION.test(text)) return true;
  return STYLE_ORDER.test(text) && !STATED_PREFERENCE.test(text);
}

// ── the person's own messages ─────────────────────────────────────────

/** The person's messages as they may be sent: each one whole, but for the
 * value of any secret in it, which is cut out. `cut` counts the messages
 * something was cut from. The scan and the read both use this, so the
 * estimate is the work that is done. */
export function screenMessages(messages: readonly string[]): { messages: string[]; cut: number } {
  const kept: string[] = [];
  let cut = 0;
  for (const message of messages) {
    // only what would be sent is looked at: past the cut, a message is not read at all
    if (!cutMessage(message)) continue;
    const screened = cutSecrets(message);
    if (screened.cut) cut += 1;
    kept.push(screened.cut ? screened.text : message);
  }
  return { messages: kept, cut };
}

/** Pasted text with the value of every secret cut out, line by line; `cut` counts the lines. */
export function screenLines(text: string): { text: string; cut: number } {
  let cut = 0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const screened = cutSecrets(line);
    if (screened.cut) cut += 1;
    return screened.text;
  });
  return { text: lines.join("\n"), cut };
}

/** A conversation's title as it may be sent and shown: short, so one that holds a secret or a link is not shown at all. */
export function screenTitle(title: string): string {
  return holdsSecret(title) || holdsCodeOrLink(title) ? "Untitled" : title;
}

// ── aliases ───────────────────────────────────────────────────────────

/** How many aliases one fact may bring. */
export const ALIASES_MAX = 5;

/** Whether an alias may be kept: no word of it is a common word (each word
 * of a note's aliases is matched on its own), and it holds no secret, code
 * or link. */
export function usableAlias(alias: string): boolean {
  if (!alias.trim() || holdsSecret(alias) || holdsCodeOrLink(alias)) return false;
  return !alias.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => word.length >= 3 && isCommonWord(word));
}

// ── sensitive categories ──────────────────────────────────────────────

const NOT_SENSITIVE = new Set(["", "none", "null", "nil", "no", "na", "n/a", "false", "not sensitive", "nonsensitive", "non sensitive", "not applicable", "undefined", "-", "0"]);
/** The words a model uses for each category, as stems: a label matches when
 * one of its words starts with one. */
const LABEL_STEMS: Record<NamedSensitiveCategory, readonly string[]> = {
  health: ["health", "medic", "mental", "illness", "disease", "diagnos", "disab", "therap", "wellbeing", "wellness", "condition", "psych", "fitness", "reproduct", "pregnan"],
  money: ["money", "financ", "income", "salar", "debt", "bank", "tax", "wealth", "invest", "budget", "credit", "loan", "mortgage", "payment", "earning", "pay"],
  relationships: ["relation", "famil", "marriage", "marital", "dating", "partner", "roman", "sex", "orientation", "divorce", "love", "intima", "spouse", "gender"],
  politics: ["politic", "voting", "vote", "election", "party", "government", "activis"],
  religion: ["religio", "faith", "belief", "spiritual", "church", "worship"],
};
/** Words in the fact itself, for when the label says nothing: reproductive
 * and mental health, medication and diagnoses; pay, debt and bankruptcy;
 * sexuality and separations; parties and voting; religion. A fact that
 * merely names a relative, a job or a doctor is not sensitive. */
const TEXT_SIGNS: Record<NamedSensitiveCategory, RegExp> = {
  health: /\b(?:abortion|ivf|fertility|miscarr\w*|pregnan\w*|contracepti\w*|vasectomy|menopaus\w*|antidepressant\w*|depress\w*|anxiety|panic\s+attacks?|bipolar|ptsd|ocd|psychiatr\w*|therap(?:y|ist)|counsell?ing|self-harm|suicid\w*|eating\s+disorder|medication|medicine|prescri\w*|insulin|inhaler|chemo\w*|dialysis|painkillers?|\d+\s?mg|diagnos\w*|cancer|tumou?r|diabet\w*|asthma|hiv|epilep\w*|migraines?|disabilit\w*|surgery|chronic|adhd|autis\w*|dyslexi\w*|illness|rehab|addict\w*|allerg\w*|blood\s+pressure|mental\s+health)\b/i,
  money: /\b(?:salary|salaries|income|earns?|(?:is|was|gets?|got)\s+paid|pay\s+(?:rise|cut)|wages?|lakh|lpa|ctc|per\s+annum|take-home|debts?|owes?|loans?|mortgage|net\s+worth|bankrupt\w*|insolven\w*|savings|credit\s+score|in\s+arrears|foreclos\w*|overdraft)\b/i,
  relationships: /\b(?:divorc\w*|affair|girlfriend|boyfriend|sexual\w*|gay|lesbian|bisexual|queer|transgender|non-binary|came\s+out|coming\s+out|dating|separated|custody|breakup|broke\s+up|cheat(?:ed|ing)\s+on|estranged)\b/i,
  politics: /\b(?:votes?|voted|voting|democrat\w*|republican\w*|conservative|liberal|socialist|communist|political\w*|politics|party\s+member|member\s+of\s+(?:the\s+)?[\w\s]{0,30}party|supports?\s+(?:the\s+)?[\w\s]{0,30}party|campaign(?:s|ed|ing)?\s+for|protest(?:s|ed|ing)?|activis\w*|bjp|tory|tories|labour\s+party)\b/i,
  religion: /\b(?:religio\w*|muslim|islam|hindu\w*|christian\w*|catholic|protestant|jewish|judaism|buddhis\w*|sikh\w*|jain\w*|atheis\w*|agnostic|church|mosque|temple|synagogue|gurdwara|prays?|praying|convert(?:ed|s)?\s+to)\b/i,
};
/** Sensitive in a way none of the five names: trouble with the law, and immigration status. */
const OTHER_SIGNS = /\b(?:arrest\w*|convict\w*|prison|jail|probation|parole|criminal\s+record|charged\s+with|on\s+bail|lawsuit|sued|suing|court\s+case|restraining\s+order|dui|felony|misdemeanou?r|asylum|undocumented|deport\w*|refugee|immigration\s+status|overstay\w*|green\s+card|visa\s+(?:was\s+)?(?:denied|refused|rejected|revoked))\b/i;

function labelsOf(raw: unknown, depth = 0): string[] {
  if (raw === null || raw === undefined || raw === false) return [];
  if (typeof raw === "string") {
    const whole = raw.trim().toLowerCase();
    return NOT_SENSITIVE.has(whole) ? [] : whole.split(/[|,/;&+]|\band\b|\bor\b/).map((part) => part.trim());
  }
  if (Array.isArray(raw)) return depth > 2 ? ["?"] : raw.flatMap((item) => labelsOf(item, depth + 1));
  if (typeof raw === "object") {
    const values = Object.values(raw as Record<string, unknown>).filter((value) => typeof value === "string");
    return values.length && depth <= 2 ? values.flatMap((value) => labelsOf(value, depth + 1)) : ["?"];
  }
  // true, a number, anything else that is not an explicit "none"
  return [String(raw)];
}

/** The category a fact is filed under as sensitive, or null. The model's
 * label is read loosely (case, spacing, lists, separators, word forms and
 * synonyms); a label that is none of the five and not an explicit "none"
 * still counts, as "other". Whatever the label says, the fact's own words
 * are checked too: a model that answers "none" for everything does not
 * decide. A sensitive fact starts unticked. */
export function sensitiveCategory(label: unknown, text: string): SensitiveCategory | null {
  let other = false;
  for (const part of labelsOf(label)) {
    if (NOT_SENSITIVE.has(part)) continue;
    const words = part.split(/[^\p{L}]+/u).filter(Boolean);
    const named = SENSITIVE_CATEGORIES.find((category) => words.some((word) => LABEL_STEMS[category].some((stem) => word.startsWith(stem))));
    if (named) return named;
    other = true;
  }
  if (other) return "other";
  return SENSITIVE_CATEGORIES.find((category) => TEXT_SIGNS[category].test(text)) ?? (OTHER_SIGNS.test(text) ? "other" : null);
}
