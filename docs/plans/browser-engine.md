# One browser engine: agent-browser

**Decision (Sep 6, 2026):** the bots' browser is [agent-browser](https://github.com/vercel-labs/agent-browser)
(Vercel Labs, Apache-2.0), pinned, on every platform: macOS, Windows and Linux
desktop, and headless servers. It replaces the Electron browser surface. The
comparison behind the decision (Playwright MCP, Chrome DevTools MCP, Steel,
Stagehand, browser-use, browserless, Lightpanda) is summarised at the end.

## Why

- **Windows has no browser today.** The Electron surface needs the renderer
  sandbox, and Electron 43 exits before ready with it on Windows
  (electron/electron#51761). A browser that is its own Chrome process, driven
  over CDP, does not depend on that.
- **Servers have no browser today.** `openmausbot serve` and the Docker stack
  run without Electron, so `availableBrowserConnection()` is null and the
  toggle is greyed.
- **One engine, one contract.** A skill written on a Mac runs on a VPS.
- **The login wall.** Every shipping agent product (ChatGPT agent, Browserbase
  Live View, Cloudflare Browser Run) hands the browser to the human at a
  sign-in or CAPTCHA and resumes. agent-browser's stream carries screencast
  frames out and mouse/keyboard in, so we get watch-and-take-over on desktop
  and server for the price of a canvas.

## What agent-browser gives us

- A Rust daemon over CDP; Chrome for Testing downloaded and verified by
  `agent-browser install` (existing Chrome/Chromium/Brave detected).
- Isolated, parallel **sessions** (`--session <id>`), with `--restore`
  auto-saving cookies and localStorage under a stable key; persistent
  profiles; reuse of the user's own Chrome profile on a desktop; auth state
  import/export; an encrypted auth vault (`AGENT_BROWSER_ENCRYPTION_KEY`).
- An MCP stdio server (`agent-browser mcp --tools core`) whose verbs match our
  17 `browser_*` tools almost one to one.
- A stream server: JPEG frames, the active URL, tabs, and viewport metadata.
  Upstream does **not** enforce human priority. OMB owns that gate.

## Shape

```
bot turn → scoped OMB MCP proxy → commit gate → profile control gate → agent-browser MCP → Chrome
owner UI ← authenticated SSE ← OMB ← loopback WebSocket frames ← agent-browser
owner UI → authenticated POST → control gate → acknowledged native input → Chrome
```

`browserIntegration()` in `server/index.ts` mounts a turn-scoped OMB proxy,
guarded by the workspace flag, bot switch, and provider's `browserMcp`
capability. Native session identity and encryption keys stay in the server.

## Steps

### 1. Headless engine (servers, and the fallback everywhere) — shipped

- `server/browser-engine.ts`: resolve the pinned agent-browser binary
  (`OMB_AGENT_BROWSER_PATH` → `$OMB_DATA_DIR/tools/agent-browser/<version>/` →
  PATH); download from the GitHub release with per-platform SHA-256 pinned in
  `server/browser-engine-release.ts` (same pattern as `antigravity-release.ts`
  and `prepare-cloudflared.mjs`); ensure Chrome with `agent-browser install`;
  report `unavailable` with the reason rather than degrading silently.
- `browserIntegration()`: when no desktop connection exists and the engine is
  available, return `{command: <binary>, args: ["mcp", "--tools", "core",
  "--no-webmcp"], env: {AGENT_BROWSER_SESSION, AGENT_BROWSER_RESTORE: <stable-key>,
  AGENT_BROWSER_ENCRYPTION_KEY, AGENT_BROWSER_HEADLESS: "1"}}`. Session id =
  the bot's browser profile partition, or the bot id (own session).
- Encryption key: generated once into `$OMB_DATA_DIR/browser-engine-key`
  (0600), like the tunnel credentials.
- Capability: the environment descriptor gains `capabilities.browser:
  "desktop" | "headless" | "unavailable"` (+ reason), and the Settings toggle
  and the per-bot switch key off it instead of `window.ogb.browser`.
- Docker: `npm install -g agent-browser@<pinned>` and `agent-browser install
  --with-deps` at build time, as root, before `USER maus`.
- Tests: resolver and download pinning (stub server), the integration spec
  (mutation-check the guards), an e2e turn against a fake `agent-browser`
  binary that speaks MCP.

### 2. Desktop, all three platforms — shipped

- The same engine and spec on the desktop; the Electron surface
  (`electron/browser-surface.cjs`, `browser-host.cjs`, `browser-platform.cjs`,
  the partition cleanup, the connection/control sync, the Windows gate, the
  preload `browser:*` IPC, the snapshot bundle) and the server's per-turn
  capability registry are deleted. Bot and profile deletion clear the
  engine's session state on the server itself, through the same durable
  cleanup journal. Settings and the bot's Browser panel offer a one-click
  install of the engine (`POST /api/browser-engine/install`).
- The app keeps browsers headless; the live panel is the visible surface.
  Importing an operator's Chrome profile remains out of scope.

### 3. Watch and take over — implemented, pending release

- Two compact chrome rows: tabs and a top profile button; navigation,
  address, takeover, and overflow below. Profile management and typing/paste
  open on demand. No permanent status dashboard around the page.
- `BrowserLive` proxies only frame/status/tab/URL events. ACKs follow decoded
  rendering, including identical image data. At most one pending frame waits
  for SSE backpressure; slow/disconnected viewers are closed. Default 15 fps.
- `BrowserRuntime` gates **all** browser tool calls and transcript captures
  for the shared session. Takeover first blocks new calls, then drains the
  accepted ones. Human input uses fixed native HTTP commands that await CDP
  completion, not fire-and-forget WebSocket input. Hand-back waits for them.
- A timed-out action has an uncertain outcome. Explicit Restart browser
  closes the native session before recovery; it keeps saved logins. It is
  refused while bots sharing that browser are working.
- Owner/admin-only endpoints use existing authentication, CSRF and session
  revocation checks on desktop and self-hosting alike. Browser frames never
  enter the client-readable global events feed. Native stream ports remain
  loopback-only. Other viewers are hidden during human control.
- Own, shared, and temporary profiles work on the web too. Temporary browsers
  last for one server run, are not saved, and close on deletion/profile exit.
  Profile edits include a stale-list check; deletion removes only that exact
  profile's saved state. Do not use upstream `state clear --all` for this.
- These controls gate OMB's browser tools, not arbitrary host shell access.
  Browser profiles are login separation, **not** OS security sandboxes.

See [the native verification recipe](../verification/browser-live.md).
Recording's `--fps 60` is separate from live streaming and needs ffmpeg;
recording controls are intentionally not added to the live browser chrome.

### 3a. Commit hold and gate owners — implemented

- `BrowserRuntime`'s gate has owner kinds. A **person** (the Browser panel)
  pauses every bot call and the transcript captures. A **hold** pauses only
  the bot's actions: reads and captures go on, one hold per session, and a
  person can still take the browser while it waits. The login vault will add
  a third kind.
- After a person who touched the page hands the browser back, the next bot
  tool result for that session starts with one line telling it to re-read
  the page. A restart clears it.
- `server/browser-commit-gate.ts` sits in the browser MCP route ahead of
  `BrowserRuntime.agentRpc`. For a click, a check, an uncheck, a select, an
  Enter or Space press, or text typed with a line break, the server reads
  the target itself (`server/browser-commit-page.ts`): `get box` for the
  bot's selector, then a fixed script that describes the element in that box
  (in the page, in an open shadow root, or in a frame of its own origin) and
  its form or region.
  Rules in `shared/browser-commit.ts` decide. Only for a commitment does a
  second fixed script read the evidence (fields, the text around the
  element, hashes of what the approval is bound to), then `get url`. Both
  scripts share one prelude and go to the engine on its input (`eval
  --stdin`), never on its command line, so their length is not bounded by
  the longest command line Windows will start. A
  commitment waits on the card and counter that connected-app sends use;
  the approval is bound to a digest of the address, the element's identity
  (its path in the document and a hash of its tag and the attributes that
  say what it does), the text around it with relative times evened out, the
  listed fields at full length, and the page's own salted hash of every
  control of the form or region, hidden ones and frame bodies included.
  After two voids in a row the next card is bound to less (the address, the
  label and the controls) and says so. A
  reload after a commitment is held the same way, for as long as the
  session lives; the flag is in memory, because no per-session state
  survives a restart. The gate's header comment lists every browser tool
  and why it can or cannot commit. User-facing behaviour is in
  [approval levels](../approval-levels.md#sending-on-your-behalf-and-spending-money).
- Values a card must not carry (passwords, card fields, codes, PINs, card
  numbers by the Luhn check) are counted in the page and only their length
  is returned. A page that shows one is not screenshotted. Hold screenshots
  are listed in `browser-hold-shots.json` under the data directory and any
  left listed are deleted at server start (`server/browser-commit-shots.ts`).
- Frames: `<iframe>`, `<frame>`, `<object>` and `<embed>`. One of the
  page's own origin is read like the page, for clicks and for the focus.
  A call that would act inside a frame the script cannot read (Enter or
  Space with the focus in it, a click or typed text aimed at the frame
  element) is refused, and so is Enter or Space with the focus inside a
  closed shadow root. The engine measures an in-frame element from the
  frame's own corner, so a ref click is judged both as the element read in
  that box and as the element the snapshot named. When the box is found
  nowhere and the page has a frame recognised as a payment frame, a
  button-like ref is money; when it matched an element the snapshot names
  differently and it starts within a payment frame's own size, likewise.
- Payment frames, by what a frame calls itself (title, name, id, label).
  One that speaks of a card, a payment or a checkout is a card signal for
  the region around it. One that calls itself a wallet or pay-later brand
  and nothing of paying besides is that brand's frame: only a click inside
  it is money. A word in a frame's address decides nothing, except through
  two short lists of known addresses: processors' hosted card fields (a
  card signal) and brands' buttons (a brand's frame). Each entry is matched
  against the host, and the path where it has one, of the frame's address
  as a browser parses it.
