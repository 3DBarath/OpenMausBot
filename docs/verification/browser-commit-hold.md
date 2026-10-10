# Browser commit hold

A click or an Enter press in a bot's built-in browser that would send
something or spend money waits on a card. This recipe proves it against an
actual browser. Use installed engine and Chrome binaries explicitly; the
fixture never uses the operator's browser profiles, OMB home, provider logins
or API keys.

```sh
OMB_VERIFY_BROWSER_BINARY=/absolute/path/to/agent-browser \
OMB_VERIFY_BROWSER_CHROME=/absolute/path/to/chrome-headless-shell \
node --experimental-strip-types scripts/verify-browser-commit-hold.ts
```

The script uses `launchVerificationServer` from `scripts/control-omb.ts` with
a temporary home and the fake model CLI parked mid-turn, serves one local test
page, and drives the turn's own browser route (`/api/internal/browser/mcp`)
with the capability the fake engine was given, the way the MCP proxy does. It
answers cards through `/api/threads/ID/respond`, closes its browser, removes
its temporary data and exits. The server log stays at the printed `logPath`.

It exits 0 and prints `"ok": true` with one evidence entry per step:

1. Ordinary clicks and a search pass without a card.
2. A click on **Send** waits. The card is titled "Send on your behalf?", its
   subtitle is the site, the label and the message, and its screenshot is
   served as a JPEG. During the hold a snapshot works and a fill is refused.
   Allow clicks it: the page reports `submitted:message`.
3. On a second page with a sign-in and a card form, **Log in** passes
   without a card. A submit on the card form waits as "Spend money?". The
   card number is never on the card, only "16 characters, not shown", and no
   screenshot is taken of a page that shows it. Deny clicks nothing.
4. Back on the first page (opened, not reloaded: see case A4), Enter in the
   message box waits as "Enter in Write a message". The page then edits its
   own draft; Allow is void, the first card is marked as page changed, and a
   second card shows the edited text. Shift+Enter passed, and a line break
   typed with `agent_browser_type` was refused.
5. `/api/decisions` holds `card-shown`, `user-approved`, `user-denied` and
   `auto-denied … page-changed` rows under `browser-commit:send` and
   `browser-commit:money`, and the bot's activity lists them under Browser.

After the walkthrough the script runs one **case** per way a send or a
payment once got past the hold, each on its own local page. Every case runs
even when an earlier one failed, and prints `"case"`, its title and
`"ok": true` or the reason it failed; any failure makes the script exit 1.
`OMB_VERIFY_CASES=A4,A6` runs only those.

| Case | What it proves on a real page |
| --- | --- |
| A1 | Enter with the focus on a checkbox, a radio button, a list or a slider is held as the form's "Buy now". |
| A2 | `agent_browser_check` on a Send button is held; `agent_browser_uncheck` on a box whose `onchange` submits is held. |
| A3 | `Enter+Shift` in a one-line field and `Enter+Control` in a message box are held; `Enter+Shift` in the message box types a line break and passes. |
| A4 | After an approved payment that posts a form, `agent_browser_reload` is held and Deny posts nothing; after opening another address it passes; after going back it is held again. |
| A5 | A 2,400-character selector and one starting with a dash are refused. A button with no area is held by its snapshot name when picked by ref, and refused when picked by CSS. |
| A6 | A visible Send and a hidden Cancel in one grid cell: the click on Send is held. |
| A7 | Enter in a form whose only submit is `<input type="image">` is held as money; so is one whose button is tied by the `form` attribute. |
| A8a | A ref with a trailing space, for a Pay button inside a frame, is held. |
| A8b | `agent_browser_select` on a list whose `onchange` submits its form is held. |
| A8c | A form with controls named `tagName`, `elements`, `action`, `id`, `closest` and `querySelectorAll` is still read: its submit is held and its field is on the card. |
| A9 | A payment frame from another origin (a second local server, reached as `localhost`). With the focus in its card field, `Enter`, `Control+Enter` and `Enter+Shift` are refused, and so are a line break typed into the field's ref (whose measured box is also the box of a field outside the frame), a line break typed at the frame element, and a click on the frame element. Nothing is paid. The frame's Pay button, by its ref, is held. In a frame of the page's own origin, Enter is held as money. |
| A10 | A card form with no autofill hints (card number, expiry, CVC by label) is held as money on "Continue". A form with a card number typed into a field called `ref` is too. A library card number with a PIN signs in with no card. |
| B9 | Two "Buy now" buttons. The card names the $1 item. The list re-renders and a snapshot gives the same ref to the $18,000 item; Allow is void and the new card names that item. |
| B10 | A dialog with no form: the card shows the recipient and the message. The page swaps both; Allow is void and the new card shows the new ones. |
| B11 | A form with a 3,000-character text and 35 more fields: the card says the text was shortened and that 24 fields are not shown. Field 33 changes; Allow is void. |
| C13 | A field named `cardnumber`, a plain CVC field, a one-time code, a password shown as text, a PIN, the name on a card and an unlabelled card number are on the card, and in the decision log, by length only. The page is not pictured, and the card says so. |

Keep the printed JSON and the log path as evidence.

Focused automated coverage:

```sh
pnpm exec vitest run shared/browser-commit.test.ts server/browser-commit-page.test.ts \
  server/browser-commit-gate.test.ts server/browser-commit-hold.e2e.test.ts \
  server/browser-commit-shots.test.ts server/browser-commit-shots-startup.test.ts \
  server/browser-runtime.test.ts server/browser-engine.test.ts server/harness-mcp-proxy.test.ts \
  server/activity.test.ts src/lib/approval-summary.test.ts src/components/ApprovalCard.test.ts
```

`server/browser-commit-hold.e2e.test.ts` runs the same route, respond route,
decision log and attachment store against an inert browser executable, so it
runs anywhere. It does not prove the page read: only the script above reads a
real page. Run the script on Windows before a Windows release; the engine
pinned there is older than the one these reads were checked on.

What this does not prove: the card in the desktop UI (covered by
`src/components/ApprovalCard.test.ts`, not by a renderer run), the hand-back
note after a real take-over (covered by `server/browser-runtime.test.ts`), or
behaviour on real sites.
