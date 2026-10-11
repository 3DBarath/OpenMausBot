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
   Allow clicks it: the page reports `submitted:message`, and the click's
   result ends with that line as the text that appeared on the page.
3. On a second page with a sign-in and a card form, **Log in** passes
   without a card. A submit on the card form waits as "Spend money?". The
   card number is never on the card, only "16 characters, not shown", and no
   screenshot is taken of a page that shows it. Deny clicks nothing.
4. Back on the first page (opened, not reloaded: see case A4), Enter in the
   message box waits as "Enter in Write a message". The page then edits its
   own draft; Allow is void, the first card is marked as page changed, and a
   second card shows the edited text. Shift+Enter passed. Text typed with a
   line break (`agent_browser_type`) went into the box, its Enter waited on
   a card, and Deny sent nothing.
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
| 4A | With the focus in a "Pay now" form's field, text with a line break typed at a field in a disabled group, an inert one and a hidden one is refused and the focused field keeps its value. Typed at a search box that was not clicked, the text goes in and the search is submitted once. Typed at a search box behind a modal whose "Buy now" has the focus, it is refused and nothing is typed. |
| 4B | Enter in an address finder (`type="search"`) inside a card form with "Pay now", Enter in a `role="searchbox"` promo field inside a card form, "Continue" on a card form inside `role="search"`, and Enter in the search field of a form whose button says "Buy now" are each held as money. |
| 4C | A product page with a pay-later message frame and a wallet frame ("Shop Pay"), both from another origin: a size list with a change handler, a quantity stepper, "Add to cart", an accordion and a link all run with no card. "Continue" inside the wallet frame is held as money. So is "Continue" inside a frame known only by the name `klarna-payments-main`. |
| 4D | On a page with an advert frame, three links clicked by ref open their pages with no card: a headline over 120 characters with list words in it, a link with text hidden from the snapshot, and a picture-plus-text link. |
| 4E | Contents links to headings on the same page ("Transfer of power", "Trade") and `#/blog` and `#!/share` routes pass. A bare `#` "Send" and a link to a place the page does not have ("Post") are held. |
| 4F | "Continue" beside card fields in a component's open shadow root is held as money. A mail form whose fields sit in shadow roots lists them on the card; the recipient changes and the approval is void. The form also holds a closed component, and the card says part of it could not be read. |
| 4G | A label wrapping a text area, an input and a list: the fields are named "Recovery phrase", "Password hint" and "Network", and none of the text area's words is on the card or in the log. |
| 4H | A list gaining a row above the button every 300 ms: two approvals are void, the third card says the page keeps changing, and its approval is used. |
| 4I | A `role="checkbox"` switched on while the card is open voids the approval. |
| 4J | Six forms with a text area on an English page ("Save draft", "Translate", "Generate", "Check grammar", "Update profile", "Add note") submit with no card. "Speichern" on a page that declares German is held. |
| 4K | In a card form, an option ("Use this card"), a tab and a switch are each held as money. |
| 4L | `const el = [document.querySelector('#amount')][0]; el.value = '999'` is refused and the field keeps its value; a script that fills an object of its own runs. |
| 5A | Text ending in a line break, typed at a field that was not clicked first. A search box and a sign-in password: the text is in the field once and each form is submitted once. A chat composer: the text is in the box, a "Send on your behalf?" card shows it, nothing is sent before Allow, and Allow sends it once. A field in a disabled group while a payment form's field has the focus, and a search box behind a modal whose own field has the focus: refused, nothing typed anywhere, nothing submitted. |
| 5B | "Continue" on a page whose only payment element is a frame from another origin titled "Checkout", "Payment" or "Secure payment" is held as money. (Case 4C keeps the pay-later message and express-button frames passing.) |
| 5C | A "Pay now" link whose address is `java`, a tab, `script:` is held as money, by CSS selector and by ref. A "Send" link with a `data:` address is held as a send. |
| 5D | Enter in a box labelled "Write a message", on a page with a search in its header and fields in its navigation and footer, is held as a send. Enter in the body of a mail form with To and Subject fields is a new line. |
| 6A | A form whose "Pay now" button is disabled until its field has text, and one whose "Send" button is: text with a line break typed at the field, clicked first and not clicked first. Each time the text is in the field once, a card is raised ("Spend money?", "Send on your behalf?") and nothing is submitted before the answer; Deny submits nothing, Allow submits once. Then a search typed with a carriage return and a line feed at its end, and with a carriage return alone: submitted exactly once each. |
| 6B | A shop page with a frame titled "Shop Pay", one titled "Donate with PayPal", a reviews widget and an advert whose addresses contain "pay" and "checkout": "Add to cart" and a link run with no card, and "Continue" inside the wallet frame is held as money. Beside a frame titled "Payment button frame", "Checkout message", "Klarna payments" or "PayPal card fields", "Continue" on the page is held as money. |
| 7A | A "Pay now" button enabled 0, 50 and 150 ms after typing stops. Text with a line break typed at its field, four tries at each delay, clicked first and not: every time a "Spend money?" card is raised and nothing is paid before the answer; Deny pays nothing, Allow pays once. A search and a sign-in whose buttons are disabled until there is text run with no card. |
| 7B | "Continue" beside a frame titled "Checkout" whose address only mentions Google Pay's and PayPal's button addresses in its query is held as money. |
| B9 | Two "Buy now" buttons. The card names the $1 item. The list re-renders and a snapshot gives the same ref to the $18,000 item; Allow is void and the new card names that item. |
| B10 | A dialog with no form: the card shows the recipient and the message. The page swaps both; Allow is void and the new card shows the new ones. |
| B11 | A form with a 3,000-character text and 35 more fields: the card says the text was shortened and that 24 fields are not shown. Field 33 changes; Allow is void. |
| C13 | A field named `cardnumber`, a plain CVC field, a one-time code, a password shown as text, a PIN, the name on a card and an unlabelled card number are on the card, and in the decision log, by length only. The page is not pictured, and the card says so. |
| M1 | The runtime reads the page before and after every action that reaches the engine and adds what changed to the result. Text typed with a line break at a search box: the result ends with the line the Enter made appear. At a chat box the Enter waits; declined, the bot gets the refusal and no page text; allowed, the result holds what the text and the Enter each changed. A "Pay now" click: declined, the refusal only; allowed, the result ends with what the click changed. A script that would act is refused with no page text. |
| M2 | A click keeps the page busy for 125 seconds, longer than a browser call may take. The call ends at 120 seconds with "did not answer". The bot's next call, a click on Send by ref, is not read, judged or held: it is answered with "the earlier call has ended, and it may have taken effect. This call did not run", and no card is raised. The same ref again is refused until a new snapshot ("an earlier browser call was lost"). A click on Send by selector is held and Deny sends nothing. After a snapshot the ref is held again, and Allow sends once. No restart: the page still shows what the lost click did. This case takes a little over two minutes. |

