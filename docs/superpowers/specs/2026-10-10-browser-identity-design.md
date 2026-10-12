# Browser Identity: Chrome Paths, Challenge Stop, Commit Hold, Login Vault

## Summary

Bots can browse, but they cannot yet do work on consumer sites as the person.
Four things are missing, and this spec covers all four:

1. **Chrome paths.** A bot can only use the bundled headless browser. It gets
   two more choices: a real installed Chrome with its own saved profile ("Bot
   Chrome"), and the Chrome the person already has open ("My Chrome").
2. **Challenge stop.** When a page is an anti-bot check, the bot keeps poking
   at it. It should stop and hand the browser to the person.
3. **Commit hold.** The "always asks first" rule covers connected-app tools
   with a send verb (`shared/outbound.ts`). A browser click that sends, posts,
   pays or books is not held on any engine. It should be.
4. **Login vault.** There is no saved-password store. PR #246 built one and was
   closed because it typed the password into a browser the bot could read
   (issue #255). This spec replaces the fill step with a broker the bot is
   locked out of.

The four parts share one mechanism, the browser control gate in
`server/browser-runtime.ts` that already pauses a bot while a person holds the
Browser panel. They ship as four PRs, in the order in "Rollout".

Line references are to `origin/main` at `2f85f70e8` (v0.1.105).

## Goals

- A bot can work on a site signed in as the person, on the person's own
  machine, in a real Chrome.
- A bot that is about to send, post, pay or book through the browser is
  stopped and the person is asked, unless the person pre-approved sends for
  that bot. Money always asks. This is a guard against a bot over-acting on
  ordinary pages, not a guarantee: see "Scope decision" under Part 1.
- A saved password never appears in anything a model can read through
  OpenMausBot: tool arguments, tool results, page snapshots, screenshots,
  preview frames, the transcript, logs or memory.
- An anti-bot check ends with the person being asked, not with retries.
- Existing bots keep working unchanged until the person switches them.

## Non-goals

- Anti-detection, proxies, CAPTCHA solving. This stays on the "Not doing" list
  in `docs/plans/browser-engine.md`. Detection only.
- Protecting the vault or saved sessions from a bot that has host shell access.
  Engines run as the same OS user as the server (`docs/self-hosting.md:579`);
  the fix is engines under their own user, which is a separate project.
- Web work done on a computer surface (cloud computer, Local VM, This
  computer). Those turns do not mount the browser tools
  (`server/index.ts:10923`), so none of this applies to them.
- The vault on Cloud homes, in My Chrome, or with entry from a phone.
- SMS codes, email codes and passkeys. The person finishes those.
- Importing or copying the person's everyday Chrome profile or cookies.
- Site-specific skills (Instagram, Marketplace, eBay). Separate work.
- PR #743 (browser extensions) and the parked `feat/action-rules` branch.

## What exists today

- **One chokepoint.** Every bot browser action is an MCP call that the server
  owns: engine → `harness-mcp-proxy browser` → `POST /api/internal/browser/mcp`
  (`server/index.ts:17096-17122`) → `BrowserRuntime.agentRpc`
  (`server/browser-runtime.ts:301-416`) → the `agent-browser mcp` child. 15 of
  18 engine drivers mount it; three have no browser.
- **No approval on it.** Claude and Codex mount the browser tools pre-approved,
  so no card appears at any approval level.
- **The bot can run scripts.** `agent_browser_eval` runs arbitrary JavaScript,
  so it can read cookies, local storage and any input's value.
- **Control gate.** While a person holds the Browser panel, every bot
  `tools/call` is refused and preview-frame capture stops
  (`server/browser-runtime.ts:284-299`, `420-474`). After hand-back the bot is
  told nothing.
- **Sessions.** Cookies and local storage are saved through the engine's
  restore feature to `~/.agent-browser/sessions/*.json.enc`, keyed by
  `$OMB_DATA_DIR/browser-engine-key` (`server/browser-engine.ts:428-506`).
- **Attach.** `browserEngine.attachCdpUrl` attaches every bot to one external
  Chrome. It is global, has no UI and no user docs (`server/config.ts:97-106`).
- **Engine capabilities.** The pinned `agent-browser` 0.37.0 supports
  `--executable-path`, `--profile <dir>`, `--auto-connect`, `cookies`, `state`
  and `auth login`. Windows is pinned to `0.36.0-omb.1`
  (`server/browser-engine-release.ts:6`).

## Shared mechanics

### Gate owners

The control gate gains an owner kind. Today the only owner is a person.

| Owner | Bot actions | Bot reads | Preview frames | Used by |
|---|---|---|---|---|
| `person` | refused | refused | stopped | Browser panel take-over (today) |
| `vault` | refused | refused | stopped, viewers see a placeholder | Vault sign-in |
| `hold` | refused | allowed | allowed | A pending commit hold |

`person` can always take the gate from `hold`. Nothing takes it from `vault`
except the broker finishing or timing out.

### Hand-back note

When a `person` or `vault` owner releases the gate after at least one input was
relayed, the next browser tool result for that session starts with one line:

> The person used this browser and handed it back. Re-read the page before
> continuing.

`BrowserRuntime` keeps the flag per session and clears it once delivered.

### Asking the person for help

The computer capability already has a help request with a takeover
notification (`server/index.ts:19462-19487`). The same request is added for the
browser capability: a notification, the bot set to "waiting on you", and a
banner in the Browser panel. It is rate-limited per session and host to once
per 10 minutes.

## Part 1: Commit hold

### Where

A new module, `server/browser-commit-gate.ts`, called from the browser MCP
route before `BrowserRuntime.agentRpc`. The classifier and word lists live in
`shared/browser-commit.ts` so the desktop can label cards the same way.

### What counts as a commitment

Clicks, checks, unchecks, selections, Enter/Space key presses and typed line
breaks can commit. Reloads after an earlier commitment are held too. The
reviewed rules below supersede the initial click/Enter-only design; for each
judged target the gate describes it before deciding:

- **Label and role.** For an `@eN` ref, from the snapshot text the server last
  returned to this bot for this session; the gate now retains that text per
  session. For a CSS selector, from a fixed, server-owned read of the element.
- **Form.** A fixed, server-owned read returns the enclosing form's visible
  fields: name, type and value for text fields, length only for password
  fields, and whether any field is a card field (`autocomplete="cc-*"`).
- **Address.** `agent_browser_get_url`, called by the server.

A call is a commitment when any of these holds:

| Rule | Class |
|---|---|
| Label matches the Send list: send, reply, post, publish, comment, share, message, submit, invite, apply, list item | Send |
| Label matches the Money list: pay, buy, place order, checkout, bid, book, reserve, subscribe, donate, transfer | Money |
| The form has a card field | Money |
| Enter pressed while focus is in a message or comment box (multi-line or `contenteditable` textbox, not a `searchbox`) | Send |
| A submit control on a form that contains a multi-line text field (`textarea` or `contenteditable`), whatever its label | Send |

Matching is case-insensitive on whole words. The lists are English in the first
version; the last rule is the fallback for other languages. Money wins when
both classes match.

Search is never a commitment: a form with `role="search"`, or whose only text
field is a `searchbox` or `input[type=search]`, is skipped by every Send rule.

`fill`, `type`, `scroll`, `open` and every read tool never commit.

### Scripts

`agent_browser_eval` is checked before dispatch. A script is refused when its
text contains a click or submit call, a network send (`fetch`,
`XMLHttpRequest`, `sendBeacon`, `WebSocket`), a write to a field value, an
event dispatch, or a navigation. The bot is told to use the click and fill
tools. This is a guard against over-action. It is not a wall: a bot that
deliberately obfuscates a script can get past a text check, and the docs say
so.

### Hold lifecycle

1. The gate computes a digest of the address (without fragment), the target's
   label and role, and the form's field names and values.
2. Policy check (below). If the call is allowed, it dispatches normally.
3. Otherwise the session's gate owner becomes `hold`, and the server posts an
   options card to the thread: "Send on your behalf?" or "Spend money?". The
   card carries two things:
   - `outboundRequest { tool, app, calls }`, the marker connector holds already
     set, with the host as `app` and the button label as the call. Every rule
     written for sends then applies to a browser hold unchanged, including
     the messaging rule in PR #2398 that a send is never approved by
     "approve for me".
   - `browserCommit { class, host, label, fields, shot }`, where `shot` is a
     screenshot the server takes itself.

   The card's plain subtitle repeats host, label and field text, so a client
   that does not know `browserCommit` still shows enough to decide.
4. The call waits inside the HTTP request, as the connector hold does
   (`server/index.ts:19357-19410`), for the same window.
5. **Approve.** The gate recomputes the digest. If it is unchanged, the server
   dispatches the original call and returns its result. If it changed, the
   approval is void, the card settles as "page changed", and a new card is
   raised for the new state.
6. **Deny.** The bot gets an error telling it not to retry and to ask what the
   person wants instead.
7. **Timeout or restart.** The card settles as expired or unavailable, and the
   bot is told the request was not answered.

A person can take over the browser while a hold is pending. The hold stays
pending, and anything the person changes on the page is caught by the digest
check on approval.

The stdio proxy cuts browser calls at 130 s (`server/harness-mcp-proxy.ts:83`).
For the browser kind that limit is raised to the hold window plus a margin,
capped by the configured MCP call timeout. PR #2398 already makes this limit
depend on the kind (700 s for Inkbox) in the same line, so whichever lands
second rebases onto the other. The 120 s engine request timeout is
unaffected, because it starts only after dispatch.

### Policy

The per-bot setting that governs connector sends, `bot.outbound { policy,
dailyCap }` (`shared/wire.ts:338`), now covers browser sends too:

- `ask` (default): every Send asks.
- `allow`: a Send spends from the same daily counter
  (`server/outbound-counts.ts`) and dispatches without a card until the cap is
  reached, then asks.
- Money ignores the policy and always asks.

The Permissions section copy changes from connected apps to "sends on your
behalf, in connected apps and in the browser".

### Records

Each hold and its answer writes a decision-log row and an activity row, with
class, host and label. Field text is stored through the existing redaction
(`shared/redact.ts`).

### Known limits

- On chat runtimes below Full access, a commit click shows the engine's own
  tool card and then the hold card. The hold card is the one with evidence, so
  it stays.
- A person's own clicks during take-over are never held.

### Scope decision (2026-10-11)

Two rounds of independent review, run against the real engine, each found ways
a send or payment could pass with no card, and found that the rules written to
close them raised cards on ordinary browsing. The hold predicts, from the
thing a bot acts on, whether the action will send or pay. That prediction will
always miss some shapes and over-ask on others.

The product owner decided:

- **Part 1 ships as a guard with stated limits.** The docs say so in plain
  words and list the limits.
- **Ordinary browsing must not raise cards.** A plain link is never a
  commitment by its text. Harmless labels (save, update, apply on filters,
  next, continue, search, sign in) pass outside a card region. A sign-in form
  is never a Send. Enter in a multi-line field is a new line unless the field
  is a message composer.
- **A card region is strict.** In a form or region that holds card signals
  (the autofill hints, a card-number field with a security-code or expiry
  field, a card number value, or a hosted payment frame), any activation of a
  button-like control is Money, whatever its type or label.
- **"Money always asks" gets a second mechanism, as its own PR** (Part 1b
  below). Until it lands, the promise for money rests on the guard.

### What Part 1 does after review (2026-10-11)

The branch went through seven rounds of fixes, each checked by an independent
reviewer driving the real engine. Its final pass found nothing that must be
fixed before the hold ships as a guard. Where this section and anything above
disagree, this section is right. The branch's `docs/approval-levels.md`
carries the full list of limits.

- **Every tool that can activate something is judged:** click, check,
  uncheck, select, a key press (Enter and Space, in any chord position), and
  typed text. Scripts that would click, submit, send, write a field or
  navigate are refused.
- **Typed text and its Enter never reach the engine in one call.** The gate
  types the text, reads the page afresh, then judges and presses Enter on its
  own. A field that cannot take the focus gets nothing typed.
- **A card region is strict.** It is a form, or the nearest region, holding
  card signals: the autofill hints, a card-number field with a security-code
  or expiry field, a card number value with a scheme's first digits, card
  fields inside a web component, or a frame that speaks of a card, a payment
  or a checkout. Inside it any button-like control is Money, and Enter is
  judged by the form's submit control whether or not it is enabled.
- **A wallet or pay-later brand's own frame is not a card signal** for the
  page around it. A click inside any payment frame is Money. A word that
  appears only in a frame's address decides nothing; known hosts are matched
  by host and path.
- **Ordinary browsing passes.** A plain link, a same-page link and an in-app
  route are never held for their text. Harmless labels, sign-in forms and
  search pass outside a card region. Enter in a multi-line field is a new line
  unless the field is a message composer. The unknown-label fallback applies
  only on a page that is not in English.
- **What is approved is what is sent.** The approval is bound to the
  element's identity, the text around it, and every control of its form or
  region, including hidden ones, tick boxes and readable frames. If any
  changed, it asks again; the third card in a row binds to less and says so.
- **After a commitment, every reload in that session asks.**
- **Secrets.** Passwords, card numbers, security codes, one-time codes, keys
  and recovery phrases are length-only on the card. No screenshot is taken
  when the page shows one. The card lists only the target's own form.
- **Lifecycle.** A hold ends with its call, releases in every failure path,
  and the proxy waits the full window (the five-minute cutoff was a client
  header timeout).

**The limits that matter most**, in the reviewer's order:

1. A payment behind a neutral button with no card signal on the page: a saved
   card's "Confirm", or a button beside a wallet frame. Part 1b is aimed at
   this.
2. A send the rules do not recognise: a message box that shares its region
   with other text fields, or an English label the lists do not know.
3. Friction: buttons that only open something but carry a list word still
   ask.

**Not verified:** Windows (the engine pin there is older, and the reads use
`get box`, `get url`, `get attr` and `eval --stdin`), real sites and real
payment frames (frame recognition was tested on local markup and the host
lists are from memory), and the card in the running desktop app.

### Part 1b: Payment backstop (planned, not yet designed in detail)

A check on the browser's outgoing requests, independent of what the bot
clicked. The server attaches its own session to the bot's browser, watches
requests to known payment processors' charge and confirm endpoints (Stripe,
PayPal, Adyen, Braintree, Checkout.com, Square, Razorpay, Shop Pay and
similar), and refuses one unless a Money approval was given in that session
moments before. It covers hosted card frames, script-driven buttons and any
action the click rules did not foresee, for the processors on its list. It
does not cover a merchant that charges through its own endpoint.

Checks before designing it: the pinned engine exposes the browser's debugging
address to the server (`get cdp-url`); a second session can attach beside the
engine's; requests can be paused by host pattern without slowing other
traffic; frames on other origins are covered; the same holds on the Windows
pin. It gets its own spec section and plan before any code.

### Amendments from the engine probes

Checks 9 and 10 were run on 2026-10-10 against agent-browser 0.37.0 while the
plan for this part was written
(`docs/superpowers/plans/2026-10-10-browser-commit-hold.md`). These are historical
findings: the later “What Part 1 does after review (2026-10-11)” section above
supersedes them, including typed line breaks, Space and frame handling.

- **Typed line breaks.** `agent_browser_type` types `"\n"` as a real Enter
  press. A `type` call whose text holds a line break is refused where that
  Enter would commit, and the bot is told to fill, then press Enter
  separately.
- **Enter in a one-line field** submits its form, so it is judged as that
  form's submit control. Shift+Enter in a message box passes.
- **Label rules skip** text boxes and toggle or selection roles (a tab called
  "Message", a checkbox "Subscribe"). Clicking them commits nothing.
- **A card field makes a form Money only when the call submits that form.**
  Focusing or filling the field does not.
- **The target is read from the engine, not from snapshot text.** Snapshot
  text is controlled by the page. `BrowserRuntime` keeps the engine's own ref
  table, and the gate reads the element with the engine CLI (`get box`, then
  one fixed script). A click is held if either the ref-table name or the page
  label matches.
- **Card numbers and security codes are length-only** on the card, like
  passwords. Snapshots show them in clear.
- **When the page cannot be read at all**, the click is refused, not sent.
  Elements inside a frame fall back to the ref-table label.
- **A hold ends when its call ends.** If the turn stops or the proxy limit
  passes, the card closes and the browser is freed. One hold per session.
- **"Page changed"** is recorded as an unavailable, dismissed card with
  `browserCommit.pageChanged`. The screenshot is an attachment, deleted when
  the card settles.
- **At the daily cap** a browser send asks, as written above. A connector send
  is refused at the cap today; the docs state both.
- **Not held, stated as limits:** Space on a focused submit button, Enter
  inside a frame, and a one-line box outside any form that sends on Enter.
- **Windows.** The current reads use `get box`, `get url`, `get attr` and
  `eval --stdin`. They were run
  on 0.37.0 only; the Windows pin is `0.36.0-omb.1`, whose upstream README
  documents the first two. If any is missing there, every bot click and Enter
  is refused, so the verification recipe must pass on Windows before a
  Windows release.

## Part 2: Challenge stop

- `server/bot-block.ts` and `server/bot-block.test.ts` are taken unchanged from
  `origin/feat/parity-round-1` (PR #422): 19 address and title signatures, with
  the three low-confidence ones ignored.
- **Hook.** After a bot call that can change the page (`open`, `back`,
  `forward`, `reload`, `tab_new`, `tab_switch`, and `click` or `press` when the
  address changed), the server reads the address and title and runs the
  detector. `BrowserRuntime` keeps the last address per session to tell.
- **On a match.** The tool result is replaced by an error: the page is an
  anti-bot check from the named family on the named host, do not retry it or
  try to solve it, the person has been asked. The server raises the browser
  help request from "Shared mechanics".
- **After.** The person passes the check in the Browser panel and hands back.
  The hand-back note tells the bot to re-read the page.
- The rest of PR #422 is not ported. Main already trims tool output
  (`server/browser-tool-shape.ts`, `server/mcp-trim.ts`) and keeps an activity
  log (`server/activity.ts`), and the file the PR hooked into
  (`server/computer-proxy.ts`) was deleted in `17892c0f6`.

## Part 3: Chrome paths

### Setting

`bot.browserKind?: "builtin" | "bot-chrome" | "my-chrome"`, absent meaning
`builtin`. It sits beside `bot.browserProfile`, which keeps its meaning (the
bot's own session, a shared named profile, or `guest`). It is set through the
bot PATCH under the same busy and take-over checks as `browserProfile`
(`server/index.ts:22003-22022`).

The selector lives where profiles are chosen today, in the Browser panel
(`src/components/BrowserPanel.tsx`), with one line of explanation per choice.

### Bot Chrome

- **Locating Chrome.** A new `server/chrome-locate.ts` finds Google Chrome in
  its standard install paths on macOS, Windows and Linux. Google Chrome only in
  the first version. When none is found the choice is disabled with a reason.
- **Launch.** The browser spec adds `AGENT_BROWSER_EXECUTABLE_PATH` and
  `AGENT_BROWSER_PROFILE=<dir>`, and drops the restore variables, because the
  profile folder persists everything. It stays headless, so the Browser panel
  remains the only view.
- **Profile folders.** `$OMB_DATA_DIR/browser-profiles/<sha256(session)>/`,
  mode 0700, one per session id, so shared named profiles and per-bot sessions
  map to folders the way they map to restore keys today. `guest` uses a
  temporary folder removed on close. Deleting a profile deletes its folder
  through the existing durable journal.
- **Chrome's own password features are off.** Before first launch the profile
  is seeded so that password saving, password autofill, and address and card
  autofill are disabled. The vault refuses to sign in to a profile where they
  are on.
- **Defaults.** New bots get `bot-chrome` when Chrome is found. Existing bots
  stay on `builtin`.
- **Switching an existing bot.** A "Switch to Bot Chrome" action starts the new
  profile once with the old restore key loaded read-only, so saved sign-ins
  carry over. The old state file is deleted only after that launch succeeds. If
  it fails, the bot stays on `builtin` and nothing is deleted.

### My Chrome

- **Setup.** The person turns on remote debugging in their Chrome once. The
  panel shows the steps and a "Test connection" button
  (`POST /api/bots/:id/browser/test-attach`). Chrome shows its own permission
  prompt on connect and its own banner while controlled.
- **Launch.** The spec uses the engine's auto-connect option and reuses the
  existing attach behaviour: OpenMausBot does not force the viewport and does
  not own the browser's lifecycle.
- **Rules.**
  - The bot starts in a tab it opens. It never uses the tab the person has in
    front.
  - Ending a session closes only tabs the session opened. It never quits
    Chrome.
  - No restore key and no state save. The person's everyday cookies are never
    written into OpenMausBot's data.
  - One thread at a time, through `claimTurnResource("browser:my-chrome")`.
  - The commit hold and the challenge stop apply. The vault does not.
- **Availability.** Desktop app with the server on the same machine. Not
  offered on Cloud homes, Docker or headless servers.
- **When it cannot connect.** The bot gets a clear error and the person gets
  the browser help request.
- The global `browserEngine.attachCdpUrl` keeps working as it does today for
  `builtin` bots. A per-bot kind takes precedence over it.

## Part 4: Login vault

### Promise and boundary

A saved password, and an authenticator seed, exist in clear only inside
Electron main and inside the browser engine process that types them. They never
enter the server process, so they cannot reach the transcript, the event bus,
logs or memory by construction. The bot is locked out of the browser from
before the password is typed until every password field is verified empty.

After sign-in the bot holds a signed-in session and can read its cookies. That
is intended: the bot gets the session, never the password.

### Storage and settings (from PR #246)

Taken from `origin/feat/credential-vault` and brought up to main's current
Electron module conventions:

- `electron/vault.cjs`: entries encrypted with `safeStorage` into
  `userData/vault.bin` (0600), `list()` returning metadata only, `reveal()`
  behind Touch ID or Windows Hello, `matchForFill` requiring an exact origin
  and an allowed bot.
- `electron/totp.cjs`: RFC 6238 codes generated in main.
- `electron/vault-bridge.cjs` and `server/vault-client.ts`: a token-guarded
  loopback channel on which the server can only make requests and receive
  outcomes.
- `src/components/VaultSection.tsx`: the Settings screen.

Changes:

- An entry is `{ origin, loginUrl, username, secret, totpSeed?, allowedBots,
  askEveryFill, approvedBots, selectors? }`. `contexts: vm | box` is removed.
- `electron/vault-fill-cua.cjs`, `electron/vault-fill-box.cjs` and the "Test
  fill" control are dropped.
- The bridge no longer accepts an approval from the caller that requested it.
- Linux is supported only when `safeStorage` has a real keyring. The
  `basic_text` backend is rejected, as the cloud-account store already does
  (`electron/main.mjs:1023`).

### Sign-in flow

A new tool, `sign_in`, is added to the browser MCP surface beside
`restart_browser` (`server/browser-runtime.ts:14-19`). It takes an optional
`site` hint. The Browser panel gets a "Sign in with saved login" action that
runs the same flow.

1. **Match.** The server sends main the bot id and a candidate origin: the hint
   if given, otherwise the current page's origin as the server reads it. Main
   answers `no-match`, `needs-approval` or `ready`, with a one-time ticket.
   Several usernames for one origin is `needs-approval` with a choice.
2. **Approval.** Needed when `askEveryFill` is on or the bot is not yet in
   `approvedBots`. The server posts a `vault-signin` card: "Sign in to
   <origin> as <username>?". The desktop's Approve button calls main directly
   over the preload channel, the way Full access is granted
   (`electron/main.mjs:3442`). Phones show the card with "Approve on your
   computer".
3. **Lock.** The gate owner becomes `vault`.
4. **Fresh tab.** The server opens a new tab at the entry's `loginUrl`, and
   reloads any other open tab on the same site, which discards scripts the bot
   left running there.
5. **Origin check.** Main reads the tab's address through its own engine call
   and requires an exact match with the entry's origin. A mismatch ends the run
   as `failed`.
6. **Typing.** Main drives the engine CLI against the same session and feeds
   the username, password and authenticator code on standard input, never in
   arguments or environment. Main discards the CLI's output. It handles
   one-page and two-step (username, then password) forms.
7. **Verify and clear.** A fixed read counts password fields that still hold a
   value, in every frame. Any that do are cleared.
8. **Unlock.** The gate is released, the hand-back note is set, and the bot
   receives the outcome.

The `sign_in` call waits for approval for the same window as a commit hold. The
broker run after approval is capped at 90 s.

| Outcome | Bot is told | Person sees |
|---|---|---|
| `signed-in` | Signed in to the site as the username | Nothing |
| `needs-person` | Sign-in needs the person; wait | Browser help request to finish a code, passkey, CAPTCHA or unknown form |
| `failed` | Sign-in failed; do not retry | A notification naming the site |
| `no-match` | No saved login; ask the person | A card: "Open Vault" or "I'll sign in myself" |
| `denied` | The person declined | Nothing |

There is no automatic retry after `failed`, to avoid account lockouts.

Every attempt writes a decision-log row: origin, username, bot, outcome. Never
the secret.

### Why the bot cannot read it

- Its browser tools, including `eval` and `screenshot`, are refused for the
  whole run.
- The login page is a fresh document in a fresh tab, so nothing the bot ran
  earlier is on it, and other tabs on the site were reloaded.
- Chrome keeps no second copy, because its own password saving is off.
- Password fields are empty before the gate opens.

## Checks before building

Each check is a short, throwaway probe whose answer can change the plan.

1. `--auto-connect` attaches to an everyday Chrome on macOS with the pinned
   engine, and what the person has to enable.
2. The Windows pin `0.36.0-omb.1` has `--executable-path`, `--profile` and
   `--auto-connect`. If not, bump the pin first.
3. Headless real Chrome streams to the Browser panel.
4. Attach mode writes no session file, and `close` neither quits Chrome nor
   closes tabs the session did not open.
5. Google sign-in accepts Bot Chrome.
6. How cookies are protected at rest in a Bot Chrome profile folder, compared
   with today's encrypted state file. If it is weaker, the docs say so.
7. `--profile` and a restore key can be combined for the one-time carry-over.
8. The bot's tool set cannot register a script that runs on every new page and
   cannot widen itself (`agent_browser_tools_profiles`, stripped arguments in
   `server/browser-tool-shape.ts:21-24`).
9. An `@eN` ref can be resolved to its element for the form read. If not, the
   gate matches by label and role.
10. Whether snapshots include input values, and password values in particular.
11. Main can drive a session the server's MCP child already holds, and whether
    the engine's `auth login --credential-provider` is a better typing path
    than `batch` on standard input.

## Tests

- **Classifier** (`shared/browser-commit.test.ts`): a table of labels, roles
  and forms for Send, Money and neither; Enter in a message box against a
  search box; the script text check.
- **Commit gate** (`server/browser-commit-gate.test.ts`): ask, allow with cap,
  cap reached, Money under `allow`, approve with an unchanged page, approve
  after the page changed, deny, timeout, person take-over during a hold.
- **Challenge stop:** the detector tests from PR #422, plus a route test that a
  matching address replaces the result and raises one help request per window.
- **Gate owners and hand-back note** (`server/browser-runtime.test.ts`).
- **Chrome paths:** spec construction for each kind in
  `server/browser-engine.test.ts` (no restore variables for `bot-chrome` and
  `my-chrome`; attach never read from the ambient environment); Chrome location
  per platform; carry-over success and failure.
- **Vault:** the node tests from PR #246, plus the flow with a fake engine:
  every outcome, origin mismatch, approval that the server tries to self-grant,
  gate held until fields are empty.
- **Manual run on a side-by-side build**, with real accounts: Google,
  Instagram, Facebook Marketplace and eBay, each for sign-in by hand, sign-in
  from the vault, a held send, and a challenge.

## Rollout

Four PRs against main, each shippable alone:

1. **Commit hold**, with the gate owner kinds and the hand-back note.
2. **Challenge stop**, with the browser help request.
3. **Chrome paths.**
4. **Login vault.**

The hold lands before My Chrome because My Chrome puts the bot in the person's
real profile. The payment backstop (Part 1b) lands before My Chrome too,
for the same reason.

User docs to update with each PR: `docs/approval-levels.md`,
`apps/docs/content/docs/security/permissions-and-secrets.mdx` (which says the
app "does not add a website-password vault"), the browser pages, and
`docs/plans/browser-engine.md`.

Phone apps live in `mausbot-mobile` and follow separately. None of it blocks
the desktop PRs: the hold card is answerable on phones as it is, and later work
shows its screenshot, the "approve on your computer" state for vault cards, and
the browser kind.

## Open housekeeping

These are maintainers' decisions, listed so they are not lost:

- PR #422 can be closed with a pointer once PR 2 lands.
- Issue #255 is answered by Part 4. A contributor asked on 2026-10-02 to pick
  it up and has had no reply.
