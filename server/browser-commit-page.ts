// The server's own look at a bot's page, before a click or a key press that
// might send something or spend money (browser-commit-gate.ts).
//
// The bot never sees these reads and cannot shape them: the scripts below
// are fixed, and their only input is a box the engine itself measured for
// the bot's selector, so the element described is the one the engine would
// act on. Checked against agent-browser 0.37.0: `get box` answers with the
// same numbers as getBoundingClientRect for refs, CSS and xpath= selectors,
// and does not scroll.
//
// There are two reads. The first says what the call would act on: enough to
// judge it, from the target and its own form or region, at a cost that does
// not grow with what else is on the page. Only a call that is judged a
// commitment gets the second, which reads the evidence for its card and
// everything its approval is bound to.
import { randomBytes } from "node:crypto";

import type { agentBrowserQuery } from "./browser-engine.ts";
import type { CommitField } from "../shared/browser-commit.ts";

/** What the page says a click or a key press would act on: the first read. */
export interface PageTarget {
  label: string;
  role: string;
  box: "multiline" | "search" | "single" | null;
  submits: boolean;
  search: boolean;
  /** The target is in a card region: its form, or with no form the region
   * of the page around it, holds a card field, a payment frame or a card
   * number. */
  card: boolean;
  multiline: boolean;
  /** A control that a click, Enter or Space activates: a button, a link,
   * something with a button's role, or a plain element styled as one. */
  button: boolean;
  /** A list or a tick box with a handler of its own, or its form's, that
   * runs when it changes. */
  changes: boolean;
  /** For text typed at a selector: the element is itself a text field that
   * has the focus, so the keys go to it and nowhere else. */
  typable: boolean;
  /** For text typed at a selector: the element is itself a text field,
   * with the focus or not. */
  field: boolean;
  /** That field can take the focus, as far as the read can tell: it is not
   * in a disabled group, under an inert parent, hidden, or outside a modal
   * dialog that is open. */
  reach: boolean;
  /** A plain link: an anchor whose address goes somewhere (another
   * document, a place on this page that exists, a "#/" route), with no
   * button role and no click handler written on it. */
  link: boolean;
  /** Its form, or the region around it when it has no form, is a sign-in:
   * a password field and no multi-line field. */
  signin: boolean;
  /** Its form or region holds a file to attach or a multi-line field. */
  carries: boolean;
  /** Only for Enter in a multi-line field: what could make it a message
   * composer. Its keyboard hint is "send"; it is the only text field in its
   * form or region; its own label and placeholder; the labels of the
   * button-like controls there, the nearest first. */
  hint?: boolean;
  only?: boolean;
  says?: string;
  near?: string[];
  /** The language the page declares for the element (the nearest `lang`
   * around it), "" when it declares none. */
  lang: string;
  /** The page has a frame. The engine measures an element inside a frame
   * from the frame's own corner, so on such a page the element found by a
   * ref's box may be another one outside the frame. */
  frames: boolean;
  /** The page has a frame the read cannot look into that is a payment
   * frame: one that calls itself a card, payment or checkout frame, or a
   * wallet or pay-later brand's own. */
  payFrame: boolean;
  /** The measured box could be inside such a frame: it starts within the
   * frame's own width and height, where the engine measures from. */
  inPay: boolean;
  /** Other elements in the same box, when nothing says which of them the
   * engine would act on. Any of them may be the one. */
  also?: PageTarget[];
}

/** The evidence for one target: the second read. */
export interface PageEvidence {
  /** The form or region holds a component whose inside cannot be read (a
   * closed shadow root): what is in it is not on the card, and not part of
   * the approval. */
  opaque: boolean;
  /** The fields a card lists: the visible ones of the target's own form, or
   * with no form of the region around it. A value the card must not carry
   * is here by its length only. Each other value is whole. */
  fields: CommitField[];
  /** Filled fields the approval is bound to but the card does not list:
   * the rest of the page, when no form or region says what goes. */
  others: number;
  /** A hash, made in the page, of every control of the form or region and
   * its state: hidden and not displayed ones, tick boxes, lists, and the
   * editable body of a frame the page can read. Nothing in it is readable. */
  bound: string;
  /** Which element this is: where it sits in the document and a hash of
   * what it is (its tag and the attributes that say what it does, never
   * its style). For Enter, the focused field and the button it would press. */
  identity: string;
  /** The visible text of the row, list item, card or dialog it is in.
   * Empty when that text holds something the card must not carry. */
  context: string;
  /** A hash of that text with relative times and clocks evened out, so a
   * ticking "3s ago" is not a change. */
  around: string;
}

/** The second read: one piece of evidence per target, in the first read's order. */
export interface PageDetail {
  parts: PageEvidence[];
  /** The page shows something the card masks (a password, a card field, a
   * code, such a thing said in the text around the button), anywhere on
   * it. A picture of the page would show it. */
  secrets: boolean;
}

/** What a read can come back with instead of a description.
 * - "missing": the engine itself finds no such element, and will say so.
 * - "hidden": the engine found the element but this read cannot describe
 *   it: it is inside a frame of another site, or it has no area (the engine
 *   then clicks its corner, and whatever overflows it takes the click).
 * - "hidden-pay": the same, on a page with a payment or card frame the read
 *   cannot look into, which is where such an element most likely is.
 * - "framed": the call would act inside a frame this read cannot look
 *   into. The focus is in a frame from another site, or the selector is a
 *   frame itself (a click on it lands on something inside; typed keys go to
 *   whatever is focused inside).
 * - "sealed": the focus is inside a closed part of the page (a closed
 *   shadow root), which no script can read.
 * - "unusable": the selector is one this read will not hand to the engine
 *   (empty, shaped like a command-line flag, or over 2,000 characters).
 * - "unreadable": the engine or the page did not answer. Nothing is known.
 * Only "missing" says there is nothing to act on. */
export type PageBlind = "missing" | "hidden" | "hidden-pay" | "framed" | "sealed" | "unusable" | "unreadable";

export interface BrowserPageReader {
  /** The page's address as the engine reports it, or null when it will not say. */
  url(): Promise<string | null>;
  /** What `selector` resolves to, or the focused element when it is null.
   * `enter` asks what Enter would do there; without it, what a click (or,
   * at the focus, Space) would. */
  target(selector: string | null, enter: boolean): Promise<PageTarget | PageBlind>;
  /** The evidence for that same target. Only asked for a commitment. */
  evidence(selector: string | null, enter: boolean): Promise<PageDetail | PageBlind>;
  /** The `href` attribute of the selector's own element, as the engine
   * resolves it: its own word for where a ref's link goes, inside a frame
   * too. Null when it has none, or the engine would not say. */
  href(selector: string): Promise<string | null>;
}

interface Box { x: number; y: number; width: number; height: number }

