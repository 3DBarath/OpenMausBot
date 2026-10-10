// The server's own look at a bot's page, before a click or an Enter press
// that might send something or spend money (browser-commit-gate.ts).
//
// The bot never sees these reads and cannot shape them: the script below is
// fixed, and its only input is a box the engine itself measured for the
// bot's selector, so the element described is the one the engine would act
// on. Checked against agent-browser 0.37.0: `get box` answers with the same
// numbers as getBoundingClientRect for refs, CSS and xpath= selectors, and
// does not scroll.
import type { agentBrowserQuery } from "./browser-engine.ts";
import type { CommitField } from "../shared/browser-commit.ts";

/** What the page says a click or an Enter press would act on. */
export interface PageTarget {
  label: string;
  role: string;
  box: "multiline" | "search" | "single" | null;
  submits: boolean;
  search: boolean;
  card: boolean;
  multiline: boolean;
  fields: CommitField[];
  /** Other elements in the same box, when nothing says which of them the
   * engine would act on. Any of them may be the one. */
  also?: PageTarget[];
}

/** What a read of a target can come back with instead of a description.
 * - "missing": the engine itself finds no such element, and will say so.
 * - "hidden": the engine found the element but this read cannot describe
 *   it: it is inside a frame, or it has no area (the engine then clicks its
 *   corner, and whatever overflows it takes the click).
 * - "unusable": the selector is one this read will not hand to the engine
 *   (empty, shaped like a command-line flag, or over 2,000 characters).
 * - "unreadable": the engine or the page did not answer. Nothing is known.
 * Only "missing" says there is nothing to act on. */
export type PageBlind = "missing" | "hidden" | "unusable" | "unreadable";

export interface BrowserPageReader {
  /** The page's address as the engine reports it, or null when it will not say. */
  url(): Promise<string | null>;
  /** What `selector` resolves to, or the focused element when it is null;
   * `enter` asks what Enter would do there. */
  target(selector: string | null, enter: boolean): Promise<PageTarget | PageBlind>;
}

interface Box { x: number; y: number; width: number; height: number }

