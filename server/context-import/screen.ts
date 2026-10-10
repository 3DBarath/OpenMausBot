// The import's own screen: what never reaches the model, the batches file,
// About me or a shared note, and what starts unticked. An export is years of
// someone's chats, so it holds things bot memory never sees: a password said
// in passing, a card number, an identity or bank number, and text written to
// steer an assistant. The general scrub (shared/redact.ts) masks key shapes
// in logs and is left as it is for every other feature; this screen is
// stricter and belongs to the import alone. It drops, it never masks: a
// masked secret still says where the secret was.
//
//   holdsSecret        a credential, a payment number, an identity or bank number
//   readsAsInstruction an order to an assistant, or a command, code or a link
//   screenMessages     the person's messages with the ones holding a secret left out
//   usableAlias        an alias that is not a common word, a secret or a link
//   sensitiveCategory  the model's label and the fact's own words, as one of the categories
//
// Pure. Every rule errs towards leaving a fact out or unticked: the person
// reviews what is kept, and nobody reviews what a model was shown.
import { redactSecretsInText } from "../redact.ts";
import { cutMessage } from "./cuts.ts";
import { SENSITIVE_CATEGORIES, type NamedSensitiveCategory, type SensitiveCategory } from "../../shared/context-import.ts";

// ── secrets ───────────────────────────────────────────────────────────

/** A word that names a credential, then (after at most a few words) "is",
 * ":" or "=" and a value. "keeps passwords in a manager" has no value. */
