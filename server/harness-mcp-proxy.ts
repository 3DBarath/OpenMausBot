// Per-turn MCP entry point for the tools the harness serves itself: the
// built-in browser, the cloud computer and the Data tools. argv[2] names
// which one. Only a turn-scoped capability crosses into the agent process;
// engine commands, session names, and provider credentials (the Boat token)
// stay in OMB.
import { request } from "node:http";
import { pathToFileURL } from "node:url";

import { DATA_INSTRUCTIONS } from "./data/instructions.ts";

const MAX_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 16_777_216;
const MAX_PENDING = 16;
type RpcId = string | number | null;
export type HarnessMcpKind = "browser" | "computer" | "data";

const NAMES: Record<HarnessMcpKind, string> = { browser: "Browser", computer: "Cloud computer", data: "Data" };
/** Server instructions sent with initialize, for a family that has them. */
const INSTRUCTIONS: Partial<Record<HarnessMcpKind, string>> = { data: DATA_INSTRUCTIONS };
/** What a model needs after a failed call, per tool family: the failure is
 * about this one connection, and an uncertain action must be checked first. */
const RECOVERY: Record<HarnessMcpKind, string> = {
  browser: " This failure does not establish that all browsers are unavailable. Inspect available connections with select_computer if that tool is present. Keep the requested computer and account; do not bypass a permission refusal or human takeover, and do not repeat an uncertain action without checking its result.",
  computer: " Keep working on the assigned cloud computer only; do not bypass a person's control of it, and take a fresh screenshot before repeating an action whose result is uncertain.",
  data: " The tables already loaded are unchanged; check with data_describe or SHOW TABLES before repeating a load, and do not repeat a statement whose result is uncertain.",
};

/** How long one relayed call may take before the proxy gives up on it. */
const CALL_TIMEOUT_MS = 130_000;

/** A browser call can wait behind a person's answer to a commit hold
 * (server/browser-commit-gate.ts), so the server tells this process how
 * long that may take. Every other family keeps the short limit. */
export function harnessCallTimeoutMs(kind: HarnessMcpKind, env: NodeJS.ProcessEnv = process.env): number {
  const granted = kind === "browser" ? Number(env.OMB_MCP_CALL_TIMEOUT_MS) : NaN;
  return Number.isSafeInteger(granted) && granted > CALL_TIMEOUT_MS ? granted : CALL_TIMEOUT_MS;
}

function parseHarnessMcpKind(value: unknown): HarnessMcpKind | null {
  return value === "browser" || value === "computer" || value === "data" ? value : null;
}

function failure(id: RpcId, method: unknown, message: string, code = -32603): unknown {
  return method === "tools/call"
    ? { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } }
    : { jsonrpc: "2.0", id, error: { code, message } };
}

async function boundedJson(response: Response, name: string): Promise<unknown> {
  if (!response.body) throw new Error(`${name} server returned an empty response.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error(`${name} response exceeded the size limit.`);
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}

/** One browser POST to the harness, answered as its status and parsed JSON
 * body. Only the browser's calls come this way; the other families keep
 * fetch, exactly as they always had it.
 *
 * Not fetch: Node's fetch gives up on a response whose headers have not
 * arrived within 300 seconds, whatever its signal allows, and a browser call
 * can wait nine minutes on a person's answer. node:http has no such limit;
 * `signal` is the only thing that ends the wait. It never follows a
 * redirect, so the capability goes to this address and nowhere else, and
 * each call has a connection of its own: closing it is how the server
 * learns the call was abandoned. */
function postJson(url: URL, token: string, body: string, signal: AbortSignal, name: string): Promise<{ ok: boolean; payload: unknown }> {
  return new Promise((resolve, reject) => {
    const call = request(url, {
      method: "POST", agent: false, signal,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), authorization: `Bearer ${token}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_OUTPUT_BYTES) call.destroy(new Error(`${name} response exceeded the size limit.`));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (!size) { reject(new Error(`${name} server returned an empty response.`)); return; }
        const status = response.statusCode ?? 0;
        try { resolve({ ok: status >= 200 && status < 300, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch (error) { reject(error); }
      });
    });
    call.on("error", reject);
    call.end(body);
  });
}

/** A failure of the connection itself, not an answer from the server: the
 * state of the call is unknown. */
function interrupted(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return /fetch failed|abort|timeout|socket hang up/i.test(error.message) || typeof (error as NodeJS.ErrnoException).code === "string";
}

/** Relay one frame. `cancelled` is for a browser call only: it aborts when
 * the engine gave up on the call (notifications/cancelled) or went away.
 * The request to the server is then closed, so the commit hold waiting
 * behind it ends, and nothing is answered. The computer and Data routes
 * abort their work when a request closes, so their calls are never closed
 * early: those families behave as they did before any of this. */