/** Both scripts open with this. Runs in the page. No template holes: its one argument is JSON. */
const PRELUDE = String.raw`
    // Named access shadows a form's own properties: a control named "tagName"
    // makes form.tagName that control, and document has the same trap. Every
    // read of an element that could be a form, and of a document, goes
    // through the accessor on its prototype chain, which a name cannot reach.
    // Inputs, buttons, selects, text areas and labels have no named access,
    // so their own properties (type, value, checked, labels) are read plainly.
    const lookup = (proto, name) => { for (let at = proto; at; at = Object.getPrototypeOf(at)) { const found = Object.getOwnPropertyDescriptor(at, name); if (found) return found; } return null; };
    const reader = (name) => { const known = new Map(); return (node) => { const proto = Object.getPrototypeOf(node); if (!known.has(proto)) known.set(proto, lookup(proto, name)); return known.get(proto); }; };
    const access = (name, calls) => { const find = reader(name); return (node, ...args) => { try { const found = find(node); return !found ? undefined : calls ? found.value.apply(node, args) : found.get ? found.get.call(node) : found.value; } catch (error) { return undefined; } }; };
    const prop = (name) => access(name, false), method = (name) => access(name, true);
    const tag = prop("tagName"), parentOf = prop("parentElement"), shadowOf = prop("shadowRoot"), kindOf = prop("nodeType"), hostOf = prop("host");
    const textOf = prop("textContent"), editableOf = prop("isContentEditable"), ownerOf = prop("form"), focusOf = prop("activeElement"), rootOf = method("getRootNode");
    const getAttr = method("getAttribute"), hasAttr = method("hasAttribute"), matches = method("matches"), byId = method("getElementById"), pointIn = method("elementFromPoint");
    const queryIn = method("querySelector"), queryAllIn = method("querySelectorAll"), rectOf = method("getBoundingClientRect"), visible = method("checkVisibility");
    const innerTextOf = prop("innerText"), beforeOf = prop("previousElementSibling"), pageOf = prop("ownerDocument"), bodyOf = prop("body");
    // The text in an element as it is written there.
    const plain = (el) => { const seen = innerTextOf(el); return String(seen == null ? textOf(el) : seen); };
    const ownPage = prop("contentDocument"), svgPage = method("getSVGDocument");
    // A frame is whatever holds another document: an object and an embed do too.
    const FRAMES = "iframe, frame, object, embed";
    const isFrame = (el) => ["IFRAME", "FRAME", "OBJECT", "EMBED"].includes(tag(el));
    const frameDoc = (el) => ownPage(el) || svgPage(el) || null;
    const FORM_OWNED = ["INPUT", "BUTTON", "SELECT", "TEXTAREA"];
    const atTop = (el) => tag(el) === "BODY" || tag(el) === "HTML";
    const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const clip = (value, max) => (value.length > max ? value.slice(0, max) : value);
    const attr = (el, name) => getAttr(el, name) || "";
    // A shadow root's host is its way up; a document has none, whatever it has an element named.
    const up = (node) => { const parent = parentOf(node); if (parent) return parent; const root = rootOf(node); return (root && kindOf(root) === 11 && hostOf(root)) || null; };
    const climb = (node, test) => { for (let n = node; n; n = up(n)) if (test(n)) return n; return null; };
    const editable = (el) => editableOf(el) === true && climb(el, (n) => hasAttr(n, "contenteditable")) === el;
    const inputType = (el) => (tag(el) === "INPUT" ? String(el.type || attr(el, "type") || "text").toLowerCase() : "");
    const ONE_LINE = ["text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "week", "time"];
    const boxKind = (el) => {
      if (inputType(el) === "search" || attr(el, "role") === "searchbox") return "search";
      if (tag(el) === "TEXTAREA" || editable(el)) return "multiline";
      if (ONE_LINE.includes(inputType(el))) return "single";
      if (attr(el, "role") === "textbox") return attr(el, "aria-multiline") === "true" ? "multiline" : "single";
      return null;
    };
    // What a label says, without what any control inside it holds: the text
    // of a text area is its value, a list's is its choices, and neither is
    // part of what the field is called.
    const kidsOf = prop("childNodes"), dataOf = prop("nodeValue");
    const wordsIn = (node) => {
      let out = "";
      for (const kid of Array.from(kidsOf(node) || [])) {
        if (kindOf(kid) === 3) out += dataOf(kid) || "";
        else if (kindOf(kid) === 1 && !FORM_OWNED.includes(tag(kid)) && !hasAttr(kid, "contenteditable")) out += " " + wordsIn(kid) + " ";
      }
      return out;
    };
    const nameOf = (el) => {
      const named = text(attr(el, "aria-label"));
      if (named) return named;
      const root = rootOf(el);
      const by = text(text(attr(el, "aria-labelledby")).split(" ").map((id) => { const node = id && root ? byId(root, id) : null; return node ? wordsIn(node) : ""; }).join(" "));
      if (by) return by;
      if (["submit", "button", "reset"].includes(inputType(el))) return text(el.value);
      const labels = FORM_OWNED.includes(tag(el)) ? el.labels : null;
      if (labels && labels.length && text(wordsIn(labels[0]))) return text(wordsIn(labels[0]));
      if (boxKind(el)) return text(attr(el, "placeholder")) || text(attr(el, "name")) || text(attr(el, "title"));
      if (text(textOf(el))) return text(textOf(el));
      const image = queryIn(el, "img[alt], svg[aria-label]");
      return text(image ? attr(image, "alt") || attr(image, "aria-label") : "") || text(attr(el, "title")) || text(attr(el, "alt"));
    };
    const labelOf = (el) => clip(nameOf(el), 120);
    const CONTROL = 'button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], [role=checkbox], [role=radio], [role=switch], [role=textbox], [role=searchbox], [contenteditable]';
    const controlOf = (node) => {
      const control = climb(node, (n) => matches(n, CONTROL));
      if (control) return control;
      const label = climb(node, (n) => tag(n) === "LABEL");
      return label && label.control ? label.control : node;
    };
    // The form a control belongs to: its form owner, which the form
    // attribute can point anywhere, or the form it sits inside.
    const formOwner = (el) => { const form = FORM_OWNED.includes(tag(el)) ? ownerOf(el) : null; return form && tag(form) === "FORM" ? form : null; };
    const formOf = (node) => formOwner(node) || climb(node, (n) => tag(n) === "FORM");
    const queryAll = (root, selector) => Array.from(queryAllIn(root, selector) || []);
    // Every control the form owns, in document order. form.elements leaves
    // out <input type="image">, which is a submit button like any other.
    const formControls = (form) => queryAll(rootOf(form) || document, "input, button, select, textarea").filter((el) => formOwner(el) === form);
    const submitControl = (el) => (tag(el) === "BUTTON" || tag(el) === "INPUT") && (el.type === "submit" || el.type === "image");
    const submitter = (el) => submitControl(el) && !el.disabled;
    const shown = (el) => visible(el, { checkVisibilityCSS: true }) !== false;
    const all = (root, out) => {
      for (const el of queryAll(root, "*")) { out.push(el); const inner = shadowOf(el); if (inner) all(inner, out); }
      return out;
    };
    // Every match under a root, in the open shadow roots under it too: a
    // component keeps its fields in one, and a plain query does not go in.
    const deep = (root, selector) => {
      const out = queryAll(root, selector);
      for (const el of queryAll(root, "*")) { const inner = shadowOf(el); if (inner) for (const found of deep(inner, selector)) out.push(found); }
      return out;
    };
    // A form's fields: the controls it owns, and those in the shadow roots
    // of the components inside it, which no form owns.
    const fieldsOf = (form, owned, selector) => owned.concat(deep(form, selector).filter((el) => !owned.includes(el)));
    // The element that has the focus, through open shadow roots and frames
    // that can be read. Null when nothing has it, or it is where no read goes.
    const focused = () => {
      let el = focusOf(document);
      for (let depth = 0; depth < 9; depth += 1) {
        for (let inner = el && shadowOf(el); inner && focusOf(inner); inner = shadowOf(el)) el = focusOf(inner);
        if (!el || !isFrame(el)) return el || null;
        const inside = frameDoc(el);
        if (!inside) return null;
        el = focusOf(inside);
      }
      return null;
    };
    // Names are compared as words, without accents: "cardNumber",
    // "card_number" and "cardnumber" are one name, "Contraseña" is "contrasena".
    const words = (value) => String(value || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase();
    // Where a control with no form belongs: the nearest dialog or landmark
    // around it. Null when there is none, and the page itself is the region.
    const REGION = 'dialog, [role=dialog], [role=alertdialog], [aria-modal=true], [role=region], [role=form], [role=navigation], [role=banner], [role=contentinfo], [role=complementary], section, article, [role=article], main, [role=main], nav, header, footer, aside';
    const regionOf = (control) => climb(up(control), (n) => matches(n, REGION));
    // A handler written on the element or its form (the attribute, or the
    // function set as el.onchange). A listener added with addEventListener
    // cannot be read, and is not seen.
    const SUBMITS = /\b(?:submit|requestSubmit)\s*\(|\.\s*click\s*\(/;
    const handlerOf = { onchange: prop("onchange"), oninput: prop("oninput"), onclick: prop("onclick") };
    const handlers = (el, names) => names.map((name) => { const set = handlerOf[name](el); return attr(el, name) + " " + (typeof set === "function" ? Function.prototype.toString.call(set) : ""); }).join(" ");
    // A field called a card number, in the languages the lists know.
    const CARD_NUMBER = /\b(?:card|cc) ?(?:number|num|no|nr)\b|\bccn\b|\b(?:credit|debit) ?card\b|\bnumero de (?:la )?(?:tarjeta|carte)\b|\bnumero do cartao\b|\bkartennummer\b|\b(?:tarjeta|carte|cartao) de (?:credito|debito|credit)\b|\bkreditkarte\b/;
    // What a frame says of itself: its title, name, id and address.
    const frameWords = (el) => words(["title", "name", "id", "src", "data"].map((name) => attr(el, name)).join(" "));
    const luhn = (digits) => Array.from(digits).reverse().reduce((sum, digit, at) => sum + (at % 2 ? [0, 2, 4, 6, 8, 1, 3, 5, 7, 9][digit] : +digit), 0) % 10 === 0;
    // Thirteen to nineteen digits, in groups or not, that pass the Luhn check.
    const cardDigits = (value) => { const digits = value.length < 13 || value.length > 40 ? "" : value.replace(/[\s-]/g, ""); return /^\d{13,19}$/.test(digits) && luhn(digits) ? digits : ""; };

    // What the call would act on. { picks } for elements to describe, each
    // with the frames it is inside; { nothing } when nothing has the focus;
    // otherwise the answer to give as it is.
    const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, summary, audio[controls], video[controls], [contenteditable], [tabindex]';
    const resolve = () => {
      const picks = [];
      if (input.box) {
        // Every element with the box the engine measured, in the page and in
        // every frame of it that can be read: the engine measures an element
        // inside a frame from the frame's own corner. Two can share a box: a
        // control and its wrapper or only child, two stacked in a cell, or
        // one in the page and one in a frame.
        const pages = [{ page: document, within: [] }];
        for (let at = 0; at < pages.length; at += 1) {
          const page = pages[at].page, within = pages[at].within, same = [], box = input.box;
          for (const node of all(page, [])) {
            const rect = rectOf(node);
            if (rect && Math.abs(rect.x - box.x) + Math.abs(rect.y - box.y) + Math.abs(rect.width - box.width) + Math.abs(rect.height - box.height) <= 2) same.push(node);
            if (within.length < 3 && isFrame(node)) { const inside = frameDoc(node); if (inside) pages.push({ page: inside, within: within.concat(node) }); }
          }
          if (!same.length) continue;
          // Of a chain that shares the box, the deepest stands for all of it.
          let chosen = same.filter((candidate) => !same.some((other) => other !== candidate && climb(up(other), (n) => n === candidate)));
          if (!input.enter) {
            // A click lands on whatever is on top at the centre of the box.
            // When that is one of these, or inside one, it is the target.
            const x = box.x + box.width / 2, y = box.y + box.height / 2;
            let hit = pointIn(page, x, y);
            for (let inner = hit && shadowOf(hit); inner; inner = shadowOf(hit)) {
              const deeper = pointIn(inner, x, y);
              if (!deeper || deeper === hit) break;
              hit = deeper;
            }
            if (hit && climb(hit, (n) => same.includes(n))) chosen = [hit];
          }
          for (const el of chosen) picks.push({ el, within });
        }
        if (!picks.length) return { found: false };
        // The target is a frame itself: a click lands on something inside it,
        // and typed keys go to whatever has the focus inside it.
        if (picks.some((pick) => isFrame(pick.el))) return { found: false, framed: true };
      } else {
        let el = focusOf(document);
        const within = [];
        for (let depth = 0; ; depth += 1) {
          for (let inner = el && shadowOf(el); inner && focusOf(inner); inner = shadowOf(el)) el = focusOf(inner);
          if (!el || !isFrame(el)) break;
          // The focus is inside this frame. One of the page's own origin is
          // read like the page; another site's cannot be read at all.
          const inside = frameDoc(el);
          if (!inside || depth >= 8) return { found: false, framed: true };
          within.push(el);
          el = focusOf(inside);
        }
        if (!el || atTop(el)) return { nothing: true };
        // The focus is on an element that cannot take it by itself, or on a
        // custom element with no open root: it is inside a closed part of
        // the page, and what has it there cannot be read.
        if (!shadowOf(el) && ((String(tag(el)).includes("-") && !matches(el, CONTROL)) || !matches(el, FOCUSABLE))) return { found: false, framed: true, sealed: true };
        picks.push({ el, within });
      }
      return { picks };
    };
    // The control an element belongs to, its form, and what the call would
    // activate: for Enter in a form's field, the form's submit button.
    const basics = (el) => {
      const control = controlOf(el);
      const box = boxKind(control);
      const form = formOf(control);
      const owned = form ? formControls(form) : [];
      const type = inputType(control);
      const pressable = tag(control) === "BUTTON" || ["submit", "button", "image", "reset"].includes(type);
      const formControl = (tag(control) === "INPUT" && !pressable) || tag(control) === "SELECT";
      const toggles = tag(control) === "SELECT" || type === "checkbox" || type === "radio";
      let acting = control;
      let submits = false;
      // The form's default button: its first submit control, whatever its
      // state. A disabled one is judged like a live one: a page can enable
      // it between this read and the key press.
      const viaDefault = () => { const first = owned.find(submitControl); if (first) acting = first; return Boolean(first); };
      if (input.enter && form && box !== "multiline" && (formControl || box)) {
        // Enter on a form control (a one-line field, but also a checkbox, a
        // radio button, a select, a slider) submits the form through its
        // first submit button; with none, only from its one text field.
        submits = viaDefault() || (Boolean(box) && owned.filter((member) => boxKind(member) === "single" || boxKind(member) === "search").length === 1);
      } else if (!input.enter && form && toggles && SUBMITS.test(handlers(control, ["onchange", "oninput", "onclick"]) + " " + handlers(form, ["onchange", "oninput"]))) {
        // Changing this control submits its form by the page's own handler.
        viaDefault();
        submits = true;
      } else if (box === null) submits = Boolean(form) && submitter(control);
      return { control, box, form, owned, toggles, acting, submits };
    };
    // Each control once, in the order the picks came.
    const each = (picks, describe) => {
      const described = [];
      for (const pick of picks) {
        const one = describe(pick, basics(pick.el));
        if (!described.some((other) => other.control === one.control)) described.push(one);
      }
      return described;
    };
`;