- Enter in a form's field is judged by the form's first submit control
  whatever its enabled state: a page can enable the button between the
  gate's read and its key press. That read-then-press gap remains for
  anything that is not a form's submit control.
- The runtime's own page read around an action (`OBSERVE_PAGE_SCRIPT`,
  "what an action changed") runs inside `agentRpc`, so it runs for every
  call the gate sends (the typed text, the separate Enter, an approved
  click) and for none it holds or refuses: the gate calls `agentRpc` only
  to send. The read before the action sits in the read-then-press gap
  (about 25 ms on agent-browser 0.37.0). After it, `agentRpc` asks the
  route again and checks the session's gate: a call whose request closed,
  a person at the browser, or a commit hold that began meanwhile, and the
  action is not sent. No action reaches the engine under a hold.
- A call the engine lost (`latchLostCall`): `agentRpc` answers the next
  call itself (`answerInterrupted`) and does not run it. The gate asks
  `answerInterrupted` first for every call it judges, and again when its
  first look is refused part-way, because its own reads go through
  `withAgentAction` and are refused while the browser is uncertain. An
  Allow given in that state reads nothing and sends nothing. The ref table
  is in doubt from a lost call until the next snapshot that comes back
  (`refsStale`): the engine numbers its refs anew with every snapshot, seen
  or not, so the gate refuses a judged call by ref until then. A snapshot's
  table is recorded before the route is asked again, so one whose caller
  was gone by the time it answered still updates it. Measured on 0.37.0:
  every snapshot that succeeds carries its ref table, empty on a page with
  nothing to name.
