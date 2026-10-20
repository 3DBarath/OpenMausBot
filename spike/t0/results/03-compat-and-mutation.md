# T0 spike raw results, part 3 — mutation check + compatibility (bubblewrap box, real Fly machine)

## Mutation check (proves the isolation tests have teeth)
T0_MUTATE=bind-data,bind-otherws,share-pid removes the mount restrictions and the PID namespace. Exactly these flip to FAIL,
nothing else: cannot read messages.db / config+keys / data dir / other bot workspace / other person folder / other turn's PID.
The broker, egress and key-in-env checks stay PASS (their protections were not mutated).

## Compatibility inside the bubblewrap box (what bots run)
summary: node true, python true, git true, npmInstall true, chromeNoSandbox true, chromeNestedSandbox true, mcpStdio true
- node v24.22.0, python3 3.11.2 start.
- git init+add+commit in the bound workspace works.
- `npm install is-number@7.0.0` succeeds THROUGH the egress proxy (HTTPS_PROXY -> the gate -> registry.npmjs.org). No direct net.
- Headless Chrome (AGENT_BROWSER_EXECUTABLE_PATH, --headless=new --disable-dev-shm-usage) renders `<html>...`:
  - with --no-sandbox (the box is the sandbox): works.
  - WITH Chrome's own nested zygote sandbox (no --no-sandbox): ALSO works — nested unprivileged userns is allowed on Fly.
- MCP stdio server: JSON-RPC initialize round-trips through a spawned child's stdio.
- Claude Code CLI 2.1.305 and codex-cli 0.163.0 start inside the box (part 1). pnpm is NOT in the image (only npm 11.19.1);
  it must be baked into the Cloud image or installed per-box.
