import type { SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { launchVerificationServer } from "../scripts/control-omb.ts";

const LEFT = "123e4567-e89b-12d3-a456-426614174000.jpg";
const KEPT = "223e4567-e89b-12d3-a456-426614174000.jpg";

// Put the launcher's disposable home in the state a server leaves when it
// stops with a commit card open: the card's screenshot on disk and listed.
// The real child then boots on it and serves real requests.
vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return {
    ...childProcess,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const dataDir = options.env?.OMB_DATA_DIR;
      if (!dataDir || !args.includes(join(process.cwd(), "server", "index.ts"))) {
        throw new Error("Expected the isolated verification server");
      }
      mkdirSync(join(dataDir, "attachments"), { recursive: true });
      writeFileSync(join(dataDir, "attachments", LEFT), "a picture of a page");
      writeFileSync(join(dataDir, "attachments", KEPT), "somebody's photo");
      writeFileSync(join(dataDir, "browser-hold-shots.json"), JSON.stringify([LEFT]));
      return childProcess.spawn(command, args, options);
    },
  };
});

it("deletes at start the hold screenshot a stopped server left behind, and no other attachment", async () => {
  const session = await launchVerificationServer();
  try {
    const attachments = join(session.info.dataDir, "attachments");
    expect(existsSync(join(attachments, LEFT))).toBe(false);
    expect(readFileSync(join(attachments, KEPT), "utf8")).toBe("somebody's photo");
    expect(JSON.parse(readFileSync(join(session.info.dataDir, "browser-hold-shots.json"), "utf8"))).toEqual([]);
    expect((await fetch(`${session.info.url}/api/attachments/${LEFT}`, { headers: { origin: session.info.url } })).status).toBe(404);
  } finally {
    await session.close();
  }
}, 30_000);
