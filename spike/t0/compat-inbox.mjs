// Runs INSIDE a T0 box: the things bots actually run. Prints one JSON line. Network goes through the egress proxy in env.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const out = {};
const run = (cmd, args, opts = {}) => { try { return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", timeout: 40000, ...opts }).trim().slice(0, 200) }; } catch (e) { return { ok: false, err: (e.stderr || e.message || "").toString().slice(0, 200) }; } };
const ws = process.cwd();

out.node = run(process.execPath, ["--version"]);
out.python = run("python3", ["--version"]);

// git init + commit
const repo = join(ws, "repo"); mkdirSync(repo, { recursive: true });
out.git = (() => {
  const r1 = run("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "f.txt"), "hi");
  run("git", ["-C", repo, "add", "."]);
  const r2 = run("git", ["-C", repo, "-c", "user.email=a@b.c", "-c", "user.name=x", "commit", "-qm", "hi"]);
  const r3 = run("git", ["-C", repo, "log", "--oneline"]);
  return { ok: r1.ok && r2.ok && r3.ok, log: r3.out };
})();

// npm install through the egress proxy (reaches registry.npmjs.org, a public host)
const proj = join(ws, "proj"); mkdirSync(proj, { recursive: true });
writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "t0", version: "1.0.0", private: true }));
const npm = run("npm", ["install", "--no-audit", "--no-fund", "--prefer-online", "is-number@7.0.0"], { cwd: proj });
out.npmInstall = { ok: npm.ok && existsSync(join(proj, "node_modules", "is-number")), err: npm.err };

// headless Chrome: the box is the sandbox, so --no-sandbox is expected; try with the zygote sandbox too.
const chrome = process.env.AGENT_BROWSER_EXECUTABLE_PATH;
const chromeArgs = (extra) => ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", ...extra, "--dump-dom", "about:blank"];
out.chromeNoSandbox = chrome ? run(chrome, chromeArgs(["--no-sandbox"])) : { ok: false, err: "no chrome path" };
out.chromeNoSandbox = { ok: out.chromeNoSandbox.ok && out.chromeNoSandbox.out.includes("<html"), head: out.chromeNoSandbox.out?.slice(0, 40), err: out.chromeNoSandbox.err };
const sandboxed = chrome ? run(chrome, chromeArgs([])) : { ok: false };
out.chromeNestedSandbox = { ok: sandboxed.ok && (sandboxed.out || "").includes("<html"), err: (sandboxed.err || "").slice(0, 120) };

// MCP stdio server: engines talk to MCP servers over stdio. Round-trip a JSON-RPC initialize through a child.
const serverSrc = join(ws, "mcp.mjs");
writeFileSync(serverSrc, `let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const line=b.slice(0,i);b=b.slice(i+1);try{const m=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{serverInfo:{name:"t0-mcp"},tools:["echo"]}})+"\\n");}catch{}}});`);
const mcp = spawnSync(process.execPath, [serverSrc], { input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n", encoding: "utf8", timeout: 10000 });
out.mcpStdio = { ok: /"name":"t0-mcp"/.test(mcp.stdout || ""), reply: (mcp.stdout || "").trim().slice(0, 120) };

out.summary = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v && typeof v === "object" ? v.ok : v]));
console.log(JSON.stringify(out));