/** The first read: what the call would act on, and nothing that costs with the size of the page. */
const LIGHT = String.raw`
    // The signs of a card form that carries no autofill hints: a field
    // called a card number (CARD_NUMBER), and another called a security code
    // or an expiry. One alone is not enough: a library card has a number, a
    // gift card a code.
    const CARD_COMPANION = /\bcv[cv]\d?\b|\bcvn\b|\bcsc\b|\bsecurity ?code\b|\bcard ?verification\b|\bverification ?value\b|\bexp(?:iry|iration|ires)?\b|\bexp ?(?:date|month|year|mm|yy)\b|\bvalid ?(?:thru|through|until)\b|\bmm ?yy(?:yy)?\b|\bcodigo de segur\w+\b|\bcryptogramme\b|\bprufziffer\b|\bsicherheitscode\b|\bcaducidad\b|\bvencimiento\b|\bdate d expiration\b|\bablaufdatum\b|\bgultig bis\b|\bvalidade\b/;
    // A frame from another site, by what it calls itself: its title, name,
    // id and label. One that speaks of a card, a payment or a checkout is a
    // card signal for the region around it. One that calls itself a wallet
    // or pay-later brand, and nothing of paying besides (alone, or with
    // words such as button, message, donate, express), is that brand's own
    // frame: a click inside it is money, and the page around it is an
    // ordinary page. A word in a frame's address decides nothing: adverts
    // and widgets are served from addresses with "pay" and "checkout" in
    // them. The address counts only where it is one of the few known to
    // serve a processor's card fields, or a brand's button.
    const CARD_WORDS = /\b(?:cards?|cc|cvc|cvv|cvn|csc|expir\w+|security ?code|hosted ?fields?|tarjetas?|cartes?|karten?|kartennummer|kreditkarte|cartao|cartoes)\b/;
    const PAY_WORDS = /\b(?:pay|paying|payments?|checkout|pagos?|paiements?|zahlung(?:en)?|pagamentos?)\b/;
    // (Names are compared as words, and "PayPal" is two of them.)
    const WALLETS = "pay ?pal|klarna|after ?pay|clear ?pay|affirm|sezzle|venmo|g ?pay|(?:shop|apple|google|amazon|samsung) ?pay|pay ?later|pay in \\d+";
    // The few addresses that count, each by the host a frame is served
    // from (a leading dot: that host and those under it) and, where given,
    // its path. A mention of one anywhere else in an address (a query, a
    // path on another host, a host that only starts the same) is nothing.
    const CARD_HOSTS = [
      ["js.stripe.com", /^\/v\d+\/elements-inner-(?:card|payment(?!-request)|cvc|expiry|number)/], ["assets.braintreegateway.com", /hosted-fields/], [".adyen.com", /securedfields/i],
      [".paypal.com", /^\/smart\/card-fields/], [".pci.shopifyinc.com", null], [".checkout.com", /frames/], ["api.recurly.com", /^\/js\/v\d+\/field/],
    ];
    const BRAND_HOSTS = [["pay.google.com", /^\/gp\/p\/ui\//], [".paypal.com", /^\/(?:smart\/buttons?|credit-presentment)/], ["js.stripe.com", /^\/v\d+\/elements-inner-(?:express-checkout|payment-request)/]];
    // Is the frame served from one of them? Its address is parsed as a
    // browser parses it; one that cannot be parsed matches nothing.
    const servedFrom = (frame, known) => {
      let at;
      try { const base = String(urlOf(pageOf(frame) || document) || ""), raw = attr(frame, "src") || attr(frame, "data"); at = base ? new URL(raw, base) : new URL(raw); } catch (error) { return false; }
      const host = String(at.hostname).toLowerCase();
      return /^https?:$/.test(at.protocol) && known.some((entry) => (entry[0][0] === "." ? host.endsWith(entry[0]) || host === entry[0].slice(1) : host === entry[0]) && (!entry[1] || entry[1].test(at.pathname)));
    };
    const selfWords = (el) => words(["title", "name", "id", "aria-label"].map((name) => attr(el, name)).join(" "));
    // Is the frame a card signal for what is around it?
    const signals = (frame) => {
      if (servedFrom(frame, CARD_HOSTS)) return true;
      if (servedFrom(frame, BRAND_HOSTS)) return false;
      // What it calls itself, the brand names aside.
      const rest = selfWords(frame).replace(new RegExp("\\b(?:" + WALLETS + ")\\b", "g"), " ");
      return CARD_WORDS.test(rest) || PAY_WORDS.test(rest);
    };
    // Is it a payment frame at all: a card signal, or a brand's own frame? A click inside either is money.
    const pays = (frame) => signals(frame) || servedFrom(frame, BRAND_HOSTS) || new RegExp("\\b(?:" + WALLETS + ")\\b").test(selfWords(frame));
    // The numbers card schemes issue, by their first digits and length. A
    // number that only passes the checksum may be anything: an IMEI does.
    const BRAND = /^(?:4\d{12}(?:\d{3}){0,2}|(?:5[1-5]\d\d|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)\d{12}|3[47]\d{13}|(?:6011|65\d\d|64[4-9]\d|62\d\d)\d{12,15}|35(?:2[89]|[3-8]\d)\d{12,15}|3(?:0[0-5]|[689]\d)\d{11,16}|(?:5[06-9]|6\d)\d{10,17}|(?:8[12]\d\d|508\d)\d{12}|220[0-4]\d{12,15})$/;
    // The frames of another site under a root whose own words pass a test.
    const framesIn = (root, test) => deep(root, FRAMES).filter((frame) => shown(frame) && !frameDoc(frame) && test(frame));
    // Does this set of controls and frames hold a card signal? 2 for one
    // that stands by itself: an autofill hint; a card-number field beside a
    // security-code or expiry field, by name; a frame from another site that
    // calls itself a card, payment or checkout frame.
    // 1 when all there is is a card number typed in: a number that passes
    // the checksum with a scheme's first digits, or beside one of those
    // names. (What is typed in a search form is never taken for one, so the
    // caller drops a 1 there.) Kept cheap: attributes first, a label only
    // when they say nothing, a visibility check only for a field that counts.
    const cardSigns = (controls, root, page, depth) => {
      let hint = false, checksum = false, branded = false, labels = null;
      const numbers = [], companions = [];
      for (const el of controls) {
        const kind = tag(el);
        if (kind !== "INPUT" && kind !== "SELECT") continue;
        if (/(^|\s)cc-/.test(attr(el, "autocomplete").toLowerCase())) hint = true;
        if (inputType(el) === "hidden") continue;
        let named = words(attr(el, "name") + " | " + attr(el, "id") + " | " + attr(el, "placeholder") + " | " + attr(el, "aria-label"));
        if (!CARD_NUMBER.test(named) && !CARD_COMPANION.test(named)) {
          if (!labels) { labels = new Map(); for (const label of deep(page, "label")) { const control = label.control; if (control) labels.set(control, (labels.get(control) || "") + " " + wordsIn(label)); } }
          named = words(labels.get(el));
        }
        const number = CARD_NUMBER.test(named), companion = CARD_COMPANION.test(named);
        const digits = kind === "INPUT" && boxKind(el) !== "search" ? cardDigits(String(el.value == null ? "" : el.value)) : "";
        if ((!number && !companion && !digits) || !shown(el)) continue;
        if (number) numbers.push(el);
        if (companion) companions.push(el);
        if (digits) { checksum = true; if (BRAND.test(digits)) branded = true; }
      }
      // The two signs must be on two fields: one field called "Card number or CVC" is one sign.
      if (hint || numbers.some((number) => companions.some((companion) => companion !== number))) return 2;
      if (framesIn(root, signals).length) return 2;
      // A frame the page can read is a card frame when what is in it is.
      let inner = 0;
      if (depth < 2) for (const frame of deep(root, FRAMES)) { const inside = shown(frame) && frameDoc(frame); if (inside) inner = Math.max(inner, cardSigns(deep(inside, "input, select"), inside, inside, depth + 1)); }
      return Math.max(inner, branded || (checksum && (numbers.length > 0 || companions.length > 0)) ? 1 : 0);
    };
    const roleOf = (el) => {
      const explicit = text(attr(el, "role")).toLowerCase();
      if (explicit) return explicit;
      if (tag(el) === "BUTTON" || tag(el) === "SUMMARY") return "button";
      if (tag(el) === "A" && hasAttr(el, "href")) return "link";
      if (tag(el) === "SELECT") return "combobox";
      if (tag(el) === "INPUT") {
        const type = inputType(el);
        if (["submit", "button", "image", "reset"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        return type === "search" ? "searchbox" : "textbox";
      }
      return tag(el) === "TEXTAREA" || editable(el) ? "textbox" : "generic";
    };
    const regions = new Map();
    const hrefOf = prop("href"), urlOf = prop("URL");
    const TEXTS = 'input, textarea, [contenteditable], [role=textbox], [role=searchbox]';
    const APART = '[role=search], search, header, nav, footer, aside, [role=banner], [role=navigation], [role=contentinfo], [role=complementary]';
    const PRESSED = 'button, [role=button], input[type=submit], input[type=button], input[type=image], a[href], [role=link], [role=menuitem]';
    // A control that a click, Enter or Space activates.
    const buttonLike = (el) => {
      const role = text(attr(el, "role")).toLowerCase();
      if (role) return ["button", "link", "menuitem"].includes(role);
      if (tag(el) === "BUTTON" || tag(el) === "SUMMARY" || (tag(el) === "A" && hasAttr(el, "href")) || ["submit", "button", "image", "reset"].includes(inputType(el))) return true;
      if (FORM_OWNED.includes(tag(el)) || editable(el)) return false;
      // A plain element made to look like a button by the pointer it shows.
      try { const view = prop("defaultView")(pageOf(el)); return view.getComputedStyle(el).cursor === "pointer"; } catch (error) { return false; }
    };
    const judge = (pick, known) => {
      const { control, box, form, owned, toggles, acting, submits } = known;
      // The fields that decide what the control is: its form's, or the box itself when it is one.
      const own = form ? fieldsOf(form, owned, "input, select, textarea, [contenteditable]").filter((field) => !hasAttr(field, "contenteditable") || editable(field)) : box ? [control] : [];
      let multiline = false, boxes = 0, searches = 0;
      for (const field of own) {
        const kind = boxKind(field);
        if (!kind || !shown(field)) continue;
        boxes += 1;
        if (kind === "search") searches += 1;
        if (kind === "multiline") multiline = true;
      }
      // The card region: the control's form, or with no form the nearest
      // region around it, or the page when there is none.
      const page = pageOf(control) || document;
      const region = form ? null : regionOf(control);
      const scope = form || region || page;
      if (!regions.has(scope)) regions.set(scope, cardSigns(form ? fieldsOf(form, owned, "input, select") : deep(scope, "input, select"), scope, page, 0));
      const search = box === "search" || Boolean(climb(control, (n) => matches(n, "[role=search], search"))) || (boxes === 1 && searches === 1);
      // What is typed in a search form is never a card number, so there only a sign that stands by itself counts.
      const card = regions.get(scope) > (search ? 1 : 0);
      const changes = toggles && Boolean(text(handlers(control, ["onchange", "oninput"]) + (form ? handlers(form, ["onchange", "oninput"]) : "")));
      // Text typed at a selector lands on its element only when that element
      // already has the focus: the engine cannot always give it the focus
      // (a modal in front, a disabled fieldset, an inert or hidden parent),
      // and then its Enter goes to whatever has it.
      const field = Boolean(input.enter && input.box && pick.el === control && box && !control.disabled);
      const typable = field && holder === control;
      // Can the field take the focus, as far as a read can tell? Not in a
      // disabled group, under an inert parent, hidden, or outside a modal
      // dialog that is open. The engine types at whatever has the focus
      // when its field cannot take it (measured: into the field that had it).
      const modal = field ? queryAll(page, "dialog[open]").find((dialog) => matches(dialog, ":modal") === true) : null;
      const reach = field && shown(control) && matches(control, ":disabled") !== true
        && !climb(control, (n) => hasAttr(n, "inert") || (tag(n) === "FIELDSET" && hasAttr(n, "disabled")))
        && (!modal || Boolean(climb(control, (n) => n === modal)));
      // A plain link: an anchor whose address goes somewhere, with no role
      // that makes it a button and no click handler written on it. Somewhere
      // is another document, a place on this page that exists (an element
      // with that id, or an anchor with that name), or a "#/" or "#!" route.
      // A bare "#", an address to no place, and "javascript:" go nowhere:
      // such a link is a button.
      // The address is read the way a browser reads it: tabs and line breaks
      // dropped wherever they are, control characters and spaces at its ends.
      const href = attr(control, "href").replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
      const there = String(hrefOf(control) || ""), here = String(urlOf(page) || "").split("#")[0];
      const cut = there.indexOf("#");
      let place = cut < 0 || there.slice(0, cut) !== here ? null : there.slice(cut + 1);
      if (place) try { place = decodeURIComponent(place); } catch (error) { /* as it is written */ }
      const goes = place === null || /^[/!]/.test(place) || (place !== "" && Boolean(byId(page, place) || queryAll(page, "a[name]").some((anchor) => attr(anchor, "name") === place)));
      // A scheme that runs a script or makes up a page on the spot is no address to go to.
      const acts = /^(?:javascript|data|vbscript):/i;
      const link = tag(control) === "A" && Boolean(href) && !acts.test(href) && !acts.test(there) && goes
        && ["", "link"].includes(text(attr(control, "role")).toLowerCase()) && !text(handlers(control, ["onclick"]));
      // What the form, or the region around a control with no form, holds:
      // a sign-in has a password field and no multi-line field; a file to
      // attach or a multi-line field means something is being submitted.
      const within = form ? own : region ? deep(region, "input, textarea, [contenteditable], [role=textbox]") : [];
      const lines = form ? multiline : within.some((field) => boxKind(field) === "multiline" && shown(field));
      const signin = !lines && within.some((field) => inputType(field) === "password" && shown(field));
      const carries = lines || within.some((field) => inputType(field) === "file");
      // The language the page declares for this element: its own or the nearest around it, "" for none.
      const speaks = climb(control, (n) => hasAttr(n, "lang"));
      const target = { label: labelOf(acting), role: roleOf(acting), box, submits, search, card, multiline, button: buttonLike(control), changes, typable, field, reach, link, signin, carries, lang: clip(text(speaks ? attr(speaks, "lang") : ""), 20) };
      if (input.enter && box === "multiline") {
        // What could make this box a message composer: its keyboard hint,
        // whether it is the only text field there, what it is called, and
        // what the buttons there are called, the nearest first.
        target.hint = attr(control, "enterkeyhint").toLowerCase() === "send";
        // The only text field there: a search field does not count, nor one
        // in a header, navigation, footer or sidebar the box is not itself in.
        const apart = (other) => boxKind(other) === "search" || Boolean(climb(other, (n) => matches(n, APART) === true && !climb(control, (inside) => inside === n)));
        target.only = (form ? own : deep(scope, TEXTS)).filter((other) => other === control || (boxKind(other) && shown(other) && !apart(other))).length === 1;
        target.says = clip(text(labelOf(control) + " " + attr(control, "placeholder") + " " + attr(control, "aria-placeholder") + " " + attr(control, "data-placeholder")), 200);
        target.near = [];
        for (let n = target.only ? up(control) : null; n && target.near.length < 12; n = n === scope ? null : up(n)) {
          for (const other of deep(n, PRESSED)) {
            const called = clip(labelOf(other), 60);
            if (called && target.near.length < 12 && !target.near.includes(called)) target.near.push(called);
          }
        }
      }
      return { control, target };
    };

    const found = resolve();
    if (found.nothing) return { found: true, label: "", role: "document", box: null, submits: false, search: false, card: false, multiline: false };
    const holder = input.enter && input.box ? focused() : null;
    // Shared by every element in the box: whether the page has a frame (the
    // engine measures an element inside one from the frame's own corner, so
    // its box can be another element's out here), whether one of them is a
    // payment frame, and whether the measured box could be inside one: it
    // starts within the frame's own width and height.
    const frames = deep(document, FRAMES);
    const paying = frames.filter((frame) => shown(frame) && !frameDoc(frame) && pays(frame));
    const about = {
      frames: frames.length > 0, payFrame: paying.length > 0,
      inPay: Boolean(input.box) && paying.some((frame) => { const size = rectOf(frame); return Boolean(size) && input.box.x >= -1 && input.box.y >= -1 && input.box.x < size.width && input.box.y < size.height; }),
    };
    if (!found.picks) return { ...found, ...about };
    const described = each(found.picks, judge);
    if (described.length > 9) return { found: false, error: "too many elements share this box" };
    const [first, ...rest] = described.map((one) => one.target);
    return rest.length ? { found: true, ...first, ...about, also: rest } : { found: true, ...first, ...about };
`;

