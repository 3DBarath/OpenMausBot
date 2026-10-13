// Fix hints: when a tool call fails in a way we have seen many times, one
// short "Hint:" line goes after the error the bot reads, so its next call
// changes approach instead of repeating the same one. A hint only adds text
// to a result that already failed: it never turns a failure into a success
// or the reverse, and a successful result is never annotated.
//
// Where hints are applied:
//   - OpenMausBot's own tools (the "agents" MCP server, every engine):
//     server/drivers/agents-proxy.ts, on each error result.
//   - Claude Code's native tools (Bash, Read, …): the PostToolUseFailure hook
//     (server/hooks/omb-hook.ts → ingestEngineHook in server/index.ts), which
//     hands the hint back as additionalContext beside the error.
//   - Other engines' native tools have no hook that can add to a result yet;
//     those failures still reach Sentinel, just without a hint on the spot.
//
// Adding an entry: copy a real error into `example`, keep `match` free of
// the values that vary between occurrences (numbers, paths, quoted names),
// and keep `hint` to one sentence. The fields line up with a Sentinel issue
// (server/sentinel/normalize.ts): `origin` and `tool` are its origin and tool,
// and `example` can be the issue's normalized title — `match` must match that
// form too, which is why it avoids the values normalization replaces. That is
// how Sentinel can later propose new entries from its most frequent issues.

/** Who owns a tool. Same values and rules as Sentinel's `toolOrigin`. */
export type HintOrigin = "harness" | "external" | "shell";

export interface FixHint {
  /** stable kebab-case name, for tests and telemetry */
  id: string;
  origin: HintOrigin;
  /** limit to these tool names (case-insensitive, without any mcp__ prefix) */
  tools?: readonly string[];
  match: RegExp;
  hint: string;
  /** a real failure this entry is for; the test suite checks it matches */
  example: string;
}

const AWK_BUILTINS = "sin|cos|atan2|exp|log|sqrt|int|rand|srand|length|substr|index|split|sub|gsub|match|sprintf|tolower|toupper|system|close|getline|fflush";

export const FIX_HINTS: readonly FixHint[] = [
  {
    id: "shell-timeout",
    origin: "shell",
    match: /\bcommand timed out after\b/i,
    hint: "Run long jobs (media encoding, transcription, big searches) in the background or with a longer timeout, and scope searches: use mdfind or a specific folder instead of `find /`.",
    example: "Exit code 143\nCommand timed out after 2m 0s",
  },
  {
    id: "awk-builtin-name",
    origin: "shell",
    match: new RegExp(`\\bawk\\b[\\s\\S]*\\bsyntax error\\b[\\s\\S]*\\b(?:${AWK_BUILTINS})\\s*=`, "i"),
    hint: "`sin`, `cos`, `log`, `int`, `index` and similar are awk built-in functions and cannot be variable names: rename the variable, or do the math in python3.",
    example: "awk: syntax error at source line 1\n context is\n\t{ >>>  sin= <<< $1/254016000000",
  },
  {
    id: "read-missing-file",
    origin: "external",
    tools: ["read"],
    match: /\bfile does not exist\b/i,
    hint: "List the folder first (`ls`) to see the actual file names, then read one that is there; don't guess names.",
    example: "File does not exist. Note: your current working directory is <path>.",
  },
  {
    id: "assign-to-ancestor",
    origin: "harness",
    match: /\bcannot assign work back to an ancestor\b|\bcannot return to an ancestor room\b/i,
    hint: "Your requester gets your final reply automatically: finish your turn with the result, or with your question if you are blocked.",
    example: "Cannot assign work back to an ancestor; results return automatically",
  },
  {
    id: "already-completed",
    origin: "harness",
    match: /\balready completed your assignment\b/i,
    hint: "Nothing was sent, and retrying will be refused again: don't acknowledge, write your final answer now.",
    example: "This agent already completed your assignment. Do not send acknowledgements or approvals as new work.",
  },
  {
    id: "unknown-bot",
    origin: "harness",
    match: /\bno bot with id\b/i,
    hint: "In a room, the ids you can reach come from list_room_targets; copy one exactly instead of guessing a name.",
    example: "No bot with id or name <q> — call list_bots to see who you can reach.",
  },
];

// The MCP servers OpenMausBot itself provides, as in Sentinel's toolOrigin.
const HARNESS_SERVERS = new Set([
  "ogb", "computer", "agents", "composio", "data", "browser", "phone", "dweb",
  "openmausbot", "openmausbot_connectors", "openmausbot_phone",
]);
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "exec_command", "local_shell", "run_command", "terminal"]);

/** Who owns a tool, by its engine-side name. */
export function hintOrigin(tool: string): HintOrigin {
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return HARNESS_SERVERS.has(mcp[1]!) ? "harness" : "external";
  return SHELL_TOOLS.has(tool.toLowerCase()) ? "shell" : "external";
}

const MAX_SCAN = 8_000;

/** The hint for a failed call, if one fits. Only the start and end of a long
 * error are scanned: that is where engines put the reason. */
export function fixHintFor(failure: { tool: string; text: string; origin?: HintOrigin; table?: readonly FixHint[] }): FixHint | undefined {
  const origin = failure.origin ?? hintOrigin(failure.tool);
  const bare = failure.tool.replace(/^mcp__.+?__/, "").toLowerCase();
  const text = failure.text.length > MAX_SCAN ? `${failure.text.slice(0, MAX_SCAN / 2)}\n${failure.text.slice(-MAX_SCAN / 2)}` : failure.text;
  return (failure.table ?? FIX_HINTS).find((entry) =>
    entry.origin === origin && (!entry.tools || entry.tools.includes(bare)) && entry.match.test(text));
}

export const HINT_PREFIX = "Hint: ";

/** `text` with the hint line appended; unchanged when no entry fits or the
 * text already carries that hint. */
export function withFixHint(failure: { tool: string; text: string; origin?: HintOrigin }): string {
  const entry = fixHintFor(failure);
  if (!entry || failure.text.includes(entry.hint)) return failure.text;
  return `${failure.text}\n\n${HINT_PREFIX}${entry.hint}`;
}