/** Runs in the page. No template holes: its one argument is JSON. */
const PAGE_READ = String.raw`(input) => {
  try {
    // Named access shadows a form's own properties: a control named "tagName"
    // makes form.tagName that control, and document has the same trap. Every
    // read of an element that could be a form, and of the document, goes
    // through the accessor on its prototype chain, which a name cannot reach.
    // Inputs, buttons, selects, text areas and labels have no named access,
    // so their own properties (type, value, checked, labels) are read plainly.
    const lookup = (proto, name) => { for (let at = proto; at; at = Object.getPrototypeOf(at)) { const found = Object.getOwnPropertyDescriptor(at, name); if (found) return found; } return null; };
    const reader = (name) => { const known = new Map(); return (node) => { const proto = Object.getPrototypeOf(node); if (!known.has(proto)) known.set(proto, lookup(proto, name)); return known.get(proto); }; };
    const prop = (name) => { const find = reader(name); return (node) => { try { const found = find(node); return found && found.get ? found.get.call(node) : found ? found.value : undefined; } catch (error) { return undefined; } }; };
    const method = (name) => { const find = reader(name); return (node, ...args) => { try { const found = find(node); return found && typeof found.value === "function" ? found.value.apply(node, args) : undefined; } catch (error) { return undefined; } }; };
    const tag = prop("tagName"), parentOf = prop("parentElement"), shadowOf = prop("shadowRoot"), kindOf = prop("nodeType"), hostOf = prop("host");
    const textOf = prop("textContent"), editableOf = prop("isContentEditable"), ownerOf = prop("form"), focusOf = prop("activeElement"), rootOf = method("getRootNode");
    const getAttr = method("getAttribute"), hasAttr = method("hasAttribute"), matches = method("matches"), byId = method("getElementById"), pointIn = method("elementFromPoint");
    const queryIn = method("querySelector"), queryAllIn = method("querySelectorAll"), rectOf = method("getBoundingClientRect"), visible = method("checkVisibility");
    const FORM_OWNED = ["INPUT", "BUTTON", "SELECT", "TEXTAREA"];
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
    const labelOf = (el) => {
      const named = text(attr(el, "aria-label"));
      if (named) return clip(named, 120);
      const root = rootOf(el);
      const by = text(attr(el, "aria-labelledby")).split(" ").map((id) => {
        const node = id && root ? byId(root, id) : null;
        return node ? textOf(node) : "";
      });
      if (text(by.join(" "))) return clip(text(by.join(" ")), 120);
      if (["submit", "button", "reset"].includes(inputType(el))) return clip(text(el.value), 120);
      const labels = FORM_OWNED.includes(tag(el)) ? el.labels : null;
      if (labels && labels.length && text(textOf(labels[0]))) return clip(text(textOf(labels[0])), 120);
      if (boxKind(el)) return clip(text(attr(el, "placeholder")) || text(attr(el, "name")) || text(attr(el, "title")), 120);
      if (text(textOf(el))) return clip(text(textOf(el)), 120);
      const image = queryIn(el, "img[alt], svg[aria-label]");
      return clip(text(image ? attr(image, "alt") || attr(image, "aria-label") : "") || text(attr(el, "title")) || text(attr(el, "alt")), 120);
    };
    const CONTROL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="searchbox"], [contenteditable]';
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
    const submitter = (el) => (tag(el) === "BUTTON" || tag(el) === "INPUT") && (el.type === "submit" || el.type === "image") && !el.disabled;
    const shown = (el) => visible(el, { checkVisibilityCSS: true }) !== false;
    const all = (root, out) => {
      for (const el of queryAll(root, "*")) { out.push(el); const inner = shadowOf(el); if (inner) all(inner, out); }
      return out;
    };
    // A handler written on the element or its form (the attribute, or the
    // function set as el.onchange) whose text submits. A listener added with
    // addEventListener cannot be read, and is not seen.
    const SUBMITS = /\b(?:submit|requestSubmit)\s*\(|\.\s*click\s*\(/;
    const handlerOf = { onchange: prop("onchange"), oninput: prop("oninput"), onclick: prop("onclick") };
    const handlers = (el, names) => names.map((name) => { const set = handlerOf[name](el); return attr(el, name) + " " + (typeof set === "function" ? Function.prototype.toString.call(set) : ""); }).join(" ");
    const handlerSubmits = (control, form) => SUBMITS.test(handlers(control, ["onchange", "oninput", "onclick"]) + " " + handlers(form, ["onchange", "oninput"]));

    const describe = (el) => {
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
      const viaDefault = () => { const first = owned.find(submitter); if (first) acting = first; return Boolean(first); };
      if (input.enter && form && box !== "multiline" && (formControl || box)) {
        // Enter on a form control (a one-line field, but also a checkbox, a
        // radio button, a select, a slider) submits the form through its
        // first submit button; with none, only from its one text field.
        submits = viaDefault() || (Boolean(box) && owned.filter((member) => boxKind(member) === "single" || boxKind(member) === "search").length === 1);
      } else if (!input.enter && form && toggles && handlerSubmits(control, form)) {
        // Changing this control submits its form by the page's own handler.
        viaDefault();
        submits = true;
      } else if (box === null) submits = Boolean(form) && submitter(control);

      const fieldEls = form ? owned.concat(queryAll(form, "[contenteditable]").filter(editable)) : box ? [control] : [];
      const fields = [];
      let card = false;
      let multiline = false;
      let boxes = 0;
      let searches = 0;
      for (const field of fieldEls) {
        const auto = attr(field, "autocomplete").toLowerCase();
        if (/(^|\s)cc-/.test(auto)) card = true;
        const kind = boxKind(field);
        const fieldType = tag(field) === "TEXTAREA" ? "textarea" : tag(field) === "SELECT" ? "select" : editable(field) ? "contenteditable" : inputType(field);
        if (!fieldType || ["hidden", "submit", "button", "image", "reset", "file"].includes(fieldType) || !shown(field)) continue;
        if (kind) boxes += 1;
        if (kind === "search") searches += 1;
        if (kind === "multiline") multiline = true;
        if (fieldType === "radio" && !field.checked) continue;
        if (fields.length >= 30) continue;
        const name = clip(labelOf(field) || attr(field, "id") || fieldType, 80);
        if (fieldType === "password" || /(^|\s)cc-(number|csc)/.test(auto)) { fields.push({ name, type: fieldType === "password" ? "password" : "card", length: String(field.value || "").length }); continue; }
        const value = fieldType === "checkbox" || fieldType === "radio" ? (field.checked ? "checked" : "unchecked")
          : fieldType === "select" ? Array.from(field.selectedOptions).map((option) => text(textOf(option))).join(", ")
          : fieldType === "contenteditable" ? String(field.innerText == null ? textOf(field) : field.innerText)
          : String(field.value == null ? "" : field.value);
        fields.push(value.length > 10000 ? { name, type: fieldType, value: value.slice(0, 10000), length: value.length } : { name, type: fieldType, value });
      }
      const search = box === "search" || Boolean(climb(control, (n) => matches(n, '[role="search"], search'))) || (boxes === 1 && searches === 1);
      return { control, target: { label: labelOf(acting), role: roleOf(acting), box, submits, search, card, multiline, fields } };
    };

    let picks = [];
    if (input.box) {
      // Every element with the box the engine measured. Two can share one:
      // a control and its wrapper or only child, or two stacked in a cell.
      const same = all(document, []).filter((candidate) => {
        const rect = rectOf(candidate);
        return Boolean(rect) && Math.abs(rect.x - input.box.x) + Math.abs(rect.y - input.box.y) + Math.abs(rect.width - input.box.width) + Math.abs(rect.height - input.box.height) <= 2;
      });
      if (!same.length) return { found: false };
      // Of a chain that shares the box, the deepest stands for all of it.
      picks = same.filter((candidate) => !same.some((other) => other !== candidate && climb(up(other), (n) => n === candidate)));
      if (!input.enter) {
        // A click lands on whatever is on top at the centre of the box.
        // When that is one of these, or inside one, it is the target.
        const x = input.box.x + input.box.width / 2, y = input.box.y + input.box.height / 2;
        let hit = pointIn(document, x, y);
        for (let inner = hit && shadowOf(hit); inner; inner = shadowOf(hit)) {
          const deeper = pointIn(inner, x, y);
          if (!deeper || deeper === hit) break;
          hit = deeper;
        }
        if (hit && climb(hit, (n) => same.includes(n))) picks = [hit];
      }
    } else {
      let el = focusOf(document);
      for (let inner = el && shadowOf(el); inner && focusOf(inner); inner = shadowOf(el)) el = focusOf(inner);
      if (!el || tag(el) === "BODY" || tag(el) === "HTML") return { found: true, label: "", role: "document", box: null, submits: false, search: false, card: false, multiline: false, fields: [] };
      picks = [el];
    }
    // Whatever is left is judged, each control once: the caller holds when any of them is a commitment.
    const described = [];
    for (const pick of picks) {
      const one = describe(pick);
      if (!described.some((other) => other.control === one.control)) described.push(one);
    }
    if (described.length > 9) return { found: false, error: "too many elements share this box" };
    const [first, ...rest] = described.map((one) => one.target);
    return rest.length ? { found: true, ...first, also: rest } : { found: true, ...first };
  } catch (error) {
    return { found: false, error: String(error) };
  }
}`;

