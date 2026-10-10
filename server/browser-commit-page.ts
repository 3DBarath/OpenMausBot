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
}

export interface BrowserPageReader {
  /** The page's address as the engine reports it, or null when it will not say. */
  url(): Promise<string | null>;
  /** What `selector` resolves to, or the focused element when it is null;
   * `enter` asks what Enter would do there.
   * - "missing": the engine finds no such element, or one with no area, so
   *   acting on it changes nothing.
   * - "hidden": the element is there but this read cannot see it (it is
   *   inside a frame).
   * - "unreadable": the engine or the page did not answer. Nothing is known. */
  target(selector: string | null, enter: boolean): Promise<PageTarget | "missing" | "hidden" | "unreadable">;
}

interface Box { x: number; y: number; width: number; height: number }

/** Runs in the page. No template holes: its one argument is JSON. */
const PAGE_READ = String.raw`(input) => {
  try {
    const text = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const clip = (value, max) => (value.length > max ? value.slice(0, max) : value);
    const attr = (el, name) => (el.getAttribute && el.getAttribute(name)) || "";
    const up = (node) => node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    const climb = (node, test) => { for (let n = node; n; n = up(n)) if (test(n)) return n; return null; };
    const editable = (el) => el.isContentEditable === true && climb(el, (n) => n.hasAttribute && n.hasAttribute("contenteditable")) === el;
    const inputType = (el) => (el.tagName === "INPUT" ? (attr(el, "type") || "text").toLowerCase() : "");
    const ONE_LINE = ["text", "search", "email", "url", "tel", "number", "password", "date", "datetime-local", "month", "week", "time"];
    const boxKind = (el) => {
      if (inputType(el) === "search" || attr(el, "role") === "searchbox") return "search";
      if (el.tagName === "TEXTAREA" || editable(el)) return "multiline";
      if (ONE_LINE.includes(inputType(el))) return "single";
      if (attr(el, "role") === "textbox") return attr(el, "aria-multiline") === "true" ? "multiline" : "single";
      return null;
    };
    const roleOf = (el) => {
      const explicit = text(attr(el, "role")).toLowerCase();
      if (explicit) return explicit;
      if (el.tagName === "BUTTON" || el.tagName === "SUMMARY") return "button";
      if (el.tagName === "A" && el.hasAttribute("href")) return "link";
      if (el.tagName === "SELECT") return "combobox";
      if (el.tagName === "INPUT") {
        const type = inputType(el);
        if (["submit", "button", "image", "reset"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        return type === "search" ? "searchbox" : "textbox";
      }
      return el.tagName === "TEXTAREA" || editable(el) ? "textbox" : "generic";
    };
    const labelOf = (el) => {
      const named = text(attr(el, "aria-label"));
      if (named) return clip(named, 120);
      const root = el.getRootNode && el.getRootNode();
      const by = text(attr(el, "aria-labelledby")).split(" ").map((id) => {
        const node = id && root && root.getElementById ? root.getElementById(id) : null;
        return node ? node.textContent : "";
      });
      if (text(by.join(" "))) return clip(text(by.join(" ")), 120);
      if (["submit", "button", "reset"].includes(inputType(el))) return clip(text(el.value), 120);
      if (el.labels && el.labels.length && text(el.labels[0].textContent)) return clip(text(el.labels[0].textContent), 120);
      if (boxKind(el)) return clip(text(attr(el, "placeholder")) || text(attr(el, "name")) || text(attr(el, "title")), 120);
      if (text(el.textContent)) return clip(text(el.textContent), 120);
      const image = el.querySelector ? el.querySelector("img[alt], svg[aria-label]") : null;
      return clip(text(image ? attr(image, "alt") || attr(image, "aria-label") : "") || text(attr(el, "title")) || text(attr(el, "alt")), 120);
    };
    const CONTROL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="textbox"], [role="searchbox"], [contenteditable]';
    const controlOf = (node) => {
      const control = climb(node, (n) => n.matches && n.matches(CONTROL));
      if (control) return control;
      const label = climb(node, (n) => n.tagName === "LABEL");
      return label && label.control ? label.control : node;
    };
    const formOf = (node) => (node.form && node.form.tagName === "FORM" ? node.form : climb(node, (n) => n.tagName === "FORM"));
    const submitter = (el) => (el.tagName === "BUTTON" || el.tagName === "INPUT") && (el.type === "submit" || el.type === "image") && !el.disabled;
    const shown = (el) => (typeof el.checkVisibility === "function" ? el.checkVisibility({ checkVisibilityCSS: true }) : true);
    const all = (root, out) => {
      for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) all(el.shadowRoot, out); }
      return out;
    };

    let el = null;
    if (input.box) {
      const inControl = (node) => Boolean(climb(node, (n) => n.matches && n.matches(CONTROL)));
      let best = 0;
      for (const candidate of all(document, [])) {
        const rect = candidate.getBoundingClientRect();
        const off = Math.abs(rect.x - input.box.x) + Math.abs(rect.y - input.box.y) + Math.abs(rect.width - input.box.width) + Math.abs(rect.height - input.box.height);
        if (off > 2) continue;
        // The same box twice is a control and its wrapper or its only child:
        // keep the one inside a control, and the deeper of two that are.
        if (!el || off < best || (off === best && (inControl(candidate) || !inControl(el)))) { best = off; el = candidate; }
      }
      if (!el) return { found: false };
    } else {
      el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { found: true, label: "", role: "document", box: null, submits: false, search: false, card: false, multiline: false, fields: [] };
    }

    const control = controlOf(el);
    const box = boxKind(control);
    const form = formOf(control);
    const members = form ? Array.from(form.elements) : [];
    let acting = control;
    let submits = false;
    if (input.enter && (box === "single" || box === "search")) {
      // Enter in a one-line field submits its form, through the first submit button when there is one.
      const first = members.find(submitter);
      if (first) { acting = first; submits = true; }
      else if (form && members.filter((member) => boxKind(member) === "single" || boxKind(member) === "search").length === 1) submits = true;
    } else if (box === null) submits = Boolean(form) && submitter(control);

    const fieldEls = form ? members.concat(Array.from(form.querySelectorAll("[contenteditable]")).filter(editable)) : box ? [control] : [];
    const fields = [];
    let card = false;
    let multiline = false;
    let boxes = 0;
    let searches = 0;
    for (const field of fieldEls) {
      const auto = attr(field, "autocomplete").toLowerCase();
      if (/(^|\s)cc-/.test(auto)) card = true;
      const kind = boxKind(field);
      const type = field.tagName === "TEXTAREA" ? "textarea" : field.tagName === "SELECT" ? "select" : editable(field) ? "contenteditable" : inputType(field);
      if (!type || ["hidden", "submit", "button", "image", "reset", "file"].includes(type) || !shown(field)) continue;
      if (kind) boxes += 1;
      if (kind === "search") searches += 1;
      if (kind === "multiline") multiline = true;
      if (type === "radio" && !field.checked) continue;
      if (fields.length >= 30) continue;
      const name = clip(labelOf(field) || attr(field, "id") || type, 80);
      if (type === "password" || /(^|\s)cc-(number|csc)/.test(auto)) { fields.push({ name, type: type === "password" ? "password" : "card", length: String(field.value || "").length }); continue; }
      const value = type === "checkbox" || type === "radio" ? (field.checked ? "checked" : "unchecked")
        : type === "select" ? Array.from(field.selectedOptions).map((option) => text(option.textContent)).join(", ")
        : type === "contenteditable" ? String(field.innerText == null ? field.textContent : field.innerText)
        : String(field.value == null ? "" : field.value);
      fields.push(value.length > 10000 ? { name, type, value: value.slice(0, 10000), length: value.length } : { name, type, value });
    }
    const search = box === "search" || Boolean(climb(control, (n) => n.matches && n.matches('[role="search"], search'))) || (boxes === 1 && searches === 1);
    return { found: true, label: labelOf(acting), role: roleOf(acting), box, submits, search, card, multiline, fields };
  } catch (error) {
    return { found: false, error: String(error) };
  }
}`;

export function pageReadScript(input: { box: Box | null; enter: boolean }): string {
  return `(${PAGE_READ})(${JSON.stringify(input)})`;
}

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

/** The page wrote this answer, so nothing in it is trusted to be well formed. */
export function parsePageTarget(value: unknown): PageTarget | null {
  if (!value || typeof value !== "object" || (value as { found?: unknown }).found !== true) return null;
  const raw = value as Record<string, unknown>;
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
      // The selector becomes an engine argument: one that reads as a flag is
      // not a selector, and is never handed over.
      if (!selector || selector.startsWith("-") || selector.length > 2_000) return "missing";
      // The page can scroll between the two reads; a second look settles it.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const measured = await query(["get", "box", selector]);
        if (!measured.ok) return NOT_FOUND.test(measured.error) ? "missing" : "unreadable";
        const box = parseBox(measured.data);
        if (!box) return "unreadable";
        // The engine clicks a point inside the box: no area, nothing to land on.
        if (box.width <= 0 || box.height <= 0) return "missing";
        const target = await read({ box, enter });
        if (target !== "unseen") return target;
      }
      return "hidden";
    },
  };
}
