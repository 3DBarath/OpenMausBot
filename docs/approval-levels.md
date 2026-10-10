# Approval levels

Approval levels belong to a bot and apply to its next provider turn, including
when that provider resumes an existing native thread. Each level is one of the
provider's own permission modes, passed through. OpenMausBot does not judge an
action itself: there is no app-side allowlist, classifier, or pattern rule. A
native tool request that reaches you is one the provider left for you. In Full
Access, OMB also applies its own configuration tools without another approval.

There is one exception, and it holds at every level: anything that sends on
your behalf or spends money asks first. See
[Sending on your behalf and spending money](#sending-on-your-behalf-and-spending-money).

| Level | Behavior |
| --- | --- |
| **Ask for approval** | Requests approval for commands and file changes, the way the provider's supervised mode does. |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval. Offered where the provider has such a mode (Claude, Grok, Antigravity). |
| **Approve for me** | Uses the provider's automatic review on Codex, Claude, Cursor, and Grok to approve routine actions and ask about others. Providers without an equivalent fall back to asking. |
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Residual native permission prompts are answered for you. OMB profile changes, routine actions, team setup, bot deletion, and enabled skill authoring apply without a second approval. Peer-review prompts are skipped within the bot's authorized scope. Delegation uses the receiving bot's setting, never the sender's — except from a Chief of Staff, whose level flows down (below). Actual questions and missing credentials still need your input. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access is an elevated-risk standing approval. Full and Custom can only be
enabled from a packaged local desktop app, where the choice crosses a private
process channel rather than the bot-accessible HTTP API. They are hidden in
development, standalone web, and remote pages. Full access does not bypass operating
system privacy controls, authentication, CAPTCHA or MFA, service permissions,
or workspace/team ownership and computer-sharing grants. Full Access controls
approval prompts; it does not sign in for you, enable a feature you disabled,
or grant another bot access to a different workspace.

The effective setting belongs to the source conversation. An existing Ask
thread remains Ask even if the bot default is Full; a Full thread works without
these extra prompts even if the bot default is Ask. Ask, Auto, and Custom retain
their existing OMB configuration review cards. Full actions return an applied
result and leave a settled receipt, so the bot continues in the same turn.
Invalid input, unavailable services, or failed writes return errors, not a
request to approve again. An expired native permission request is not turned
into another Allow/Deny card.

A turn a webhook, a routine, or another bot started runs in the bot's level
like any other turn. The decision log records that nobody was at the keyboard
when such a turn asked.

### A Chief of Staff's level covers the work it delegates

Approvals were where a team's owner spent their day: every teammate a Chief
brought in started at "Ask for approval", so the owner either answered a card
every few minutes or switched each new thread by hand. So **a Chief of Staff's
level flows down**. Work it delegates — `coordinate_bots` into a teammate's
thread, and `delegate_bot` — starts at the level of the Chief conversation it
came from: Auto-accept edits, Approve for me, or Full access. The delegated
thread is switched to that level, keeps it, and opens with a line saying so
("Approve for me — delegated by Clive, a Chief of Staff on Approve for me");
you can still change it in that thread. Work a Chief hands out inside a room
runs at the Chief's level for that turn.

It only ever raises: a teammate already on a higher level keeps it, a teammate
on Custom keeps its own configuration, and a Chief delegating from an Ask
conversation passes nothing on. A teammate's engine caps the level: one without
Full access gets Approve for me, and one without Auto-accept edits (Codex,
whose Ask already writes the workspace) stays on its own level. The teammate's
own default and its other conversations do not change, and an ordinary bot's
delegation still uses the recipient's setting. Questions and missing
credentials still reach you.

## Answering a request

Approve or deny requests in the conversation to let the bot continue. **Allow
once** answers this request only. **Always allow this session** hands the
provider its own remembered approval: Claude receives its suggested permission
rules, and ACP agents such as Grok receive their `allow_always` option, or the
driver repeats your answer for that exact operation until the native session
ends. OpenMausBot keeps no standing grant for a provider's tool. It is not
offered for computer control or for a sandbox change.

Auto-accept edits and Ask card whatever the provider asks about. Approve for
me cards whatever the provider's reviewer leaves for you, with the note "The
provider requires your approval for this action." A sandbox widening is held
in every level but Full.

### When the native reviewer never starts

Claude Code accepts `--permission-mode auto` for every model and, when auto
mode is unavailable to the session, starts in Manual without an error. On
Claude Code 2.1.266 that is the case for Claude Haiku 4.5 and Sonnet 4.5,
and for any organization that set `disableAutoMode`. In that session the bot
asks before each action. The Claude driver reads the mode the session actually
runs in from the CLI's `init` frame; when Approve for me was requested and the
session runs Manual, the chat shows one notice per session naming the model.
Choose a model the reviewer supports, Auto-accept edits, or Full access to
stop the prompts.

### Antigravity: Ask, Edits, or Auto (full access)

For Antigravity, the composer and bot settings offer **Ask for approval**,
**Auto-accept edits** (its native `auto_edit` mode), and **Auto (full access)**.
Auto enables native `yolo` mode and automatically approves remaining
tool-permission requests for commands, edits, and computer actions, without an
automatic reviewer. The composer chip reads **Auto**. This uses the existing
Full access grant and confirmation, not a separate permission setting, and
applies to every model in that Antigravity instance, including Gemini.

Choose Auto explicitly in the local packaged desktop app. Old Antigravity
`auto` / `autoApprove` settings still behave as Ask and are displayed as Ask;
they never become unrestricted access on upgrade. Switching back to Ask
restores prompts on the next turn. Questions and missing-credential forms
still require an answer. A Chief or
teammate can delegate work to this bot without downgrading its explicit Auto
(full access) grant. It does not enable Auto on any other bot.

## Sending on your behalf and spending money

Two kinds of action ask first at every level, Full access included, because
the cost of a wrong one is paid by someone who never saw the bot:

- **Connected-app calls that send**: an email, a reply, a post, an invite, a
  refund, a charge.
- **Clicks in the bot's built-in browser that send or pay.** The browser
  tools are otherwise pre-approved on every engine, so without this a bot
  could post or pay with no card at any level.

Both raise the same card with **Allow** and **Deny**: "Send on your behalf?",
or "Spend money?". Both follow the bot's **Sending on your behalf** setting
under Permissions.

| Setting | Sends | Money in the browser |
| --- | --- | --- |
| **Ask every time** (default) | Every send waits for your answer. | Always asks. |
| **Allow a daily amount** | Sends go out on their own up to the daily number, counted together across connected apps and the browser. Past it, a connected-app send is refused until the next day and a browser send asks. | Always asks. |

### What counts in the browser

Fixed rules in the server decide, not the bot and not a model. A click, an
Enter key press, ticking or unticking a box, choosing from a list, and a
reload can count. Filling a field, scrolling, opening a page and every kind
of reading never ask. When the server cannot tell what a call would act on,
it refuses the call or asks. It never lets it through unseen.

| What the bot does | Held as |
| --- | --- |
| Clicks a button, link or menu item whose label has one of: send, reply, post, publish, comment, share, message, submit, invite, apply, list item | Send |
| Clicks one whose label has one of: pay, buy, place order, checkout, bid, book, reserve, subscribe, donate, transfer | Money |
| Submits a form that has a card field | Money |
| Presses Enter in a message or comment box | Send |
| Submits a form that has a multi-line text field, whatever its button says | Send |
| Reloads the page after one of the above went through | The same as that one |

Labels match whole words in any letter case, in English: "Post reply"
matches, "Posts" and "Repost" do not. The multi-line row is what catches a
send on a page in another language. Money wins when both match. A click that
only puts the cursor in a text box, or ticks a checkbox, is never held.
**Search is never a send**: a search field, anything inside a search region,
or a form whose only text field is a search field.

What counts as submitting a form:

- A click on its submit button, including an image button and a button tied
  to the form from outside it.
- **Enter** while the focus is on any of its controls except a multi-line
  box: a one-line field, but also a checkbox, a radio button, a list or a
  slider. It is judged as the form's first submit button. Enter with any
  other key held (`Control+Enter`, `Enter+Alt`, in either order) is still
  Enter. Shift+Enter is a new line only in a multi-line box, and only as
  Shift and Enter alone.
- Ticking a box or choosing from a list (`agent_browser_check`,
  `agent_browser_uncheck`, `agent_browser_select`) when that control, or its
  form, carries a handler written on the element (`onchange="…submit()"`)
  that submits. These three tools are otherwise judged exactly like a click
  on the same element: the engine's check and uncheck click whatever they
  are pointed at, a Send button included.

**Reload.** Reloading a page that a form was posted to posts it again. After
a send or a payment has gone through in a browser (approved by you, or let
through by the daily allowance), a reload there asks with the same card
until the bot has opened another address. Going back or forward, or
switching tabs, turns that on again, because the posted page may be in front
once more. This asks more often than strictly needed, for instance after a
site redirected.

**Selectors.** The server reads the same element the engine would act on.
Where two elements share one box, the one a click at its centre lands on is
judged; where that cannot be told, all of them are, and the card shows the
most serious. A selector with stray white space around it is tidied, and the
tidied one is what is sent. A selector over 2,000 characters, or one that
starts with a dash, is refused: the bot is told to use a ref from a snapshot.
An element the engine finds but the server cannot describe (it is inside a
frame, or has no area) is judged by the name the last snapshot gave it, and
refused when it has none.

### What the card shows

The site, the button's label, the text of the row, list item, card or dialog
the button is in (so you can tell which "Buy now" it is), and the form's
visible fields as they are right now. On a page with no form, the filled
fields of the dialog or region around the button stand in for the form's, or
those of the whole page when there is no such region. The card shows the
first twelve fields and the first 200 characters of each. It says when a
value was shortened, with its full length, and how many fields it left out.
Text that looks like a credential is masked, and so is a card number written
inside other text.

**Values the card never carries.** Some values are counted inside the page
and never leave it: the card, the notification and both logs say only how
long each is ("16 characters, not shown"). The server's own script does read
them in the page, to count them and to test for a card number. It sends back
the length and nothing else. These are:

- a password field, and a field whose autofill type is a current or new
  password, a one-time code, or anything of a card (`cc-number`, `cc-csc`,
  `cc-exp`, `cc-name` and the rest);
- a one-line field whose name, id, label or placeholder says it is a card
  number, a security code (CVC, CVV), a one-time or verification code, a
  PIN, a password or a passcode. A password shown as plain text is still one;
- any value that is 13 to 19 digits and passes the card-number check (Luhn),
  whatever the field is called.

A multi-line message is never hidden for its label, because it is what you
are asked to approve. "PIN code" and "Pincode" are read as a postal code.

**The picture.** While the card is open it also shows a screenshot the
server takes itself, removed once the card is answered. No screenshot is
taken when the page shows any of the fields above, anywhere on it, or a
payment or sign-in frame from another site that cannot be looked into, or
when the page could not be read at all: the picture would show what the card
masks. The card says so. A screenshot left by a server that stopped while a
card was open is deleted the next time the server starts.

**An approval covers what you were shown, and everything that goes with it.**
It is bound to the address, to the element itself (where it sits in the page
and its own markup), to the text around it, and to every field at full
length, including the fields and the text the card had no room for. When you
answer, the bot's selector is resolved again. If it now points at another
element, or any of the rest changed, nothing is clicked, the card says the
page changed, and a new card is raised for the page as it is. If the bot's
request has gone away by then, nothing is clicked either.

The bot's call waits up to nine minutes, the same as a connected-app send, or
up to the configured MCP call timeout when that is shorter. Then the card
closes and the bot is told nobody answered. On Deny the bot is told not to
retry and to ask you what you want instead. Each hold and each answer is in
the bot's activity log and the decision log, with the site and the label.

While a card is open the bot can still read that browser but cannot act in
it. You can use the browser yourself at any time, and your own clicks are
never held. When you hand it back after touching the page, the bot's next
browser result starts with a line telling it to re-read the page.

### Page scripts

A bot can run a script in the page (`agent_browser_eval`). A script is
refused, not held, when its text clicks or submits something, sends a network
request (`fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`), writes into a
field, dispatches an event, or navigates. The bot is told to use the click
and fill tools, which the rules above cover. A line break typed with
`agent_browser_type` is a real Enter key press; it is refused the same way
where it would send or submit. Typed text with a tab before the line break,
or with anything after it, is refused wherever it is typed: a tab moves the
focus, so the server cannot tell where that Enter would land.

This is a guard against a bot acting through a script by habit. **It is not a
wall**: a script written to hide what it does gets past a check of its text.

### Limits

- The word lists are English. Other languages rely on the two form rules.
- Space on a focused button clicks it, and is not checked.
- Inside an embedded frame, such as a payment or comment widget, a click is
  judged by its label alone and the card shows no fields; Enter there is not
  checked.
- A one-line box outside any form that sends on Enter is not recognised.
- A page whose text around the button keeps changing by itself (a countdown
  in the same row) voids every approval: each Allow raises a new card.
- A secret in a field that nothing marks as one (no type, no autofill hint,
  no telling name, not a card number) is shown like any other value. A frame
  from another site that holds one, and does not name a payment or a
  sign-in, is in the picture.
- A list or checkbox that submits its form from a listener added in script
  (`addEventListener`), not from a handler written on the element, is not
  recognised. Neither is a field that submits as it is filled.
- Opening an address is never held. A site that acts on a plain link (a
  one-click unsubscribe) acts when the bot opens it.
- Below Full access some engines show their own tool card for a browser
  click first, then this one. This is the one with the evidence.
- None of this applies to web work a bot does on a computer (a cloud
  computer, a Local VM, or This computer): those turns do not use the
  built-in browser.

## Asking you questions

Every engine can stop and ask, and no approval level ever answers a question
for you: Ask, Auto-accept edits, Auto, and Full access all leave a question
card for a person. What differs per engine is only how the ask travels:

| Engine family | How an ask travels | Multiple questions at once |
| --- | --- | --- |
| Claude Code | Structured round-trip (its own `AskUserQuestion`) | Yes — capped at 4 by the CLI |
| Codex | Structured round-trip | Yes — up to 6 |
| Grok Build, Minimax, OpenAI-compatible endpoints | The injected `ask_user` tool | Yes — up to 6 |
| ACP engines (Cursor, Antigravity, Gemini CLI, Qwen Code, OpenCode, …) | Option-match round-trip on the ACP permission request | One at a time — the request carries one choice set |
| Pi | Free-text round-trip over `extension_ui_request` | One at a time |

Older conversations may still hold a question the removed Computer engine
parsed out of model-authored output rather than a real tool call. Those
cards keep their "Agent-composed question" badge, and their decision-log
rows keep `origin: output`. Flat clients (notifications, older companion builds)
see plain buttons only when a card asks a single choice question; a
multi-question card renders its structured form on current apps instead.

## Provider mappings

| Provider | Ask | Auto-accept edits | Auto | Full access |
| --- | --- | --- | --- | --- |
| Codex | `on-request` approvals, `workspace-write` sandbox, you review | not offered (Ask already writes in the workspace) | same sandbox, native `auto_review` reviewer | `never` approvals, `danger-full-access` sandbox |
| Claude | Native `default` | Native `acceptEdits` | Native `auto` | Native `bypassPermissions` |
| Cursor | Native default | not offered | Native `--auto-review` | Native `--force` |
| Antigravity | Native `default` | Native `auto_edit` | Legacy `auto` behaves as Ask; UI Auto selects Full access | Native `yolo` plus automatic approval of remaining tool-permission requests; shown as Auto |
| Grok Build | Native `default` | Native `acceptEdits` | Native `--permission-mode auto`; availability of Grok's reviewer depends on its feature rollout | Native `bypassPermissions` plus automatic approval of remaining tool-permission requests |
| OpenCode | Ask | not offered | Ask | Approve individual ACP permission requests, never task questions |
| Qwen Code | Native `default` | Native `--approval-mode auto-edit` | Native `--approval-mode auto` (Qwen's LLM classifier approves safe actions, blocks risky ones) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Gemini CLI | Native `default` | Native `--approval-mode auto_edit` | Ask (no reviewer) | `--yolo`, plus automatic approval of remaining ACP permission requests |
| Other/custom engines | Ask | not offered | Ask | Not offered until a provider mapping is implemented |

These settings apply on each turn, including resumed conversations. Switching
to a different provider while elevated requires leaving Full/Custom first;
choose Ask. Switching models within Antigravity keeps the selected level.
Native modes require a CLI version that supports them; OpenMausBot does not
silently substitute unrestricted access when a mode is rejected.

### Read-only integration tools

OpenMausBot's built-in agents MCP server describes nine scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_rooms`, `list_threads`, `check_delegation`, `wait_delegation`,
`session_search`, `session_read`, `list_routines`, and `skills_list`.
Session recall still enforces own-bot access and records its existing room
disclosure audit. These hints do not grant access to another bot's conversations.
Writes, credential requests, proposals, and third-party tools do not inherit
these hints. The metadata is available to every engine using this integration;
whether an engine consumes it remains that engine's behavior. Arbitrary MCP
display titles or `readOnlyHint` claims from a third-party server are not
authorization to bypass a prompt.

The level set follows the provider-boundary approach in
[T3 Code's permission modes](https://github.com/pingdotgg/t3code/blob/e16b8b059c9f5ff6dfed1addecffb831c6aee043/docs/user/permission-modes.md):
Supervised, Auto-accept edits, Auto, and Full access, each a provider mode
rather than an app rule, with a remembered approval that belongs to the
provider's session. Its quieter default is Full access; OpenMausBot keeps its
own opt-in desktop confirmation and Ask as the default.

## Verification for contributors

The [Full Access workflow recipe](verification/full-access.md) tests immediate
profile, routine, team, skill, and peer actions through the real server and MCP
proxy. Its fixture also verifies that explicit Ask sibling threads still wait.

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
HTTP elevation rejection, Full → Auto → Ask on resumed Claude turns, and
Antigravity automatic tool approvals on new and resumed Full access turns across
multiple model variants. It also checks that Ask and legacy Auto still prompt,
peer-started Full turns auto-approve, switching the receiving bot back to Ask
restores prompts even for a Full-access sender, delegated Codex Custom uses the
native Auto reviewer consistently, and questions remain interactive. Provider
processes are scripted fakes; this does not verify live account eligibility or
the quality of a provider's automatic reviewer. No live user data is used.
Grok coverage exercises two model selections across fresh/resumed Auto turns,
real built-in MCP reads under a scripted native reviewer, returning to Ask,
and held deletion, credential, spoofed-title command, and question requests.