/** The script as it is sent. Its comments and indentation are for readers
 * here: all of it travels as one command-line argument, and Windows allows
 * 32,767 characters for a whole command line. */
const PAGE_SCRIPT = PAGE_READ.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//")).join("\n");

export function pageReadScript(input: { box: Box | null; enter: boolean }): string {
  return `(${PAGE_SCRIPT})(${JSON.stringify(input)})`;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** How many other elements in one box are worth judging; the page script stops at the same number. */
const MAX_ALSO = 8;

/** The page wrote this answer, so nothing in it is trusted to be well formed. */
export function parsePageTarget(value: unknown): PageTarget | null {
  if (!value || typeof value !== "object" || (value as { found?: unknown }).found !== true) return null;
  const also = (value as { also?: unknown }).also;
  const others = (Array.isArray(also) ? also : []).flatMap((entry) => (entry && typeof entry === "object" ? [parseTarget(entry as Record<string, unknown>)] : [])).slice(0, MAX_ALSO);
  return { ...parseTarget(value as Record<string, unknown>), ...(others.length ? { also: others } : {}) };
}

function parseTarget(raw: Record<string, unknown>): PageTarget {
  const fields = (Array.isArray(raw.fields) ? raw.fields : []).slice(0, 30).flatMap((entry): CommitField[] => {
    if (!entry || typeof entry !== "object") return [];
    const field = entry as Record<string, unknown>;
    return [{
      name: text(field.name, 80),
      type: text(field.type, 40),
      ...(typeof field.value === "string" ? { value: field.value.slice(0, 10_000) } : {}),
      ...(typeof field.length === "number" && Number.isFinite(field.length) ? { length: field.length } : {}),
    }];
  });
  return {
    label: text(raw.label, 120),
    role: text(raw.role, 40),
    box: raw.box === "multiline" || raw.box === "search" || raw.box === "single" ? raw.box : null,
    submits: raw.submits === true,
    search: raw.search === true,
    card: raw.card === true,
    multiline: raw.multiline === true,
    fields,
  };
}

function parseBox(data: Record<string, unknown>): Box | null {
  const { x, y, width, height } = data;
  return [x, y, width, height].every((side) => typeof side === "number" && Number.isFinite(side))
    ? { x: x as number, y: y as number, width: width as number, height: height as number }
    : null;
}

/** One engine command for the session being read (agentBrowserQuery with the
 * mount's binary and session env). */
export type EngineQuery = (args: string[]) => ReturnType<typeof agentBrowserQuery>;

/** The longest selector this read hands to the engine. */
export const MAX_SELECTOR = 2_000;

/** How the engine says a selector matches nothing (agent-browser 0.37.0). */
const NOT_FOUND = /^(?:Unknown ref|Element not found|Could not get bounding box)/;

export function browserPageReader(query: EngineQuery): BrowserPageReader {
  const read = async (input: { box: Box | null; enter: boolean }): Promise<PageTarget | "unseen" | "unreadable"> => {
    const answer = await query(["eval", "-b", Buffer.from(pageReadScript(input)).toString("base64")]);
    if (!answer.ok) return "unreadable";
    const result = answer.data.result as { found?: unknown; error?: unknown } | null;
    if (result && typeof result === "object" && result.found === false && result.error === undefined) return "unseen";
    return parsePageTarget(result) ?? "unreadable";
  };
  return {
    async url() {
      const answer = await query(["get", "url"]);
      return answer.ok && typeof answer.data.url === "string" ? answer.data.url : null;
    },
    async target(selector, enter) {
      if (selector === null) {
        const focused = await read({ box: null, enter });
        return focused === "unseen" ? "unreadable" : focused;
      }
      // The selector becomes an engine argument: one that reads as a flag
      // is never handed over, and neither is one too long to be a selector
      // a person would write. The engine itself takes both, so this is not
      // "missing": the caller must refuse, not act unseen.
      if (!selector || selector.startsWith("-") || selector.length > MAX_SELECTOR) return "unusable";
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
        const target = await read({ box, enter });
        if (target !== "unseen") return target;
      }
      return "hidden";
    },
  };
}
