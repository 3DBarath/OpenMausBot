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
| A4 | After an approved payment that posts a form, `agent_browser_reload` is held and Deny posts nothing. The card names the site and "an earlier payment" and repeats no field. After opening another address the reload is held too, and again after going back. |
| A5 | A 2,400-character selector and one starting with a dash are refused. A button with no area is held by its snapshot name when picked by ref, and refused when picked by CSS. |
| A6 | A visible Send and a hidden Cancel in one grid cell: the click on Send is held. |
| A7 | Enter in a form whose only submit is `<input type="image">` is held as money; Enter in one whose "Send" button is tied to it by the `form` attribute is held as a send. |
| A8a | A ref with a trailing space, for a Pay button inside a frame, is held. |
| A8b | `agent_browser_select` on a list whose `onchange` submits its form is held. |
| A8c | A form with controls named `tagName`, `elements`, `action`, `id`, `closest` and `querySelectorAll` is still read: its submit is held and its field is on the card. |
| A9 | A payment frame from another origin (a second local server, reached as `localhost`). With the focus in its card field, `Enter`, `Control+Enter` and `Enter+Shift` are refused, and so are a line break typed into the field's ref (whose measured box is also the box of a field outside the frame), a line break typed at the frame element, and a click on the frame element. Nothing is paid. The frame's Pay button, by its ref, is held. In a frame of the page's own origin, Enter is held as money. |
| A10 | A card form with no autofill hints (card number, expiry, CVC by label) is held as money on "Continue". A form with a card number typed into a field called `ref` is too. A library card number with a PIN signs in with no card. |
| R1 | A line break typed at a paragraph, an image, and selectors the engine cannot resolve (`text=…`, `placeholder=…`, `label=…`, `role=…`, `@x`) is refused while a "Pay now" form has the focus. Nothing is paid. |
| R2 | In a card form (card number, expiry and CVC by label), a `type="button"` "Continue", a "Confirm" link, a "Next" element with the button role and a list with an `onchange` handler are each held as money. So is a submit in a form whose card field is a processor's frame from another origin. |
| R3 | A "Continue" inside a frame of the page's own origin, clicked by ref, is held as money and the card lists the frame's card field by length. The same button inside a payment frame from another origin is held as money too. A click on an `<object>` element is refused. |
| R4 | `Space`, `" "` and `Shift+Space` on a focused Send button are held. Space in a text box passes. Space with the focus inside a payment frame from another origin is refused. |
| R5 | After an approved payment, the bot opens another page and that page's own link goes back: the reload is held, and Deny posts nothing. |
| R6 | An approval is void after the page changes: a field in another section of a page with no form, the text in a rich-text frame, a hidden field, fields in a step that is not displayed, and a tick box outside the button's region. |
| R7 | Fields called Code, Security answer, Social security number, Contraseña, Secret key, Número de tarjeta, Recovery phrase and Backup code are on the card and in the log by length only; the text around the button, which says a password, is left off and the page is not pictured. On a page with no form, only the button's own section is listed. The reload card repeats nothing that was sent. |
| R8 | A row whose "3s ago" ticks and whose button is restyled four times a second: one approval is used. A row whose word really changes: two approvals are void, the third card says the page keeps changing, and its approval is used. |
| R9 | With the focus inside a closed shadow root that holds a card form, Enter and Space are refused. |
| R11 | On a page with 6,000 filled fields a click that commits nothing runs with no card inside 1.5 seconds. A Send there lists only its own section's field. |
| R12 | A search box holding a card number submits with no card. An IMEI lookup (a number that passes the Luhn check) does too. |
| T7 | Ordinary operations, each with the outcome it must have. Pass with no card: links that say "Blog post", "Buy tickets" and "Share prices" (each opens its page), "Save changes" on a profile with an "About you" box, "Apply" on filters, "Submit" on a sign-in, "Continue" on a sign-up, Enter in a notes box, several lines typed into it, and "Confirm" alone. Held as a send: a `#` link that says "Send", Enter in a chat composer, "Comment" on a one-field form, "Send" in a mail form, "Apply" on a form with a file to attach. Held as money: "Pay now", "Upgrade", and "Continue" in a card form. |
| 4A | With the focus in a "Pay now" form's field, a line break typed at a field in a disabled group, an inert one and a hidden one is refused; so is one typed at a search box that does not have the focus, and at a search box behind a modal whose "Buy now" has the focus. After a click on the search box the same text runs. |
| 4B | Enter in an address finder (`type="search"`) inside a card form with "Pay now", Enter in a `role="searchbox"` promo field inside a card form, "Continue" on a card form inside `role="search"`, and Enter in the search field of a form whose button says "Buy now" are each held as money. |
| 4C | A product page with a pay-later message frame and an express-checkout frame, both from another origin: a size list with a change handler, a quantity stepper, "Add to cart", an accordion and a link all run with no card. "Continue" inside the express frame is held as money. So is "Continue" inside a frame known only by the name `klarna-payments-main`. |
| 4D | On a page with an advert frame, three links clicked by ref open their pages with no card: a headline over 120 characters with list words in it, a link with text hidden from the snapshot, and a picture-plus-text link. |
| 4E | Contents links to headings on the same page ("Transfer of power", "Trade") and `#/blog` and `#!/share` routes pass. A bare `#` "Send" and a link to a place the page does not have ("Post") are held. |
| 4F | "Continue" beside card fields in a component's open shadow root is held as money. A mail form whose fields sit in shadow roots lists them on the card; the recipient changes and the approval is void. The form also holds a closed component, and the card says part of it could not be read. |
| 4G | A label wrapping a text area, an input and a list: the fields are named "Recovery phrase", "Password hint" and "Network", and none of the text area's words is on the card or in the log. |
| 4H | A list gaining a row above the button every 300 ms: two approvals are void, the third card says the page keeps changing, and its approval is used. |
| 4I | A `role="checkbox"` switched on while the card is open voids the approval. |
| 4J | Six forms with a text area on an English page ("Save draft", "Translate", "Generate", "Check grammar", "Update profile", "Add note") submit with no card. "Speichern" on a page that declares German is held. |
| 4K | In a card form, an option ("Use this card"), a tab and a switch are each held as money. |
| 4L | `const el = [document.querySelector('#amount')][0]; el.value = '999'` is refused and the field keeps its value; a script that fills an object of its own runs. |
| B9 | Two "Buy now" buttons. The card names the $1 item. The list re-renders and a snapshot gives the same ref to the $18,000 item; Allow is void and the new card names that item. |
| B10 | A dialog with no form: the card shows the recipient and the message. The page swaps both; Allow is void and the new card shows the new ones. |
| B11 | A form with a 3,000-character text and 35 more fields: the card says the text was shortened and that 24 fields are not shown. Field 33 changes; Allow is void. |
| C13 | A field named `cardnumber`, a plain CVC field, a one-time code, a password shown as text, a PIN, the name on a card and an unlabelled card number are on the card, and in the decision log, by length only. The page is not pictured, and the card says so. |

