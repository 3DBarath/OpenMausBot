import { nameIsCommand } from "../../shared/tool-name";

// A shell call that exits non-zero is reported as an error even when every
// step but the last did its job: `ls … | grep …; which missing-tool` prints
// the listing and then exits 1. Claude's Bash tool marks that result
// `is_error` and prefixes it with `Exit code N`, so the chip read as a hard
// failure next to correct output. These helpers tell a plain non-zero exit
// that still produced real output apart from a failure.

/** Exit statuses that mean the command was stopped, not that it finished:
 * 124 (`timeout`), 137 (SIGKILL) and 143 (SIGTERM, how a timed-out Bash
 * call ends). Those stay failures whatever they printed. */
const STOPPED = new Set([124, 137, 143]);

const EXIT_LINE = /^\s*Exit code (\d+)[^\S\r\n]*(?:\r?\n|$)/;

/** The result text, unwrapped when a provider sent content blocks that the
 * server previewed as JSON (`[{ "type": "text", "text": "Exit code 1…" }]`). */
function resultText(output: string): string {
  if (!/^\s*[[{]/.test(output)) return output;
  try {
    const parsed: unknown = JSON.parse(output);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    const texts = blocks.map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : null));
    return texts.every((text) => text !== null) ? texts.join("\n") : output;
  } catch {
    return output;
  }
}

/** The exit status to show as a warning instead of a failure, or null when
 * the call is a real failure (or no failure at all). Only a failed shell
 * call whose result starts with `Exit code N` qualifies, and only when it
 * printed at least two lines (or a long line) besides that marker — a lone
 * `cat: x: No such file or directory` or an empty `grep` stays red. */
export function softExitCode(tool: { name: string; ok?: boolean; output?: string }): number | null {
  if (tool.ok !== false || !tool.output) return null;
  if (tool.name !== "Bash" && !nameIsCommand(tool.name)) return null;
  const text = resultText(tool.output);
  const match = EXIT_LINE.exec(text);
  if (!match) return null;
  const code = Number(match[1]);
  if (!code || STOPPED.has(code)) return null;
  const rest = text.slice(match[0].length);
  if (/timed out|\bkilled\b/i.test(rest)) return null;
  const lines = rest.split(/\r?\n/).filter((line) => line.trim()).length;
  return lines >= 2 || rest.trim().length >= 120 ? code : null;
}