Keep the printed JSON and the log path as evidence.

Focused automated coverage:

```sh
pnpm exec vitest run shared/browser-commit.test.ts server/browser-commit-page.test.ts \
  server/browser-commit-gate.test.ts server/browser-commit-ordinary.test.ts server/browser-commit-hold.e2e.test.ts \
  server/browser-commit-shots.test.ts server/browser-commit-shots-startup.test.ts \
  server/browser-runtime.test.ts server/browser-engine.test.ts server/harness-mcp-proxy.test.ts \
  server/activity.test.ts src/lib/approval-summary.test.ts src/components/ApprovalCard.test.ts
```

`server/browser-commit-ordinary.test.ts` is a table of more than 280 ordinary
operations and the outcome each must have: passes, held as a send, held as
money, or refused. Forty are links whose text has a word from the lists. A
second group holds what the first table missed, and a third and a fourth
what later reviews found (text typed with a line break, clicked first or
not; frames that speak of payment, wallet frames and frames known only by
their address; addresses that hide their scheme; a message box beside a
header search). The second group: same-page links and `#/`
routes, shop pages with a payment brand's frame, text-area forms with
everyday labels, links whose snapshot name is not their text, search fields
in card forms, fields in web components. Each row runs through the real page
read and the real gate against a page in happy-dom, by ref, the way a bot
clicks. Add a row there before changing a rule or a word list.

`server/browser-commit-hold.e2e.test.ts` runs the same route, respond route,
decision log and attachment store against an inert browser executable, so it
runs anywhere. It also ends a hold three ways, through the real MCP proxy
where the engine is involved: the engine cancels the call, the proxy's
input closes, and the turn is stopped. Each time the card closes as
unavailable, the browser is the bot's again, a late Allow is answered as
unavailable, and the engine was never asked to click. It cancels a call
after Allow as well, while the runtime reads the page ahead of the click:
the click is not made. It does not prove the page read: only the script above reads a
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
