// One top-level JSON list, fed as bytes, split into its elements. A ChatGPT
// or Claude export keeps every conversation in a single list that can run to
// gigabytes, so it is never parsed whole: this finds where each element
// starts and ends and hands its bytes over, and the caller parses one
// conversation at a time. Only structure is tracked (strings, escapes and
// bracket depth); a byte of a multi-byte character is never one of those.
const QUOTE = 0x22, BACKSLASH = 0x5c, OPEN_BRACE = 0x7b, CLOSE_BRACE = 0x7d, OPEN_BRACKET = 0x5b, CLOSE_BRACKET = 0x5d, COMMA = 0x2c;
const BOM = [0xef, 0xbb, 0xbf];
const isSpace = (byte: number) => byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;

/** A single conversation past this is skipped and counted, never held. */
export const MAX_ELEMENT_BYTES = 32 * 1024 * 1024;

export class NotAListError extends Error {
  constructor() {
    super("The file is not a JSON list.");
    this.name = "NotAListError";
  }
}

export interface ArraySplitter {
  /** Feed the next bytes. Throws NotAListError when the text does not start with `[`. */
  push(chunk: Uint8Array): void;
  /** After the last chunk: whether the list was closed. */
  closed(): boolean;
}

export function createArraySplitter(opts: { onElement: (bytes: Buffer) => void; onOversized: () => void; maxElementBytes?: number }): ArraySplitter {
  const max = opts.maxElementBytes ?? MAX_ELEMENT_BYTES;
  let started = false;
  let closed = false;
  let bom = 0;
  // inside an element: a container (depth counts its open brackets) or a bare string, number or literal
  let inElement = false;
  let scalar = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parts: Uint8Array[] = [];
  let size = 0;
  let oversized = false;

  const keep = (chunk: Uint8Array, from: number, to: number) => {
    if (oversized || to <= from) return;
    size += to - from;
    if (size > max) {
      oversized = true;
      parts = [];
      return;
    }
    parts.push(chunk.subarray(from, to));
  };
  const finish = () => {
    if (oversized) opts.onOversized();
    else opts.onElement(Buffer.concat(parts));
    parts = [];
    size = 0;
    oversized = false;
    inElement = false;
    scalar = false;
  };

  return {
    push(chunk) {
      if (closed) return;
      let from = inElement ? 0 : -1;
      for (let i = 0; i < chunk.length; i += 1) {
        const byte = chunk[i]!;
        if (!started) {
          // a UTF-8 byte order mark may come first
          if (bom < BOM.length && byte === BOM[bom]) {
            bom += 1;
            continue;
          }
          if (isSpace(byte)) continue;
          if (byte !== OPEN_BRACKET) throw new NotAListError();
          started = true;
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
          continue;
        }
        if (!inElement) {
          if (isSpace(byte) || byte === COMMA) continue;
          if (byte === CLOSE_BRACKET) {
            closed = true;
            return;
          }
          inElement = true;
          from = i;
          if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth = 1;
          else {
            scalar = true;
            inString = byte === QUOTE;
          }
          continue;
        }
        if (scalar) {
          if (byte === QUOTE) inString = true;
          else if (byte === COMMA || byte === CLOSE_BRACKET || isSpace(byte)) {
            keep(chunk, from, i);
            finish();
            from = -1;
            if (byte === CLOSE_BRACKET) {
              closed = true;
              return;
            }
          }
          continue;
        }
        if (byte === QUOTE) inString = true;
        else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
        else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
          depth -= 1;
          if (depth === 0) {
            keep(chunk, from, i + 1);
            finish();
            from = -1;
          }
        }
      }
      if (inElement && from !== -1) keep(chunk, from, chunk.length);
    },
    closed: () => closed,
  };
}
