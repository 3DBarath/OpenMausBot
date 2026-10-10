// What an import may never do to the server, against an isolated fixture
// server: a folder that stops being writable while an upload is being
// scanned fails that import, in words, and the server keeps answering; and a
// server whose import folder is corrupt or cannot be written at boot starts
// normally and shows no import. No model is called anywhere here.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import type { ImportJobView, ImportOverview } from "../shared/context-import.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Take write permission from a folder and what is in it, or give it back. */
function lock(dir: string, locked: boolean): void {
  for (const path of [join(dir, "tmp"), dir]) {
    if (existsSync(path)) chmodSync(path, locked ? 0o500 : 0o700);
  }
}

// chmod does not stop the owner on Windows, and root ignores it everywhere
const canLock = process.platform !== "win32" && process.getuid?.() !== 0;

it.skipIf(!canLock)("fails an import whose folder stops being writable during the scan, and keeps answering", async () => {
  const fixture = await launchVerificationServer({ ...process.env });
  const { url, dataDir, logPath } = fixture.info;
  const dir = join(dataDir, "context-import");
  const overview = async () => (await (await fetch(`${url}/api/context-import`)).json()) as ImportOverview;
  try {
    const created = await fetch(`${url}/api/context-import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "chatgpt" }) });
    expect(created.status).toBe(201);
    const { job } = await created.json() as { job: ImportJobView };
    // about 96 MB of list items: a scan long enough for the folder to change under it
    const item = Buffer.from(`{"hello":"world","pad":"${"x".repeat(1_000)}"},`);
    const body = Buffer.concat([Buffer.from("["), ...Array.from({ length: 96_000 }, () => item), Buffer.from('{"last":true}]')]);
    const uploaded = await fetch(`${url}/api/context-import/${job.id}/file`, { method: "PUT", headers: { "content-type": "application/json" }, body });
    expect(uploaded.status).toBe(200);
    expect(((await uploaded.json()) as { job: ImportJobView }).job.status).toBe("scanning");
    lock(dir, true);

    // the scan ends and cannot write what it found: the server must still be there to say so
    await expect.poll(async () => (await overview()).job?.status, { timeout: 60_000, interval: 200 }).toBe("failed");
    const failed = (await overview()).job!;
    expect(failed.error).toBeTruthy();
    expect((await fetch(`${url}/api/health`)).ok).toBe(true);
    expect(readFileSync(logPath, "utf8")).not.toMatch(/unhandled|UnhandledPromiseRejection/i);

    // once the folder can be written again the import is cancelled like any other
    lock(dir, false);
    expect((await fetch(`${url}/api/context-import/${job.id}/cancel`, { method: "POST" })).status).toBe(200);
    expect((await overview()).job).toBeNull();
    expect(existsSync(dir)).toBe(false);
  } finally {
    lock(dir, false);
    await fixture.close();
  }
}, 180_000);

it.skipIf(!canLock)("starts normally when the import folder is corrupt or cannot be written, and shows no import", async () => {
  const parentEnv = { ...process.env };
  const fixture = await launchVerificationServer(parentEnv);
  const { url, dataDir } = fixture.info;
  const dir = join(dataDir, "context-import");
  let restarted: ChildProcess | undefined;
  const healthy = async () => {
    try {
      return (await fetch(`${url}/api/health`)).ok;
    } catch {
      return false;
    }
  };
  const boot = async () => {
    restarted = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server", "index.ts")], {
      cwd: ROOT, env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: "ignore",
    });
    await expect.poll(healthy, { timeout: 45_000, interval: 200 }).toBe(true);
  };
  const stop = async () => {
    await waitForExit(restarted, { signal: "SIGTERM" });
    restarted = undefined;
  };
  const seed = (job: string) => {
    lock(dir, false);
    mkdirSync(join(dir, "tmp"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "job.json"), job, { mode: 0o600 });
    writeFileSync(join(dir, "tmp", "left-behind.upload"), "[]", { mode: 0o600 });
  };
  const noImport = async () => {
    const overview = (await (await fetch(`${url}/api/context-import`)).json()) as ImportOverview;
    expect(overview.job).toBeNull();
  };
  const review = JSON.stringify({
    id: "11111111-2222-3333-4444-555555555555", origin: "paste", status: "review", batches: 1, nextBatch: 1, skippedBatches: [], duplicates: 0, consolidated: true,
    candidates: [{ id: "c1", text: "The person is vegetarian", kind: "core", subject: "Food", aliases: [], date: "2026-10-01", sensitive: null, chatTitle: "Pasted text", keep: true }],
    readHashes: [], readFrom: null, readTo: null,
  });
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    // a job file that is not JSON, in a folder nothing can be removed from
    seed("{ not json");
    lock(dir, true);
    await boot();
    await noImport();
    await stop();

    // a job that could be read, in a folder it cannot be saved to
    seed(review);
    lock(dir, true);
    await boot();
    await noImport();
    await stop();

    // a job file that is not JSON, in a folder that can be cleared: cleared
    seed("{ not json");
    await boot();
    await noImport();
    expect(existsSync(dir)).toBe(false);
    await stop();

    // and with nothing in the way, a review a restart interrupted is still there
    seed(review);
    await boot();
    const overview = (await (await fetch(`${url}/api/context-import`)).json()) as ImportOverview;
    expect(overview.job).toMatchObject({ status: "review", candidates: [{ text: "The person is vegetarian" }] });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    lock(dir, false);
    await fixture.close();
  }
}, 300_000);