const CREDENTIAL = /\b(?:pass(?:word|code|phrase|wd)s?|pwd|otp|secret\s+(?:key|code|answer|word)|recovery\s+(?:code|key|phrase)|seed\s+phrase|api[\s_-]?key|access\s+(?:code|key|token)|(?:auth(?:entication)?|verification|login|unlock|2fa|mfa)\s+code)\b(?:\s+(?!is\b|was\b|are\b)[\w'’.-]+){0,4}?\s*(?:\bis\b|\bwas\b|\bare\b|[:=]|->|→)\s*["'“‘]?([^\s"'”’,;]+)/gi;
/** What follows "the password is" without being one. */
const NOT_A_VALUE = new Set((
  "a an the in on at by to of for with from and or but not never always no yes also too very so that this these those it its their his her my our your one " +
  "stored saved kept managed held handled written remembered forgotten lost changed reset updated rotated shared protected generated required needed expired set done " +
  "unknown secret private sensitive important same different long short strong weak hard easy random unique complex simple new old safe unsafe " +
  "something anything nothing what where how why when which who whatever").split(" "));
/** A PIN is a short number: "PIN is 4821", "pin code: 123456", "PIN 0042". */
const PIN = /\bpin\b(?:\s*(?:code|number|no\.?))?\s*(?:\bis\b|\bwas\b|[:=#])?\s*\d{3,8}\b/i;
/** A card's security code: three or four digits near its name. */
const SECURITY_CODE = /\b(?:cvv2?|cvc2?|cid|csc|(?:card\s+)?security\s+code|card\s+code)\b\D{0,16}\d{3,4}\b/i;
/** Runs of 13 to 19 digits, grouped by spaces or dashes or not at all. */
const DIGIT_RUN = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

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

function holdsCardNumber(text: string): boolean {
  for (const match of text.matchAll(DIGIT_RUN)) {
    if (passesLuhn(match[0].replace(/[ -]/g, ""))) return true;
  }
  return false;
}

/** Identity numbers by their shape: a US social security number, an Indian
 * Aadhaar (three groups of four) and PAN, a UK National Insurance number. */
const ID_SHAPES: readonly RegExp[] = [
  /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/,
  /(?<!\d)(?<!\d[ -])[2-9]\d{3}[ -]\d{4}[ -]\d{4}(?![ -]?\d)/,
  /\b[A-Z]{5}\d{4}[A-Z]\b/,
  /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/,
];
/** …and by their name: the document, then a value with digits in it. */
const NAMED_ID = /\b(?:passport|driv(?:er|ing)['’]?s?\s+licen[cs]e|licen[cs]e|national\s+(?:id(?:entity)?|insurance)|identity\s+card|id\s+(?:card|number)|tax\s+(?:id|number)|taxpayer|social\s+(?:security|insurance)|ssn|itin|ein|nino|aadhaa?r|voter\s+id)\b[^.\n]{0,28}?(?:\bnumber\b|\bno\b\.?|#|\bis\b|:)?\s*[:#]?\s*(?<![A-Z0-9-])((?=[A-Z0-9-]*\d[A-Z0-9-]*\d[A-Z0-9-]*\d[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,19})(?![A-Z0-9-])/i;
/** Bank details: an account, routing or sort-code number by name, an Indian
 * IFSC code by shape, and an IBAN that passes its own check. */
const NAMED_BANK = /\b(?:(?:bank\s+)?account|acct|a\/c|routing|aba|sort\s*code|swift|bic|ifsc|iban)\b[^.\n]{0,16}?(?:\bnumber\b|\bno\b\.?|\bcode\b|#|\bis\b|:)?\s*[:#]?\s*(?:\bis\b\s*)?(\d[\d -]{4,24}\d)/i;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g;

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

function holdsCredential(text: string): boolean {
  for (const match of text.matchAll(CREDENTIAL)) {
    const value = (match[1] ?? "").replace(/[.!?)\]]+$/, "");
    if (value && !NOT_A_VALUE.has(value.toLowerCase())) return true;
  }
  return PIN.test(text) || SECURITY_CODE.test(text);
}

function holdsIdentityNumber(text: string): boolean {
  if (ID_SHAPES.some((shape) => shape.test(text))) return true;
  return NAMED_ID.test(text);
}

function holdsBankNumber(text: string): boolean {
  const named = NAMED_BANK.exec(text);
  if (named && named[1]!.replace(/\D/g, "").length >= 6) return true;
  if (IFSC.test(text)) return true;
  for (const match of text.matchAll(IBAN)) if (validIban(match[0])) return true;
  return false;
}

/** Whether a piece of text holds something that must not be kept or sent: a
 * key the general scrub would mask, a password, passcode or PIN said in
 * words, a payment card number, a card's security code, or a common
 * identity or bank number. */
export function holdsSecret(text: string): boolean {
  if (!text) return false;
  return redactSecretsInText(text) !== text || holdsCredential(text) || holdsCardNumber(text) || holdsIdentityNumber(text) || holdsBankNumber(text);
}

// ── instructions, commands, code and links ────────────────────────────

/** A web address: with a scheme, with www, with a path, or a bare name on a
 * common ending. An email address is not one. */
const LINK = /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S|\bwww\.[a-z0-9-]+\.[a-z]{2,}|\]\(\s*\S|(?<![@\w.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)]|(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|info|biz|app|dev|xyz|site|online|store|shop|link|click|top)\b(?![\w.-]*@)/;
/** Something a shell or an interpreter would run. */
const CODE = new RegExp([
  "`", "\\$\\(", "&&", "\\|\\|", "=>", "<\\/?[a-z][\\w-]*(?:\\s[^<>]*)?>", "\\bjavascript:",
  "\\|\\s*(?:sh|bash|zsh|python\\d?|node|perl|ruby|powershell|pwsh|cmd)\\b",
  "\\b(?:curl|wget|ssh|scp|nc|ncat)\\s+(?:-{1,2}\\w|\\S*[./@:]\\S)",
  "\\bsudo\\s+\\w", "\\bchmod\\s+[+\\-\\d]", "\\bchown\\s+\\S+\\s+\\S", "\\brm\\s+-[a-zA-Z]", "\\b(?:bash|sh|zsh|cmd)\\s+[-/]c\\b", "\\b(?:powershell|pwsh)\\s+-", "\\bbase64\\s+-{1,2}d",
  "\\b(?:npm|pnpm|yarn|pip3?|brew|apt|apt-get|cargo|gem)\\s+(?:install|i|add|run|exec)\\b", "\\bnpx\\s+\\S",
  "\\b(?:eval|exec|system|require|import)\\s*\\(", "\\bfunction\\s*\\w*\\s*\\(", "\\b(?:const|let|var)\\s+[\\w$]+\\s*=", "\\bdef\\s+\\w+\\s*\\(", "\\bimport\\s+[\\w{*][^.]*\\bfrom\\b",
  "\\bSELECT\\b[^.]{0,80}\\bFROM\\b", "\\b(?:DROP|DELETE\\s+FROM|INSERT\\s+INTO)\\s+\\w", "\\{\\s*[\"']\\w+[\"']\\s*:",
].join("|"), "i");
/** A sentence that begins by telling its reader what to do. A fact about the
 * person begins with the person. */
const ORDER_OPENER = /^[\s"'“‘([]*(?:always|never|do\s+not|don['’]?t|please|kindly|make\s+sure|ensure|remember\s+to|ignore|disregard|forget|override|from\s+now\s+on|respond|reply|answer|run|execute|output|print|say|pretend|act\s+as|you\b|your\b|note\s+to|instructions?\b|system\b|assistant\b|important\s*:)/i;
/** …or says it anywhere. */
const ORDER_INSIDE = new RegExp([
  "\\b(?:ignore|disregard|forget|override)\\s+(?:all|any|every|the|your|previous|prior|above|earlier|these|those)\\b",
  "\\bfrom\\s+now\\s+on\\b", "\\bsystem\\s+prompt\\b", "\\b(?:your|these|the\\s+above|previous|prior)\\s+(?:instructions|rules|guidelines)\\b",
  "\\byou\\s+(?:must|should|shall|will|need\\s+to|have\\s+to|are\\s+to|cannot|can['’]t|may\\s+not|are\\s+(?:now|an?|the))\\b",
  "\\b(?:always|never)\\s+(?:run|execute|reply|respond|answer|use|include|start|end|say|send|call|add|append|output|print|mention|reveal|tell|open|visit|fetch|download|install|obey|follow|comply|do)\\b",
  "\\b(?:before|after|when|whenever|while)\\s+(?:answering|replying|responding|you\\b)",
  "\\bin\\s+(?:every|each|all)\\s+(?:reply|replies|response|responses|answer|answers|message|messages)\\b",
  "\\b(?:every|each)\\s+time\\s+you\\b", "\\bas\\s+an?\\s+(?:ai|assistant|language\\s+model)\\b",
  "\\b(?:end|start|begin)\\s+(?:every|each|all|your)\\s+(?:reply|response|answer|message)",
].join("|"), "i");

/** Whether text holds a command, code or a link. */
export function holdsCodeOrLink(text: string): boolean {
  return LINK.test(text) || CODE.test(text);
}

/** Whether a proposed fact is shaped like an instruction to an assistant, or
 * carries a command, code or a link. Such text is never a fact about the
 * person, and recalled later it would sit in front of a bot as its own notes. */
export function readsAsInstruction(text: string): boolean {
  return holdsCodeOrLink(text) || ORDER_OPENER.test(text) || ORDER_INSIDE.test(text);
}

// ── the person's own messages ─────────────────────────────────────────

/** The person's messages with every one that holds a secret left out, as it
 * would be sent (cut, code blocks dropped). The scan and the read both use
 * this, so the estimate is the work that is done. */
export function screenMessages(messages: readonly string[]): { messages: string[]; dropped: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const message of messages) {
    const line = cutMessage(message);
    if (!line) continue;
    if (holdsSecret(line)) dropped += 1;
    else kept.push(message);
  }
  return { messages: kept, dropped };
}

/** Pasted text with every line that holds a secret left out. */
export function screenLines(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const kept = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => {
    if (!holdsSecret(line)) return true;
    dropped += 1;
    return false;
  });
  return { text: kept.join("\n"), dropped };
}

/** A conversation's title as it may be sent and shown. */
export function screenTitle(title: string): string {
  return holdsSecret(title) || holdsCodeOrLink(title) ? "Untitled" : title;
}

// ── aliases ───────────────────────────────────────────────────────────

/** Words that turn up in questions about anything. A note that answers to
 * one of them is recalled for unrelated messages. */
const COMMON_WORDS = new Set((
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use " +
  "that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were " +
  "what about after again also another always anything around because before being best better between both could does doing done each even every everything " +
  "first found give goes going great help into keep last least less life little look made mean might more most must need never next nothing number often other " +
  "people person place please point question questions answer answers really right same should show since small something sometimes still stuff tell thank thanks their then there these " +
  "thing things think those through today tomorrow yesterday tonight under until used user using want wants week where which while whole would year years " +
  "able above across actually almost already although anyone anywhere away back became become below called came cannot certain change " +
  "different during either else enough ever everyone example few find got however idea important information info inside instead kind know later let lot " +
  "may maybe mine myself name near none now off once others own part per perhaps quite rather said seem several short side simply someone soon sure " +
  "than thought together took top toward try turn upon various via way ways went whether within without work works yes yet general misc notes note fact facts details " +
  "assistant chat chats conversation conversations message messages reply replies response remember recall ask asked asking").split(/\s+/));

/** How many aliases one fact may bring. */
export const ALIASES_MAX = 5;

/** Whether an alias may be kept: no word of it is a common word (each word
 * of a note's aliases is matched on its own), and it holds no secret, code
 * or link. */
export function usableAlias(alias: string): boolean {
  if (!alias.trim() || holdsSecret(alias) || holdsCodeOrLink(alias)) return false;
  return !alias.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((word) => word.length >= 3 && COMMON_WORDS.has(word));
}

// ── sensitive categories ──────────────────────────────────────────────

const NOT_SENSITIVE = new Set(["", "none", "null", "nil", "no", "na", "n/a", "false", "not sensitive", "nonsensitive", "non sensitive", "not applicable", "undefined", "-", "0"]);
/** The words a model uses for each category, as stems: a label matches when
 * one of its words starts with one. */
const LABEL_STEMS: Record<NamedSensitiveCategory, readonly string[]> = {
  health: ["health", "medic", "mental", "illness", "disease", "diagnos", "disab", "therap", "wellbeing", "wellness", "condition", "psych", "fitness"],
  money: ["money", "financ", "income", "salar", "debt", "bank", "tax", "wealth", "invest", "budget", "credit", "loan", "mortgage", "payment", "earning", "pay"],
  relationships: ["relation", "famil", "marriage", "marital", "dating", "partner", "roman", "sex", "orientation", "divorce", "love", "intima", "spouse"],
  politics: ["politic", "voting", "vote", "election", "party", "government", "activis"],
  religion: ["religio", "faith", "belief", "spiritual", "church", "worship"],
};
/** A few words in the fact itself, for when the label says nothing. Narrow on
 * purpose: a fact that merely names a relative or a job is not sensitive. */
const TEXT_SIGNS: Record<NamedSensitiveCategory, RegExp> = {
  health: /\b(?:diagnos\w*|medication|medicine|prescri\w*|therap(?:y|ist)|depress\w*|anxiety|cancer|diabet\w*|asthma|pregnan\w*|hiv|disabilit\w*|surgery|chronic|adhd|autis\w*|bipolar|mental\s+health|illness|rehab|addict\w*)\b/i,
  money: /\b(?:salary|income|earns?|debts?|loans?|mortgage|net\s+worth|bankrupt\w*|savings|owes?|credit\s+score)\b/i,
  relationships: /\b(?:divorc\w*|affair|girlfriend|boyfriend|sexual\w*|gay|lesbian|bisexual|transgender|dating|separated|custody|breakup|broke\s+up)\b/i,
  politics: /\b(?:votes?|voted|voting|democrat\w*|republican\w*|conservative|liberal|socialist|political\w*|politics|party\s+member)\b/i,
  religion: /\b(?:religio\w*|muslim|hindu|christian|catholic|protestant|jewish|buddhist|sikh|jain|atheist|agnostic|church|mosque|temple|synagogue|prays?|praying)\b/i,
};

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
 * still counts, as "other"; and when the label says nothing the fact's own
 * words are checked. A sensitive fact starts unticked. */
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
  return SENSITIVE_CATEGORIES.find((category) => TEXT_SIGNS[category].test(text)) ?? null;
}