export async function harnessMcpRequest(
  frame: unknown,
  connection: { url: string; token: string; kind: HarnessMcpKind; timeoutMs?: number },
  cancelled?: AbortSignal,
): Promise<unknown | undefined> {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return failure(null, null, "Invalid request.", -32600);
  const message = frame as { id?: RpcId; jsonrpc?: unknown; method?: unknown; params?: unknown };
  const id = message.id ?? null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string" || (id !== null && typeof id !== "number" && typeof id !== "string")) return failure(null, null, "Invalid request.", -32600);
  if (!Object.hasOwn(message, "id")) return undefined;
  const name = NAMES[connection.kind];
  if (message.method === "initialize") return {
    jsonrpc: "2.0", id,
    result: {
      protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: `openmausbot-${connection.kind}`, version: "1" },
      ...(INSTRUCTIONS[connection.kind] ? { instructions: INSTRUCTIONS[connection.kind] } : {}),
    },
  };
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method !== "tools/list" && message.method !== "tools/call") return failure(id, message.method, "Method not found.", -32601);
  try {
    const url = new URL(connection.url);
    if (!connection.token || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error(`${name} connection is not configured. Start a new bot turn from OpenMausBot.`);
    }
    const body = JSON.stringify({ method: message.method, params: message.params ?? {} });
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new Error(`${name} request exceeded the size limit.`);
    const limit = AbortSignal.timeout(connection.timeoutMs ?? CALL_TIMEOUT_MS);
    const target = new URL(`/api/internal/${connection.kind}/mcp`, url);
    let response: { ok: boolean; payload: unknown };
    if (connection.kind === "browser") {
      response = await postJson(target, connection.token, body, cancelled ? AbortSignal.any([limit, cancelled]) : limit, name);
    } else {
      const answer = await fetch(target, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` },
        body, signal: limit,
      });
      response = { ok: answer.ok, payload: await boundedJson(answer, name) };
    }
    const payload = response.payload as { result?: unknown; error?: unknown } | null;
    if (!response.ok || !payload || typeof payload !== "object" || !Object.hasOwn(payload, "result")) {
      throw new Error(typeof payload?.error === "string" ? payload.error.slice(0, 2_000) : `${name} server is unavailable. Start a new bot turn or try again.`);
    }
    return { jsonrpc: "2.0", id, result: payload.result };
  } catch (error) {
    // A cancelled browser call is not answered: the engine is no longer waiting for it.
    if (connection.kind === "browser" && cancelled?.aborted) return undefined;
    const detail = interrupted(error)
      ? `${name} connection was interrupted. Do not repeat the action until its state is checked.` : (error as Error).message;
    return failure(id, message.method, detail + RECOVERY[connection.kind]);
  }
}

function run(kind: HarnessMcpKind): void {
  const connection = { url: process.env.OMB_HARNESS_URL ?? "", token: process.env.OMB_MCP_TOKEN ?? "", kind, timeoutMs: harnessCallTimeoutMs(kind) };
  let input = Buffer.alloc(0);
  let pending = 0;
  /** Calls on their way to the server, by request id, so a cancel can end one. */
  const inFlight = new Map<string | number, AbortController>();
  const output = (message: unknown) => {
    if (message === undefined) return;
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES || process.stdout.writableLength > MAX_OUTPUT_BYTES * 2) {
      process.stdin.destroy();
      process.exitCode = 1;
      return;
    }
    process.stdout.write(line);
  };
  process.stdout.on("error", () => { process.stdin.destroy(); process.exitCode = 1; });
  process.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    let newline: number;
    while ((newline = input.indexOf(10)) !== -1) {
      if (newline > MAX_INPUT_BYTES) { process.stdin.destroy(); process.exitCode = 1; return; }
      const line = input.subarray(0, newline).toString("utf8");
      input = input.subarray(newline + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); }
      catch { output(failure(null, null, "Parse error.", -32700)); continue; }
      const incoming = frame && typeof frame === "object" && !Array.isArray(frame) ? frame as { id?: RpcId; method?: unknown; params?: { requestId?: unknown } } : null;
      if (kind === "browser" && incoming?.method === "notifications/cancelled" && !Object.hasOwn(incoming, "id")) {
        // The engine gave up on a browser call. Close its request, so the
        // server ends what waited behind it: a commit hold must not outlive
        // the call that asked for it. Only the browser: the other routes
        // abort their work when a request closes.
        const target = incoming.params?.requestId;
        if (typeof target === "string" || typeof target === "number") inFlight.get(target)?.abort();
        continue;
      }
      if (pending >= MAX_PENDING) {
        if (incoming && Object.hasOwn(incoming, "id")) output(failure(incoming.id ?? null, incoming.method, `Too many pending ${kind} requests.`));
        continue;
      }
      const id = incoming?.id;
      const cancel = kind === "browser" && (typeof id === "string" || typeof id === "number") ? new AbortController() : undefined;
      if (cancel && id !== undefined && id !== null) inFlight.set(id, cancel);
      pending++;
      void harnessMcpRequest(frame, connection, cancel?.signal).then(output).finally(() => {
        pending--;
        if (cancel && id !== undefined && id !== null && inFlight.get(id) === cancel) inFlight.delete(id);
      });
    }
    if (input.length > MAX_INPUT_BYTES) { process.stdin.destroy(); process.exitCode = 1; }
  });
  // The engine went away: nobody is waiting for its browser calls any more.
  if (kind === "browser") process.stdin.on("close", () => { for (const call of inFlight.values()) call.abort(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const kind = parseHarnessMcpKind(process.argv[2]);
  if (!kind) {
    process.stderr.write("usage: harness-mcp-proxy browser|computer|data\n");
    process.exitCode = 2;
  } else run(kind);
}