- A card region is a form, or for a control with no form the nearest
  dialog or landmark around it (the page when there is none), that holds a
  `cc-*` autofill hint, or a card-number field beside a security-code or
  expiry field by name, or a Luhn-valid value with a card scheme's prefix
  or beside one of those names, or a payment frame as above. Fields in
  open shadow roots count. Any button-like control there is money, by
  click, Enter or Space; so is an option, a tab or a switch. A search
  skips the send rules only: a money label on its button, or a card region
  around it, still holds.
- A link clicked by a ref the snapshot calls a link, that would be held for
  the snapshot's name, is checked against the engine's own word: `get attr
  <ref> href`. The ref table carries no addresses even with `includeUrls`,
  and the snapshot text that does can be forged by a page. An address that
  goes to another document, or a `#/` route, makes it a plain link.
- Typed text with line breaks. The engine presses Enter for each line feed
  and carriage return, and cannot always give a field the focus (a modal in
  front, a disabled group, an inert or hidden parent): then the text and
  the Enter go to the current focus. And what Enter does at a field can
  change once the text is in (a button disabled until then). So text and
  its Enter never reach the engine in one call. The gate types what lies
  before a line break, reads the page afresh, and judges and presses the
  Enter as a step of its own when the field has the focus; a field the read
  says cannot take the focus gets nothing. Several lines run only into a
  focused multi-line field that is no composer, an Enter at a time, and
  stop at the first that is not a plain new line. A tab stays refused.