/** The second read: the evidence for a card, and what its approval is bound to. */
const DETAIL = String.raw`
    // 64 bits of a string: enough to tell that something changed.
    const hash = (value) => {
      let a = 2166136261, b = 5381;
      for (let i = 0; i < value.length; i += 1) { const code = value.charCodeAt(i); a = Math.imul(a ^ code, 16777619); b = Math.imul(b, 33) + code + (a >>> 7) | 0; }
      return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
    };
    // Which element this is: its tag and place among its siblings at every
    // level up (through shadow hosts), and a hash of what it is: its tag and
    // the attributes that say what it does. Its style, its classes and
    // whatever else a page changes without changing the element are left
    // out, so a button a script keeps restyling is still that button.
    const STABLE = ["type", "name", "href", "formaction", "form", "role", "aria-label", "title", "alt", "action", "onclick"];
    const identify = (el) => {
      const steps = [];
      for (let n = el; n; n = up(n)) { let place = 0; for (let s = beforeOf(n); s; s = beforeOf(s)) place += 1; steps.unshift(String(tag(n)).toLowerCase() + ":" + place); }
      return steps.join("/") + "#" + hash(tag(el) + STABLE.map((name) => (hasAttr(el, name) ? " " + name + "=" + attr(el, name) : "")).join(""));
    };
    const seenText = (el) => text(plain(el));
    // A value the card must never carry. The script reads it here, in the
    // page, to count it and to test it; only its length leaves the page.
    // By what the field is called, in English and in the common Spanish,
    // French, German and Portuguese words for the same things.
    // A key or a recovery phrase is hidden in a box of many lines too.
    const KEYS = /\bkey\b|\bsecret\w*\b|\btoken\b|\bseed\b|\bmnemonic\b|\b(?:recovery|backup|seed) ?(?:phrase|key|words?)\b|\bclave\b|\bcle\b|\bschlussel\b|\bchave\b|\b(?:frase|phrase) de recuper\w+\b|\bwiederherstell\w*\b/;
    const SECRETS = [
      ["password", /\bpass(?: ?(?:word|code|phrase|wort))?\b|\bpwd\b|\bpasswd\b|\bkennwort\b|\bcontrasena\b|\bmot de passe\b|\bsenha\b|\bpalavra passe\b/],
      ["card", CARD_NUMBER],
      ["card", /\bcv[cv]\d?\b|\bcvn\b|\bcsc\b|\b(?:security|card) ?code\b|\bcard ?verification\b|\bcodigo de segur\w+\b|\bcryptogramme\b|\bprufziffer\b|\bsicherheitscode\b/],
      ["id", /\bssn\b|\bsocial security\b|\bnational (?:id|insurance|identity)\b|\bnino?\b|\bpassport\b|\bdriv\w* ?s? licen[cs]e\b|\btax (?:id|number|identification|code)\b|\btin\b|\bvat (?:id|number)\b|\biban\b|\bbic\b|\bswift\b|\baccount (?:number|no)\b|\brouting (?:number|no)\b|\bsort code\b|\bifsc\b|\baadhaar\b|\bpan (?:number|no|card)\b|\bdni\b|\bnie\b|\bnif\b|\bcpf\b|\bcnpj\b|\bniss\b|\bsegur\w+ social\b|\bsecurite sociale\b|\bsozialversicher\w+\b|\bnumero fiscal\b|\bidentificacion fiscal\b|\bsteuer\w+\b|\bcontribuinte\b|\bkontonummer\b|\bblz\b|\bcuenta (?:bancaria|corriente)\b|\bnumero de compte\b|\brib\b|\bconta bancaria\b|\b\w*ausweis\w*\b|\bdocumento de identidad\b|\bcarte d identite\b|\bpasaporte\b|\bpasseport\b|\breisepass\b|\bpassaporte\b/],
      ["secret", /\banswer\b|\brespuesta\b|\breponse\b|\bantwort\b|\bresposta\b/],
      ["secret", KEYS],
      ["code", /\botp\b|\btotp\b|\bone ?time\b|\b2fa\b|\bmfa\b|\btwo ?factor\b|\bpin\b(?! ?code)|(?<!\b(?:postal|post|zip|pin|promo|coupon|discount|country|area|referral|product|item) )\b(?:code|codigo)\b(?! ?(?:postal|promo\w*|pays|pais|de descuento|de area))|\b\w+(?:s|ungs)code\b/],
    ];
    const secretIn = (named) => { const found = SECRETS.find((entry) => entry[1].test(named)); return found ? found[0] : null; };
    const secretKind = (field, type, auto, name) => {
      if (type === "password" || /\b(?:current|new)-password\b/.test(auto)) return "password";
      if (/(^|\s)cc-/.test(auto)) return "card";
      if (/\bone-time-code\b/.test(auto)) return "code";
      // A message is what the person is asked to approve: a box of many
      // lines is hidden for its name only when that is a key or a phrase.
      const named = words(attr(field, "name") + " | " + attr(field, "id") + " | " + attr(field, "placeholder") + " | " + name);
      return tag(field) === "INPUT" ? secretIn(named) : KEYS.test(named) ? "secret" : null;
    };
    // One field as the card has it, or null for a control that carries
    // nothing a person typed or chose, or that is not shown.
    const fieldOf = (field) => {
      const auto = attr(field, "autocomplete").toLowerCase();
      const kind = boxKind(field);
      const type = tag(field) === "TEXTAREA" ? "textarea" : tag(field) === "SELECT" ? "select" : editable(field) ? "contenteditable" : tag(field) === "INPUT" ? inputType(field) : kind ? "textbox" : "";
      if (!type || ["hidden", "submit", "button", "image", "reset", "file"].includes(type) || !shown(field)) return null;
      const name = clip(labelOf(field) || attr(field, "id") || type, 60);
      if (type === "checkbox" || type === "radio") return { kind, type, entry: { name, type, value: field.checked ? "checked" : "unchecked" } };
      if (type === "select") return { kind, type, entry: { name, type, value: Array.from(field.selectedOptions).map((option) => text(textOf(option))).join(", ") } };
      const typed = type === "contenteditable" || type === "textbox";
      const value = typed ? plain(field) : String(field.value == null ? "" : field.value);
      const secret = secretKind(field, type, auto, name) || (cardDigits(value) ? "card" : null);
      return { kind, type, entry: secret ? { name, type: secret, length: value.length } : { name, type, value } };
    };
    const TYPED = 'input, textarea, select, [contenteditable], [role=textbox], [role=searchbox]';
    // A field that holds something a person typed or chose, and is not empty.
    const filled = (read) => Boolean(read) && Boolean(read.kind || read.type === "select") && (read.entry.value === undefined ? read.entry.length > 0 : read.entry.value.trim() !== "");
    // Is anything on the screen that the card would mask? A picture of the
    // page would show it, so none is taken. A frame this script can read is
    // looked into; another site's cannot be, and one that names a payment
    // or a sign-in is taken to hold one.
    const FRAME_HINT = /\b(?:card|cvc|cvv|payment|pay|checkout|secure|password|login|signin|sign in|otp|verification|stripe|adyen|braintree|paypal|razorpay)\b/;
    const masks = (root, depth) => all(root, []).some((el) => {
      if (isFrame(el)) {
        if (!shown(el)) return false;
        const inner = frameDoc(el);
        if (inner) return depth < 3 && masks(inner, depth + 1);
        return FRAME_HINT.test(frameWords(el));
      }
      if (!matches(el, TYPED)) return false;
      const read = fieldOf(el);
      return Boolean(read) && read.entry.value === undefined;
    });
    // The state of one control, for the hash an approval is bound to: what
    // it is called and what it holds, shown or not.
    const stateOf = (el) => {
      const type = tag(el) === "INPUT" ? inputType(el) : String(tag(el)).toLowerCase();
      // A box, a switch or an option that is a role, not an input, says what it holds in its state attributes.
      const holds = !FORM_OWNED.includes(tag(el)) && matches(el, STATED) ? attr(el, "role") + ":" + attr(el, "aria-checked") + ":" + attr(el, "aria-selected") + ":" + attr(el, "aria-pressed")
        : type === "checkbox" || type === "radio" ? String(el.checked) + ":" + el.value
        : type === "select" ? Array.from(el.selectedOptions || []).map((option) => option.value).join(",")
        : FORM_OWNED.includes(tag(el)) ? String(el.value == null ? "" : el.value) + ":" + attr(el, "aria-pressed")
        : plain(el);
      return type + "|" + attr(el, "name") + "|" + attr(el, "id") + "|" + holds;
    };
    // Every control under a root and what it holds, and for a frame the page
    // can read, its body and its own controls: a rich-text editor keeps its
    // text there.
    const STATED = '[role=checkbox], [role=switch], [role=radio], [role=option], [role=menuitemcheckbox], [role=menuitemradio], [aria-pressed]';
    const BOUND = TYPED + ", " + STATED + ", " + FRAMES;
    const statesIn = (nodes, depth, out) => {
      for (const el of nodes) {
        if (!isFrame(el)) { out.push(stateOf(el)); continue; }
        const inside = depth < 2 ? frameDoc(el) : null;
        if (!inside) continue;
        const body = bodyOf(inside);
        out.push("frame|" + (body ? plain(body) : ""));
        statesIn(all(inside, []).filter((node) => matches(node, BOUND)), depth + 1, out);
      }
      return out;
    };
    // Relative times and clocks evened out: a row that says "3s ago", then
    // "4s ago", has not changed. Any other number is part of what was
    // approved: a price that changed is a change.
    const steady = (value) => value.replace(/\b(?:(?:\d+|an?|a few) ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo|months?|y|years?|moments?) ago|just now|in \d+ ?(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)|\d\d?:\d\d(?::\d\d)?)\b/gi, "~");
    const CONTAINER = 'tr, li, [role=row], [role=listitem], article, [role=article], dialog, [role=dialog], [role=alertdialog]';
    const evidence = (pick, known) => {
      const { control, box, form, owned, acting } = known;
      const region = form ? null : regionOf(control);
      // What the card lists: the visible fields of the control's own form,
      // or with no form the filled ones of the region around it. A box
      // outside any form comes first, filled or not.
      const fields = [], listed = [];
      const list = (field, always) => {
        const read = fieldOf(field);
        if (!read || (read.type === "radio" && !field.checked) || !(always || filled(read))) return;
        listed.push(field);
        fields.push(read.entry);
      };
      if (form) for (const field of fieldsOf(form, owned, TYPED)) { if (!hasAttr(field, "contenteditable") || editable(field)) list(field, true); }
      else {
        if (box) list(control, true);
        if (region) for (const field of all(region, [])) if (field !== control && matches(field, TYPED)) list(field, false);
      }
      // What the approval is bound to: every control of the form or region,
      // hidden and not displayed ones and the state of tick boxes and lists
      // included. A region with no control of its own says nothing about
      // what goes, so then it is every control on the page.
      let bound = form ? fieldsOf(form, owned, BOUND) : region ? all(region, []).filter((el) => matches(el, BOUND)) : [];
      // A component in the form or region whose inside cannot be read: it
      // has no root that can be opened and nothing of its own on the page,
      // and yet it takes up room. What is in it is not on the card and not
      // part of the approval, and the card has to say so.
      const opaque = Boolean(form || region) && all(form || region, []).some((el) => {
        if (!String(tag(el)).includes("-") || shadowOf(el) || prop("firstElementChild")(el) || !shown(el)) return false;
        const size = rectOf(el);
        return Boolean(size) && size.width > 0 && size.height > 0;
      });
      let others = 0;
      if (!form && !bound.some((el) => el !== control)) {
        bound = all(document, []).filter((el) => matches(el, BOUND));
        // Those are counted on the card, not listed: they are the rest of the page.
        for (const el of bound) {
          if (listed.includes(el) || isFrame(el)) continue;
          if (filled(fieldOf(el))) others += 1;
        }
      }
      // The text around the control, for a person to tell which one it is:
      // the nearest row, list item, article or dialog. With none of those,
      // the nearest wrapper that says more than the control does, unless
      // that is a page of text, or the control's own form when its fields
      // already say what it is.
      let around = climb(up(acting), (n) => matches(n, CONTAINER));
      if (!around) {
        const own = seenText(acting);
        const wider = climb(up(acting), (n) => atTop(n) || seenText(n) !== own);
        if (wider && !atTop(wider) && seenText(wider).length <= 600 && !(wider === form && fields.length > 0)) around = wider;
      }
      const said = around ? clip(seenText(around), 300) : "";
      // That text goes by the same rules as a value: when it names a secret
      // or holds a card number it is not carried, and the page is not pictured.
      const trips = Boolean(said) && (Boolean(secretIn(words(said))) || (said.match(/\d(?:[ -]?\d){12,18}/g) || []).some((run) => cardDigits(run)));
      const identity = pick.within.map((frame) => identify(frame) + ">").join("") + (acting === control ? identify(control) : identify(control) + " " + identify(acting));
      return { control, trips, part: { opaque, fields, others, bound: hash(input.salt + "\n" + statesIn(bound, 0, []).join("\n")), identity, context: trips ? "" : said, around: hash(input.salt + "\n" + steady(said)) } };
    };

    const found = resolve();
    if (!found.picks) return found.nothing ? { found: true, parts: [], secrets: false } : found;
    const described = each(found.picks, evidence);
    if (described.length > 9) return { found: false, error: "too many elements share this box" };
    return { found: true, parts: described.map((one) => one.part), secrets: described.some((one) => one.trips) || masks(document, 0) };
`;

