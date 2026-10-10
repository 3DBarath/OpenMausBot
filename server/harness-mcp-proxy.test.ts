import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { harnessCallTimeoutMs, harnessMcpRequest } from "./harness-mcp-proxy.ts";

let server: Server;
let url = "";
let status = 200;
let payload: unknown = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
let delayMs = 0;
const requests: Array<{ path: string | undefined; auth: string | undefined; body: unknown }> = [];
/** Calls whose connection closed before the server had answered, by tool name. */
const abandoned: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { params?: { name?: string } };
      requests.push({ path: req.url, auth: req.headers.authorization, body: parsed });
      // What the browser route watches to end a commit hold nobody waits for.
      res.once("close", () => { if (!res.writableEnded) abandoned.push(parsed.params?.name ?? ""); });
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
const connection = (kind: "browser" | "computer" | "data" = "browser") => ({ url, token: "scoped-capability", kind });
const frame = (method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

describe("harness MCP capability proxy", () => {
  it("answers initialize/ping locally and ignores notifications", async () => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("initialize"), connection())).resolves.toMatchObject({ result: { capabilities: { tools: {} } } });
    await expect(harnessMcpRequest(frame("ping"), connection())).resolves.toMatchObject({ result: {} });
    await expect(harnessMcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, connection())).resolves.toBeUndefined();
    expect(requests.length).toBe(count);
  });

  it("relays only the RPC result and scoped capability, not a session/engine command", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    await expect(harnessMcpRequest(frame("tools/list"), connection())).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "agent_browser_snapshot" }] } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/browser/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    payload = { result: { content: [{ type: "image", data: "jpeg", mimeType: "image/jpeg" }] } };
    await expect(harnessMcpRequest(frame("tools/call", { name: "agent_browser_snapshot" }), connection())).resolves.toMatchObject({ result: { content: [{ type: "image", data: "jpeg" }] } });
  });

  it("sends the cloud computer's calls to its own harness route", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "screenshot" }] } };
    await expect(harnessMcpRequest(frame("initialize"), connection("computer"))).resolves.toMatchObject({ result: { serverInfo: { name: "openmausbot-computer" } } });
    await expect(harnessMcpRequest(frame("tools/list"), connection("computer"))).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "screenshot" }] } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/computer/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    status = 401;
    payload = { error: "the internal turn capability has expired" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "exec", arguments: { command: "true" } }), connection("computer")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("expired");
    expect(refused.result.content[0].text).toContain("cloud computer");
    expect(refused.result.content[0].text).not.toContain("select_computer");
  });

  it("sends the Data tools' calls to their own harness route, with the dialect instructions at initialize", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "data_sql" }], instructions: "DuckDB" } };
    const initialized = await harnessMcpRequest(frame("initialize"), connection("data")) as { result: { serverInfo: { name: string }; instructions?: string } };
    expect(initialized.result.serverInfo.name).toBe("openmausbot-data");
    expect(initialized.result.instructions).toContain("GROUP BY ALL");
    // the browser and the computer carry no instructions
    expect(((await harnessMcpRequest(frame("initialize"), connection("browser"))) as { result: Record<string, unknown> }).result.instructions).toBeUndefined();
    await expect(harnessMcpRequest(frame("tools/list"), connection("data"))).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "data_sql" }], instructions: "DuckDB" } });
    expect(requests.at(-1)).toEqual({ path: "/api/internal/data/mcp", auth: "Bearer scoped-capability", body: { method: "tools/list", params: {} } });
    status = 503;
    payload = { error: "Data tools are unavailable: the DuckDB binding did not load" };
    const refused = await harnessMcpRequest(frame("tools/call", { name: "data_sql", arguments: { sql: "SELECT 1" } }), connection("data")) as any;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("DuckDB binding");
    expect(refused.result.content[0].text).toContain("data_describe");
  });

  it("fails closed with an MCP tool refusal, but tools/list uses an RPC error", async () => {
    status = 403;
    payload = { error: "Browser tools are paused while a person controls this browser." };
    await expect(harnessMcpRequest(frame("tools/call"), connection())).resolves.toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("paused") }] } });
    await expect(harnessMcpRequest(frame("tools/list"), connection())).resolves.toMatchObject({ error: { code: -32603, message: expect.stringContaining("paused") } });
  });

  it("waits as long as the server grants a browser call, and no longer", async () => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "clicked after approval" }] } };
    delayMs = 150;
    try {
      const cut = await harnessMcpRequest(frame("tools/call", { name: "agent_browser_click" }), { ...connection(), timeoutMs: 40 }) as any;
      expect(cut.result.isError).toBe(true);
      expect(cut.result.content[0].text).toContain("connection was interrupted");
      await expect(harnessMcpRequest(frame("tools/call", { name: "agent_browser_click" }), { ...connection(), timeoutMs: 2_000 }))
        .resolves.toMatchObject({ result: { content: [{ text: "clicked after approval" }] } });
    } finally { delayMs = 0; }
  });

  // Node's fetch gives up when a response's headers have not come within
  // 300 seconds, whatever its own signal allows (measured: a nine-minute
  // hold returned at 303 s). A dispatcher with a one-second limit stands in
  // for that here: the proxy must not go through it.
  it("outlasts the HTTP client's own wait for headers when the server grants longer", async () => {
    const key = Symbol.for("undici.globalDispatcher.1");
    const globals = globalThis as unknown as Record<symbol, { constructor: new (options: { headersTimeout: number }) => unknown } | undefined>;
    const dispatcher = globals[key];
    expect(dispatcher, "Node's fetch no longer keeps its dispatcher here; find the new stand-in").toBeDefined();
    globals[key] = new dispatcher!.constructor({ headersTimeout: 1_000 }) as typeof dispatcher;
    status = 200;
    payload = { result: { content: [{ type: "text", text: "clicked after approval" }] } };
    delayMs = 2_500;
    try {
      // The stand-in really does cut a fetch at its limit...
      await expect(fetch(`${url}/api/internal/browser/mcp`, { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) })).rejects.toThrow(/fetch failed/);
      // ...and the proxy's own call is not cut by it.
      await expect(harnessMcpRequest(frame("tools/call", { name: "agent_browser_click" }), { ...connection(), timeoutMs: 10_000 }))
        .resolves.toMatchObject({ result: { content: [{ text: "clicked after approval" }] } });
    } finally {
      delayMs = 0;
      globals[key] = dispatcher;
    }
  }, 20_000);

  it("keeps every other family on the short limit, and cuts a browser call at the limit it was granted", async () => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "late" }] } };
    delayMs = 600;
    try {
      for (const kind of ["computer", "data", "browser"] as const) {
        const cut = await harnessMcpRequest(frame("tools/call", { name: `slow_${kind}` }), { ...connection(kind), timeoutMs: 100 }) as { result: { isError: boolean; content: Array<{ text: string }> } };
        expect(cut.result.isError, kind).toBe(true);
        expect(cut.result.content[0]!.text, kind).toContain("connection was interrupted");
      }
    } finally { delayMs = 0; }
  });

  it("says the connection was interrupted when the server cannot be reached, and never follows a redirect", async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const gone = `http://127.0.0.1:${(dead.address() as { port: number }).port}`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const refused = await harnessMcpRequest(frame("tools/call", { name: "agent_browser_click" }), { url: gone, token: "scoped-capability", kind: "browser" }) as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]!.text).toContain("Browser connection was interrupted");
    // A redirect is an answer the proxy does not act on: the capability goes nowhere else.
    const elsewhere: string[] = [];
    const other = createServer((req, res) => { elsewhere.push(req.headers.authorization ?? ""); res.end("{}"); });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const redirect = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as { port: number }).port}/api/internal/browser/mcp` }); res.end("{}"); });
    await new Promise<void>((resolve) => redirect.listen(0, "127.0.0.1", resolve));
    try {
      const sent = await harnessMcpRequest(frame("tools/call", { name: "agent_browser_click" }), { url: `http://127.0.0.1:${(redirect.address() as { port: number }).port}`, token: "scoped-capability", kind: "browser" }) as { result: { isError: boolean } };
      expect(sent.result.isError).toBe(true);
      expect(elsewhere).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
      await new Promise<void>((resolve) => redirect.close(() => resolve()));
    }
  });

  // The engine abandons a call by sending notifications/cancelled. The hold
  // behind that call must end with it, or a later Allow sends for nobody.
  it("closes its request to the server when the call is cancelled, and answers nothing for it", async () => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "clicked" }] } };
    delayMs = 3_000;
    const cancel = new AbortController();
    try {
      const call = harnessMcpRequest(frame("tools/call", { name: "cancelled_in_flight" }), { ...connection(), timeoutMs: 10_000 }, cancel.signal);
      await expect.poll(() => requests.some((request) => (request.body as { params?: { name?: string } }).params?.name === "cancelled_in_flight")).toBe(true);
      cancel.abort();
      await expect(call).resolves.toBeUndefined();
      await expect.poll(() => abandoned, { timeout: 1_000 }).toContain("cancelled_in_flight");
    } finally { delayMs = 0; }
  });

  it("takes a longer limit only for the browser, only from a whole number above the default", () => {
    expect(harnessCallTimeoutMs("browser", { OMB_MCP_CALL_TIMEOUT_MS: "570000" })).toBe(570_000);
    expect(harnessCallTimeoutMs("computer", { OMB_MCP_CALL_TIMEOUT_MS: "570000" })).toBe(130_000);
    expect(harnessCallTimeoutMs("data", { OMB_MCP_CALL_TIMEOUT_MS: "570000" })).toBe(130_000);
    for (const value of [undefined, "", "soon", "60000", "130000", "-1", "1e99", "570000.5"]) {
      expect(harnessCallTimeoutMs("browser", { OMB_MCP_CALL_TIMEOUT_MS: value }), String(value)).toBe(130_000);
    }
  });

  it.each(["https://example.com", "http://127.0.0.1.evil.test", "http://user:pass@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1/#secret"])("never sends its capability to invalid harness URL %s", async (badUrl) => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("tools/call"), { url: badUrl, token: "private", kind: "browser" })).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("rejects arbitrary RPC methods, missing capabilities, and oversized payloads without reaching the server", async () => {
    const count = requests.length;
    await expect(harnessMcpRequest(frame("resources/read"), connection())).resolves.toMatchObject({ error: { code: -32601 } });
    await expect(harnessMcpRequest(frame("tools/call"), { url, token: "", kind: "computer" })).resolves.toMatchObject({ result: { isError: true } });
    await expect(harnessMcpRequest(frame("tools/call", { text: "x".repeat(1_048_577) }), connection())).resolves.toMatchObject({ result: { isError: true } });
    expect(requests.length).toBe(count);
  });

  it("runs as the actual stdin/stdout MCP entry point with no engine credentials", async () => {
    status = 200;
    payload = { result: { tools: [{ name: "agent_browser_snapshot" }] } };
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "computer"], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Proxy did not respond")), 3_000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("\n")) { clearTimeout(timer); resolve(JSON.parse(output.split("\n")[0])); }
      });
      child.on("error", reject);
    });
    try {
      child.stdin.write(`${JSON.stringify(frame("tools/list"))}\n`);
      await expect(result).resolves.toMatchObject({ result: { tools: [{ name: "agent_browser_snapshot" }] } });
      expect(requests.at(-1)).toMatchObject({ path: "/api/internal/computer/mcp", auth: "Bearer entrypoint-capability" });
    } finally {
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  });

  it("ends a call the engine cancels, goes on serving, and never answers the cancelled one", async () => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "clicked" }] } };
    delayMs = 2_000;
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "browser"], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability", OMB_MCP_CALL_TIMEOUT_MS: "570000" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: Array<{ id: number }> = [];
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (let newline = output.indexOf("\n"); newline !== -1; newline = output.indexOf("\n")) {
        lines.push(JSON.parse(output.slice(0, newline)));
        output = output.slice(newline + 1);
      }
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "cancelled_over_stdio" } })}\n`);
      await expect.poll(() => requests.some((request) => (request.body as { params?: { name?: string } }).params?.name === "cancelled_over_stdio"), { timeout: 5_000 }).toBe(true);
      // A cancel for a call that is not in flight changes nothing.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 99, reason: "stale" } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "the turn was stopped" } })}\n`);
      await expect.poll(() => abandoned, { timeout: 1_500 }).toContain("cancelled_over_stdio");
      delayMs = 0;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "after_the_cancel" } })}\n`);
      await expect.poll(() => lines.map((line) => line.id), { timeout: 5_000 }).toContain(8);
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(lines.map((line) => line.id)).toEqual([8]);
    } finally {
      delayMs = 0;
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }, 20_000);

  /** The stdio entry point for one family, with what it wrote and a way to stop it. */
  const proxy = (kind: string) => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), kind], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability", OMB_MCP_CALL_TIMEOUT_MS: "570000" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const lines: Array<{ id: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }> = [];
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (let newline = output.indexOf("\n"); newline !== -1; newline = output.indexOf("\n")) {
        lines.push(JSON.parse(output.slice(0, newline)));
        output = output.slice(newline + 1);
      }
    });
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    // It may have ended by itself by the time a test stops it.
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const stop = async () => { child.kill(); await closed; };
    const reached = (name: string) => expect.poll(() => requests.some((request) => (request.body as { params?: { name?: string } }).params?.name === name), { timeout: 5_000 }).toBe(true);
    return { child, lines, send, stop, reached };
  };

  // The computer and Data routes abort their work when the request closes.
  // A cancel must not reach them: those families behave as they always did.
  it.each(["computer", "data"])("does not close a %s call on a cancel notification, and answers it", async (kind) => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "done all the same" }] } };
    delayMs = 900;
    const name = `not_cancelled_${kind}`;
    const p = proxy(kind);
    try {
      p.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name } });
      await p.reached(name);
      p.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "the engine moved on" } });
      await expect.poll(() => p.lines.map((line) => line.id), { timeout: 5_000 }).toEqual([5]);
      expect(p.lines[0]!.result!.content![0]!.text).toBe("done all the same");
      expect(abandoned).not.toContain(name);
    } finally {
      delayMs = 0;
      await p.stop();
    }
  }, 20_000);

  // When the engine goes away its end of the pipe closes. A commit hold
  // behind a browser call must end then, not wait out its nine minutes.
  it("closes in-flight browser calls when its input closes, and leaves the other families' calls to finish", async () => {
    status = 200;
    payload = { result: { content: [{ type: "text", text: "clicked" }] } };
    delayMs = 2_500;
    const browser = proxy("browser");
    const computer = proxy("computer");
    try {
      browser.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "input_closed_browser" } });
      computer.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "input_closed_computer" } });
      await browser.reached("input_closed_browser");
      await computer.reached("input_closed_computer");
      browser.child.stdin.end();
      computer.child.stdin.end();
      await expect.poll(() => abandoned, { timeout: 1_500 }).toContain("input_closed_browser");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(abandoned).not.toContain("input_closed_computer");
    } finally {
      delayMs = 0;
      await browser.stop();
      await computer.stop();
    }
  }, 20_000);

  // Only the browser's call outlasts the HTTP client's own wait: the other
  // families go through fetch, as they do on main.
  it("keeps the computer and Data calls on fetch, the client they have always used", async () => {
    const key = Symbol.for("undici.globalDispatcher.1");
    const globals = globalThis as unknown as Record<symbol, { constructor: new (options: { headersTimeout: number }) => unknown } | undefined>;
    const dispatcher = globals[key];
    expect(dispatcher).toBeDefined();
    globals[key] = new dispatcher!.constructor({ headersTimeout: 1_000 }) as typeof dispatcher;
    status = 200;
    payload = { result: { content: [{ type: "text", text: "late" }] } };
    delayMs = 2_500;
    try {
      for (const kind of ["computer", "data"] as const) {
        const cut = await harnessMcpRequest(frame("tools/call", { name: `via_fetch_${kind}` }), { ...connection(kind), timeoutMs: 10_000 }) as { result: { isError: boolean; content: Array<{ text: string }> } };
        expect(cut.result.isError, kind).toBe(true);
        expect(cut.result.content[0]!.text, kind).toContain("connection was interrupted");
      }
    } finally {
      delayMs = 0;
      globals[key] = dispatcher;
    }
  }, 20_000);

  it("refuses to start without a known tool family", async () => {
    const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./harness-mcp-proxy.ts", import.meta.url)), "shell"], {
      env: { OMB_HARNESS_URL: url, OMB_MCP_TOKEN: "entrypoint-capability" }, stdio: ["pipe", "pipe", "pipe"],
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code).toBe(2);
  });
});