- A link's address is read as a browser reads it (tabs and line breaks
  dropped, leading control characters and spaces); `javascript:`, `data:`
  and `vbscript:` are no plain links.
- A multi-line field is the only text field of its form or region when no
  other counts: search fields, and fields in a header, navigation, footer
  or sidebar the field is not itself in, do not.
- The hold is a guard with stated limits, tuned to pass ordinary browsing:
  a plain link is never a commitment by its text; a form with a multi-line
  field and a harmless label, a sign-in form, and "Apply" where nothing is
  attached are not sends; on an English page a form with a multi-line field
  and a label on neither list passes (the unknown-label rule is for pages
  that declare another language, and labels with other letters or none);
  Enter in a multi-line field is a new line unless
  the field is a message composer. `server/browser-commit-ordinary.test.ts`
  is the table of ordinary operations and the outcome each must have, run
  through the real reader and gate. A request-level check on payments is
  planned as separate work; until then a payment behind a neutral label on
  a page with no card signal is not held.
- The page script reads elements through the accessors on their prototype
  chain, because a form control named `tagName` or `elements` shadows the
  form's own property of that name.
- The proxy's per-call limit for the browser is the hold window plus a
  margin, capped by `mcp.callTimeoutMinutes` (`OMB_MCP_CALL_TIMEOUT_MS`).
  The proxy relays with `node:http`, not `fetch`: Node's fetch drops a
  response whose headers have not arrived in 300 seconds, which cut a
  nine-minute hold at five. Each call has its own connection. On
  `notifications/cancelled` the proxy closes the cancelled call's
  connection, and the route ends the hold behind it.
- A hold is released in a `finally`: whatever fails after the browser was
  taken, the browser is free again, the request is forgotten, the
  screenshot is deleted and the card is closed as unavailable.
- Not verified on Windows: the gate's reads use `get box`, `get url`, `get
  attr` and `eval --stdin` from the engine CLI, checked on 0.37.0. The Windows pin is
  `0.36.0-omb.1`. Run the [commit hold recipe](../verification/browser-commit-hold.md)
  there before a Windows release. If a read fails, the click is refused, not
  let through.

### 4. Tool-name adapter — dropped

The engine's `agent_browser_*` names are the vocabulary everywhere now; the
system prompt teaches them. No adapter.

## Not doing

- Bundling Steel, browser-use or Playwright MCP. Power users can add any of
  them as a custom MCP server today.
- Anti-detection, proxies, CAPTCHA solving.

## Comparison (Sep 6, 2026)

| Candidate | Why not |
|---|---|
| Playwright MCP (Microsoft) | Runner-up; a config swap since both are MCP servers. 70+ tools to trim, one client per persistent profile, no stream. |
| Chrome DevTools MCP (Google) | Debug/perf focus, usage statistics to Google by default, no per-bot sessions, no stream. |
| Steel | Live view with takeover, but the self-hosted server runs one session at a time and needs an installed Chrome; a Node/Fastify service with nginx and a UI. |
| Stagehand, browser-use, Skyvern | Agents or model-driven SDKs: a second model loop under our agents. |
| browserless | SSPL / commercial licence. |
| Lightpanda | Not Chrome (partial web compatibility), AGPL. |