/** A script as it is sent: without the comments and indentation that are
 * for readers here. */
const compact = (body: string): string => `(input) => {\ntry {\n${body.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//")).join("\n")}\n} catch (error) {\nreturn { found: false, error: String(error) };\n}\n}`;
const LIGHT_SCRIPT = compact(PRELUDE + LIGHT);
const DETAIL_SCRIPT = compact(PRELUDE + DETAIL);

/** What a read is asked. `detail` asks for the evidence; `salt` goes into
 * the hashes it makes, so they mean nothing outside the server that asked. */
export interface PageReadInput { box: Box | null; enter: boolean; detail?: boolean; salt?: string }

export function pageReadScript(input: PageReadInput): string {
  return `(${input.detail ? DETAIL_SCRIPT : LIGHT_SCRIPT})(${JSON.stringify({ salt: "", ...input })})`;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** How many button labels near a composer are kept; the page script stops at the same number. */
const MAX_NEAR = 12;
/** How many other elements in one box are worth judging; the page script stops at the same number. */
const MAX_ALSO = 8;
/** More fields than any form a person fills in. Past it the answer is not
 * bound in part: it is not accepted at all. */
const MAX_FIELDS = 5_000;

/** The page wrote these answers, so nothing in them is trusted to be well
 * formed. Null for anything that is not a whole description. */
export function parsePageTarget(value: unknown): PageTarget | null {
  if (!value || typeof value !== "object" || (value as { found?: unknown }).found !== true) return null;
  const raw = value as Record<string, unknown>;
  // The page is one page: what is true of it is so for every element in the box.
  const about = { frames: raw.frames === true, payFrame: raw.payFrame === true, inPay: raw.inPay === true };
  const also = (Array.isArray(raw.also) ? raw.also : []).filter((entry) => entry && typeof entry === "object").slice(0, MAX_ALSO).map((entry) => ({ ...parseTarget(entry as Record<string, unknown>), ...about }));
  return { ...parseTarget(raw), ...about, ...(also.length ? { also } : {}) };
}

function parseTarget(raw: Record<string, unknown>): Omit<PageTarget, "frames" | "payFrame" | "inPay" | "also"> {
  return {
    label: text(raw.label, 120),
    role: text(raw.role, 40),
    box: raw.box === "multiline" || raw.box === "search" || raw.box === "single" ? raw.box : null,
    submits: raw.submits === true,
    search: raw.search === true,
    card: raw.card === true,
    multiline: raw.multiline === true,
    button: raw.button === true,
    changes: raw.changes === true,
    typable: raw.typable === true,
    field: raw.field === true,
    reach: raw.reach === true,
    link: raw.link === true,
    signin: raw.signin === true,
    carries: raw.carries === true,
    lang: text(raw.lang, 20),
    // All together or not at all: without `only` nothing says the field is not a composer.
    ...(typeof raw.only === "boolean" ? {
      hint: raw.hint === true,
      only: raw.only,
      says: text(raw.says, 200),
      near: (Array.isArray(raw.near) ? raw.near : []).filter((label): label is string => typeof label === "string").slice(0, MAX_NEAR).map((label) => label.slice(0, 60)),
    } : {}),
  };
}

export function parsePageDetail(value: unknown): PageDetail | null {
  if (!value || typeof value !== "object" || (value as { found?: unknown }).found !== true) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.parts) || raw.parts.length > MAX_ALSO + 1) return null;
  const parts = raw.parts.map((entry) => (entry && typeof entry === "object" ? parseEvidence(entry as Record<string, unknown>) : null));
  if (parts.some((part) => part === null)) return null;
  return { parts: parts as PageEvidence[], secrets: raw.secrets === true };
}