Keep the printed JSON and the log path as evidence.

Focused automated coverage:

```sh
pnpm exec vitest run shared/browser-commit.test.ts server/browser-commit-page.test.ts \
  server/browser-commit-gate.test.ts server/browser-commit-ordinary.test.ts server/browser-commit-hold.e2e.test.ts \
  server/browser-commit-shots.test.ts server/browser-commit-shots-startup.test.ts \
  server/browser-runtime.test.ts server/browser-engine.test.ts server/harness-mcp-proxy.test.ts \
  server/activity.test.ts src/lib/approval-summary.test.ts src/components/ApprovalCard.test.ts
```

`server/browser-commit-ordinary.test.ts` is a table of more than 220 ordinary
operations and the outcome each must have: passes, held as a send, held as
money, or refused. Forty are links whose text has a word from the lists. A
second group holds what the first table missed: same-page links and `#/`
routes, shop pages with a payment brand's frame, text-area forms with
everyday labels, links whose snapshot name is not their text, search fields
in card forms, fields in web components. Each row runs through the real page
read and the real gate against a page in happy-dom, by ref, the way a bot
clicks. Add a row there before changing a rule or a word list.

`server/browser-commit-hold.e2e.test.ts` runs the same route, respond route,
decision log and attachment store against an inert browser executable, so it
runs anywhere. It does not prove the page read: only the script above reads a
real page. Run the script on Windows before a Windows release; the engine
pinned there is older than the one these reads were checked on, and the
reads use its `eval --stdin` and `get attr`.

The hold is a guard against a bot over-acting on ordinary pages, not a
guarantee: [its limits](../approval-levels.md#limits) are part of what it
is. This recipe proves the rules on local pages built for them.

What this does not prove: the card in the desktop UI (covered by
`src/components/ApprovalCard.test.ts`, not by a renderer run), the hand-back
note after a real take-over (covered by `server/browser-runtime.test.ts`), or
behaviour on real sites.
