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

1. Ordinary clicks, a login and a search pass without a card.
2. A click on **Send** waits. The card is titled "Send on your behalf?", its
   subtitle is the site, the label and the message, and its screenshot is
   served as a JPEG. During the hold a snapshot works and a fill is refused.
   Allow clicks it: the page reports `submitted:message`.
3. A submit on the card form waits as "Spend money?". The card number is
   never on the card, only "16 characters, not shown". Deny clicks nothing.
4. Enter in the message box waits as "Enter in Write a message". The page
   then edits its own draft; Allow is void, the first card is marked as page
   changed, and a second card shows the edited text. Shift+Enter passed, and
   a line break typed with `agent_browser_type` was refused.
5. `/api/decisions` holds `card-shown`, `user-approved`, `user-denied` and
   `auto-denied … page-changed` rows under `browser-commit:send` and
   `browser-commit:money`, and the bot's activity lists them under Browser.

Keep the printed JSON and the log path as evidence.

Focused automated coverage:

```sh
pnpm exec vitest run shared/browser-commit.test.ts server/browser-commit-page.test.ts \
  server/browser-commit-gate.test.ts server/browser-commit-hold.e2e.test.ts \
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