function parseEvidence(raw: Record<string, unknown>): PageEvidence | null {
  const listed = Array.isArray(raw.fields) ? raw.fields : [];
  if (listed.length > MAX_FIELDS) return null;
  // Values are kept whole: the approval is bound to every character.
  const fields = listed.flatMap((entry): CommitField[] => {
    if (!entry || typeof entry !== "object") return [];
    const field = entry as Record<string, unknown>;
    return [{
      name: text(field.name, 80),
      type: text(field.type, 40),
      ...(typeof field.value === "string" ? { value: field.value } : {}),
      ...(typeof field.length === "number" && Number.isFinite(field.length) ? { length: field.length } : {}),
    }];
  });
  return {
    opaque: raw.opaque === true,
    fields,
    others: typeof raw.others === "number" && Number.isSafeInteger(raw.others) && raw.others > 0 ? raw.others : 0,
    bound: text(raw.bound, 64),
    identity: text(raw.identity, 4_000),
    context: text(raw.context, 300),
    around: text(raw.around, 64),
  };
}

function parseBox(data: Record<string, unknown>): Box | null {
  const { x, y, width, height } = data;
  return [x, y, width, height].every((side) => typeof side === "number" && Number.isFinite(side))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : null;
}

/** One engine command for the session being read (agentBrowserQuery with the
 * mount's binary and session env). `stdin` is what the engine is given on
 * its input: the script, for `eval --stdin`. */
export type EngineQuery = (args: string[], stdin?: string) => ReturnType<typeof agentBrowserQuery>;

/** The longest selector this read hands to the engine. */
export const MAX_SELECTOR = 2_000;

/** How the engine says a selector matches nothing (agent-browser 0.37.0). */
const NOT_FOUND = /^(?:Unknown ref|Element not found|Could not get bounding box)/;

export function browserPageReader(query: EngineQuery): BrowserPageReader {
  // One salt for every read this reader makes: the two looks at one call
  // must hash alike, and nothing else has to.
  const salt = randomBytes(8).toString("hex");
  /** Run one of the two scripts. A page answer that is not a description
   * is one of the reasons it could not give one. */
  const run = async <T>(input: PageReadInput, parse: (value: unknown) => T | null): Promise<T | "unseen" | "unseen-pay" | "framed" | "sealed" | "unreadable"> => {
    // The script goes to the engine on its input, not on its command line:
    // its length is then no concern of the longest command line an
    // operating system will start.
    const answer = await query(["eval", "--stdin"], pageReadScript({ ...input, salt }));
    if (!answer.ok) return "unreadable";
    const result = answer.data.result as { found?: unknown; error?: unknown; framed?: unknown; sealed?: unknown; payFrame?: unknown } | null;
    if (result && typeof result === "object" && result.found === false && result.error === undefined) {
      return result.sealed === true ? "sealed" : result.framed === true ? "framed" : result.payFrame === true ? "unseen-pay" : "unseen";
    }
    return parse(result) ?? "unreadable";
  };
  const read = async <T>(selector: string | null, enter: boolean, detail: boolean, parse: (value: unknown) => T | null): Promise<T | PageBlind> => {
    if (selector === null) {
      const focused = await run({ box: null, enter, detail }, parse);
      return focused === "unseen" || focused === "unseen-pay" ? "unreadable" : focused;
    }
    // The selector becomes an engine argument: one that reads as a flag
    // is never handed over, and neither is one too long to be a selector
    // a person would write. The engine itself takes both, so this is not
    // "missing": the caller must refuse, not act unseen.
    if (!selector || selector.startsWith("-") || selector.length > MAX_SELECTOR) return "unusable";
    let last: "unseen" | "unseen-pay" = "unseen";
    // The page can scroll between the two reads; a second look settles it.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const measured = await query(["get", "box", selector]);
      if (!measured.ok) return NOT_FOUND.test(measured.error) ? "missing" : "unreadable";
      const box = parseBox(measured.data);
      if (!box) return "unreadable";
      // No area is not nothing: the engine clicks the box's corner, and
      // an overflowing child takes the click. There is no box to find the
      // element by, so it cannot be described.
      if (box.width <= 0 || box.height <= 0) return "hidden";
      const target = await run({ box, enter, detail }, parse);
      if (target === "unseen-pay") last = "unseen-pay";
      else if (target !== "unseen") return target;
    }
    return last === "unseen-pay" ? "hidden-pay" : "hidden";
  };
  return {
    async url() {
      const answer = await query(["get", "url"]);
      return answer.ok && typeof answer.data.url === "string" ? answer.data.url : null;
    },
    target: (selector, enter) => read(selector, enter, false, parsePageTarget),
    evidence: (selector, enter) => read(selector, enter, true, parsePageDetail),
    async href(selector) {
      if (!selector || selector.startsWith("-") || selector.length > MAX_SELECTOR) return null;
      const answer = await query(["get", "attr", selector, "href"]);
      return answer.ok && typeof answer.data.value === "string" ? answer.data.value : null;
    },
  };
}
