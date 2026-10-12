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
| **Full access** | Enables the provider's permissive mode for commands, edits, and selected-computer actions, including potentially destructive or sensitive work. Residual native permission prompts are answered for you. OMB profile changes, routine actions, team setup, bot deletion, and enabled skill authoring apply without a second approval. Peer-review prompts are skipped within the bot's authorized scope. Work handed on with `coordinate_bots` uses the receiving bot's setting, never the sender's — except from a Chief of Staff, whose level flows down (below). Actual questions and missing credentials still need your input. |
| **Custom (`config.toml`)** | Codex only. OpenMausBot reads and reapplies the effective approval and sandbox settings from your Codex configuration. |

Full access applies the moment you pick it: no confirmation dialog, no
second step. It can be turned on from any client that can reach the app's
API: the desktop app, a browser, a paired phone or web client, or a bot or
script calling the local API where local calls count as you (development, the
CLI, a self-hosted server). Picked in bot settings, it applies to the bot
and every one of its existing threads at once; picked in the composer, to that
thread; Refresh permissions copies it onto one thread. An engine that cannot
run Full access still cannot be set to it. On a hosted company workspace, Full
access still comes only from the operator's dedicated policy
([guarded messages](verification/guarded-messages.md)).

Custom is different: it can only be entered or left from a packaged local
desktop app, where the choice crosses a private process channel rather than the
bot-accessible HTTP API, because it holds restrictions you wrote yourself. It
is hidden in development, standalone web, and remote pages.

Full access does not bypass operating system privacy controls,
authentication, CAPTCHA or MFA, service permissions,
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
level flows down**. Work it hands out with `coordinate_bots` (and, for one
release, its `delegate_bot` and peer `start_thread` aliases) — into the work
thread the Chief's conversation has with a teammate, or a fresh thread with
`thread: "new"` — starts at the level of the Chief conversation it came from:
Auto-accept edits, Approve for me, or Full access. The teammate's thread is
switched to that level, keeps it, and opens with a line saying so ("Approve
for me — delegated by Clive, a Chief of Staff on Approve for me"); you can
still change it in that thread. Work a Chief hands out inside a room runs at
the Chief's level for that turn. The level is computed once when the
assignment is written and recorded on it (docs/runtime-contract.md §3); the
turn runs with exactly that level.

It only ever raises: a teammate already on a higher level keeps it, a teammate
on Custom keeps its own configuration, and a Chief handing work out from an
Ask conversation passes nothing on. A teammate's engine caps the level: one
without Full access gets Approve for me, and one without Auto-accept edits
(Codex, whose Ask already writes the workspace) stays on its own level. The
teammate's own default and its other conversations do not change, and an
ordinary bot's hand-off still uses the recipient's setting. A consultation
(`consult: true`) answers from what the teammate knows and acts on nothing, so
no level travels with it. Questions and missing credentials still reach you.

## Answering a request

Approve or deny requests in the conversation to let the bot continue. **Allow
once** answers this request only. **Always allow this session** hands the
provider its own remembered approval: Claude receives its suggested permission
rules, and ACP agents such as Grok receive their `allow_always` option, or the
driver repeats your answer for that exact operation until the native session
ends. API models (OpenAI-compatible, MiniMax, Mistral, Grok API) have no
native session, so their driver keeps the allow for that bot, that exact tool
and that exact server (as launched: a changed command, URL or credential is
another server, and a bridge into a VM or a Boat is new each turn) for the
rest of the conversation, in memory until the server restarts. Another bot in
the same room asks again. OpenMausBot keeps no standing grant for a provider's tool. It is not
offered for computer control, for a sandbox change or on a guest's turn. The
harness's own agents tools (coordinating teammates, threads, memory) never
ask on Claude, Codex or API models: OpenMausBot authorizes each of those
routes itself.

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

### Changing a bot's engine

A bot at **Full access** keeps it when you switch it to another engine that
can run Full access: no reset to Ask and no confirmation. The bot's threads
that follow its model keep their level too. **Custom** rules belong to Codex,
so a Custom bot goes back to Ask before it changes engine. Switching to an
engine that cannot run the bot's level (for example Auto-accept edits on
Codex) still asks to choose Ask first.

### Antigravity: Ask, Edits, or Auto (full access)

For Antigravity, the composer and bot settings offer **Ask for approval**,
**Auto-accept edits** (its native `auto_edit` mode), and **Auto (full access)**.
Auto enables native `yolo` mode and automatically approves remaining
tool-permission requests for commands, edits, and computer actions, without an
automatic reviewer. The composer chip reads **Auto**. This is the Full access
level under another name, not a separate permission setting, applies at once
like Full access, and covers every model in that Antigravity instance,
including Gemini.

Choose Auto explicitly. Old Antigravity
`auto` / `autoApprove` settings still behave as Ask and are displayed as Ask;
they never become unrestricted access on upgrade. Switching back to Ask
restores prompts on the next turn. Questions and missing-credential forms
still require an answer. A Chief or
teammate can hand work to this bot with `coordinate_bots` without downgrading
its explicit Auto (full access) grant. It does not enable Auto on any other bot.

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

**The browser hold is a guard, not a guarantee.** It reads the page the way
a careful person would, from the outside: what a button is called, what form
it is in, whether there are card fields around it. That stops a bot from
sending or paying on an ordinary page without asking, and it is tuned to
stay out of the way of ordinary browsing: links, filters, sign-ins, notes.
It does not see what a page sends over the network, so a page built to
commit on something that looks harmless gets past it. The [limits](#limits)
below say where, in plain words. A check on the payment request itself, at
the network, is planned as separate work.

| Setting | Sends | Money in the browser |
| --- | --- | --- |
| **Ask every time** (default) | Every send waits for your answer. | Always asks. |
| **Allow a daily amount** | Sends go out on their own up to the daily number, counted together across connected apps and the browser. Past it, a connected-app send is refused until the next day and a browser send asks. | Always asks. |

### What counts in the browser

Fixed rules in the server decide, not the bot and not a model. A click, an
Enter or Space key press, ticking or unticking a box, choosing from a list,
and a reload can count. Filling a field, scrolling, opening a page and every kind
of reading never ask. When the server cannot tell what a call would act on,
it refuses the call or asks. It never lets it through unseen.

| What the bot does | Held as |
| --- | --- |
| Clicks a button or menu item whose label has one of: send, reply, post, publish, comment, share, message, submit, invite, forward, tweet, notify, accept invitation, list item | Send |
| Clicks "Apply" where something is being submitted: the form or region has a file to attach or a multi-line field, or the label says an application goes out ("Apply now", "Easy Apply", "Apply for this job") | Send |
| Clicks one whose label has one of: pay, buy, place order, checkout, bid, book, reserve, subscribe, donate, transfer, deposit, withdraw, top up, add funds, upgrade, start free trial, renew, get tickets, sell, trade, place bet, sign transaction, charge; or says the same another way (purchase, check out, order now, reorder, or "Order" alone) | Money |
| Clicks one whose label pairs a word for committing or sending (place, complete, confirm, finish, make, authorize, process, or any Send word) with what money is spent on (order, purchase, payment, money, booking, reservation, donation, checkout): "Place your order", "Confirm booking", "Make a payment", "Send money", "Submit order" | Money |
| Clicks, or presses Enter or Space on, any button, link, menu item, option, tab or switch inside a card region (below), whatever it says; submits a form there; changes a list or tick box there that has a change handler | Money |
| Presses Space on a focused button or menu item | The same as a click on it |
| Presses Enter in a message composer (below) | Send |
| Submits a form that has a multi-line text field, on a page that is not in English or with a label that is not (below) | Send |
| Reloads the page after one of the above went through | The same as that one |

Labels match whole words in any letter case, in English: "Post reply"
matches, "Posts" and "Repost" do not. Money wins when both match, and a money
word lifts a send to money ("Submit payment"), so it asks even under a daily
allowance. A money word that only names a thing holds nothing: "Order
history", "Payment methods", "Purchase history", "Check out our new
arrivals". "Book a demo" is held as money, because "book" is on the list.
"Confirm", "Continue", "Complete", "Approve", "Authorize" and "Agree &
Continue" are on no list: alone they hold nothing, and inside a card region
they are money like everything else there.

What passes, so that ordinary browsing is not interrupted:

- **A plain link.** A link that goes somewhere is never held for what it
  says: "Share prices", "Blog post", "Buy tickets", "Subscribe" open a page.
  Somewhere is another page, a place on the same page that exists (a
  contents link to a heading), or a `#/…` or `#!…` route of a single-page
  app. A link that acts as a button is judged as a button: one whose address
  is a bare `#`, empty, a place the page does not have, or `javascript:`,
  `data:` or `vbscript:`; one with a button or menu item role; or one with a
  click handler written on it. The address is read the way a browser reads
  it, so `java`, a tab, `script:` is `javascript:`. Inside a card region a link is money like any other control. For a
  link clicked by a ref whose snapshot name is not its text (a long
  headline, a picture with text), the server asks the engine for that
  ref's own address and goes by it.
- **A form with a multi-line field, on an English page.** A profile with an
  "About you" box, a note, a draft, a settings page: "Save draft",
  "Translate", "Generate", "Update profile". On a page in English a button
  whose label is on neither list passes. The page is taken for English when
  it declares English or no language at all, and the label has only basic
  Latin letters. **The other way round:** on a page that declares another
  language, or with a label that has other letters ("Veröffentlichen",
  "送信") or no words at all (an icon with no name), such a form is taken
  for a send, because the lists know nothing of its words. There only a
  label that is wholly one of these passes: save, save changes, update,
  next, continue, back, cancel, close, done, ok, search, filter, sort,
  reset, clear, add, edit, preview, upload, sign in, log in, sign up, create
  account, register. A tick box or a list whose own handler submits such a
  form has no button to go by, and is held in any language.
- **A sign-in.** A form, or a dialog or region with no form, that has a
  password field and no multi-line field is never a send, whatever its
  button says ("Submit", "Send code"). Money rules still apply to it.
- **"Apply" on a filter or a coupon**, where no file is attached and there
  is no multi-line field.
- **Enter in a multi-line field that is not a message composer**: it is a
  new line. The field is a composer when its keyboard hint says send
  (`enterkeyhint="send"`); or when it is the only text field in its form or
  region and either a control there has a Send label or its own label or
  placeholder says message, reply, comment or chat. A search field, and a
  field in the page's header, navigation, footer or a sidebar, does not
  count as another text field: a box called "Write a message" on a page
  with a search in its header is a composer. The body of a mail form with To
  and Subject fields is not. In a composer Enter is held, as before. Enter with another key held (`Control+Enter`) is never a
  new line and is held in any multi-line field. So is Enter in any
  multi-line field inside a card region: nothing is relaxed there.
- A click that only puts the cursor in a text box, or ticks a checkbox with
  no handler.
- **A search is never a send.** A search field, anything inside a search
  region, or a form whose only text field is a search field skips the send
  rules, and what is typed in it is never taken for a card number. It is no
  way round a payment: a money label on its button ("Buy now") is still
  held, and a search field inside a card region is part of that region.

**A card region** is a form that holds a card signal. For a control with no
form it is the nearest dialog, section, article, main area or other landmark
around the control that holds one, or the whole page when there is no such
region around it. A header, footer, navigation bar or sidebar is a region of
its own, so its links are not part of a card form elsewhere on the page.
Fields inside a component's open shadow root count like any others. The card
signals are:

- a field marked for autofill as part of a card (`cc-number` and the rest);
- two signs by name on two visible fields: one called a card number and
  another called a security code (CVC, CVV) or an expiry date, in English,
  Spanish, French, German or Portuguese. The name is read from the field's
  name, id, placeholder, `aria-label` and its `<label>`;
- a value that is a card number: 13 to 19 digits that pass the Luhn check
  and start the way a card scheme's numbers do, or that pass the check
  beside one of the name signs. A number that only passes the check (an
  IMEI, a tracking number) is not one, and neither is anything typed in a
  search form;
- **a frame from another site that calls itself a card, a payment or a
  checkout frame**, by its title, name, id or label: a processor's hosted
  card fields, and equally a frame titled only "Checkout", "Payment",
  "Secure payment", "Payment button frame" or "Checkout message". A frame
  of the page's own site counts when it holds any of the signs above.

**A wallet or pay-later frame does not make the page ask.** A frame that
calls itself a wallet or pay-later brand, and nothing of paying besides, is
that brand's own frame: "Shop Pay", "PayPal", "Apple Pay", "Google Pay",
"Amazon Pay", "Klarna", "Afterpay", "Affirm", alone or with words such as
button, message, placement, donate, express, wallet, logo or badge ("Donate
with PayPal", "Klarna On-site messaging"). The page around one is an
ordinary shop page, and "Add to cart", a size list or a link there is judged
like anywhere else. A brand's frame for paying in is a card signal like any
other: "PayPal card fields", "Klarna payments".

**A frame that speaks of payment or checkout does make it ask, for every
button around it**, whatever else its title says and whichever button
really pays.

A click *inside* any of these frames, brand or not, is still money (see
"Inside a frame" below).

A word in a frame's address decides nothing: adverts and widgets are served
from addresses with "pay" and "checkout" in them. The address counts only
where the frame is served from one of a few known hosts, matched against the
host and path of the address as a browser parses it (a mention of such an
address in a query, or a host that only starts the same, is nothing, and an
address that cannot be parsed matches nothing): a processor's hosted card fields
(Stripe's card and payment elements, Braintree's hosted fields, Adyen's
secured fields, PayPal's card fields, and a few more) make a card signal
whatever the frame is called, and a brand's button (Google Pay's button,
PayPal's smart buttons and messages, Stripe's express-checkout and
payment-request buttons) is a brand's frame whatever it is called.

One name sign alone is not a card region: a library card number with a PIN,
or a gift card code, is left as it is. Inside a card region the label does
not matter: "Continue", "Next" and "Confirm" are money there, on a button of
any type, a link, a menu item, an element with a button role, a plain
element that shows a pointer cursor, and an option, a tab or a switch ("Use
this card").

What counts as submitting a form:

- A click on its submit button, including an image button and a button tied
  to the form from outside it.
- **Enter** while the focus is on any of its controls except a multi-line
  box: a one-line field, but also a checkbox, a radio button, a list or a
  slider. It is judged as the form's first submit button, **whether or not
  that button is enabled at the moment**: a page can enable its "Pay now" a
  moment after the last key, between the server's look at the page and its
  key press. Enter with any
  other key held (`Control+Enter`, `Enter+Alt`, in either order) is still
  Enter. Shift+Enter is a new line only in a multi-line box, and only as
  Shift and Enter alone.
- **Space** on a focused button, link or menu item, under every name the
  engine takes for it (`Space`, a typed `" "`, `Shift+Space` and the rest).
  It is judged as a click on whatever has the focus. In a text box it is a
  character.
- **Inside a frame.** A frame of the page's own site is read like the page:
  a click on an element in it, and Enter or Space with the focus in it, are
  judged the same way, with the frame's own form and fields. `<object>` and
  `<embed>` are frames too. A frame from another site, which is how most
  shops take a card, cannot be read. Enter or Space with the focus inside
  one is refused, in any chord, and so is text typed there with a line
  break: the bot is told to click the frame's button by its ref from a
  snapshot. That click is money when the frame is a payment frame of either
  kind (for typing a card in, or a payment brand's message or button) and
  the element is a button, link, menu item, option, tab or switch, whatever
  it is called; in any other frame it is judged by its name. A click or typed text aimed
  at the frame element itself is refused, because it lands on whatever is
  inside.
- **Inside a closed part of the page.** Some components keep their inside
  closed to scripts (a closed shadow root). Enter or Space with the focus in
  one is refused the same way, and so is either key with the focus on an
  element that cannot say what it is.
- Ticking a box or choosing from a list (`agent_browser_check`,
  `agent_browser_uncheck`, `agent_browser_select`) when that control, or its
  form, carries a handler written on the element (`onchange="…submit()"`)
  that submits. These three tools are otherwise judged exactly like a click
  on the same element: the engine's check and uncheck click whatever they
  are pointed at, a Send button included.

**Reload.** Reloading a page that a form was posted to posts it again. Once
a send or a payment has gone through in a browser (approved by you, or let
through by the daily allowance), every reload in that browser asks, for as
long as the browser stays open. Opening another address does not end it:
the page's own "back" link or script can put the posted page in front again.
The reload card names the site and whether it was a send or a payment. It
repeats nothing of what was sent. This asks more often than strictly needed.
Closing the browser ends it. So does restarting OpenMausBot while the
browser stays open, because the flag is kept in memory only: no state of a
browser session is saved across a restart to keep it in.

**Typed text with a line break.** `agent_browser_type` presses Enter for
every line feed and every carriage return in its text. The engine tries to
give its selector's element the focus first, and when it cannot (the element
is no field, is behind a modal, in a disabled group, hidden, or the selector
resolves to nothing) both the text and the Enter go to whatever has the
focus. And what Enter does at a field can change once the text is in it: a
"Pay now" button that is disabled until its field has text.

So **the text and its Enter never go to the engine in one call**. The
server does every typed line break in steps, whether or not the field
already has the focus:

1. It types the text before the line break, at that field.
2. It reads the page afresh. When the focus is on that same field, the
   Enter is judged exactly as an Enter press there, with the text now in
   the field, and pressed as a step of its own: a search or a sign-in goes
   through, and where it would send or pay it waits on a card. When the
   focus is anywhere else, Enter is not pressed, and the bot is told the
   text was typed but the field did not take the focus.
3. A field the read can tell cannot take the focus (disabled, in a disabled
   group, under an inert parent, hidden, or outside a modal that is open)
   gets nothing: no text, no Enter. The engine would have put the text into
   whichever field had the focus.

The text is typed once: the call as the bot wrote it is never sent. A
carriage return followed by a line feed is one line break here (the engine
alone would press Enter twice).

Text of several lines runs only into a multi-line field that already has
the focus and is no composer, one line and one Enter at a time. At the first
Enter that is not a plain new line the server stops, and says how far it
got. Text with more than 50 line breaks is refused: use `agent_browser_fill`.

Everything else stays refused, with the bot told to click the field first,
or to fill it and then press Enter: a target that is no text field, a
selector that resolves to nothing, a line break with nothing before it at a
field without the focus, several lines anywhere else, and any text with a
tab.

**Selectors.** The server reads the same element the engine would act on,
and for a click by ref it also judges the name the last snapshot gave that
ref. Where two elements share one box, the one a click at its centre lands on is
judged; where that cannot be told, all of them are, and the card shows the
most serious. A selector with stray white space around it is tidied, and the
tidied one is what is sent. A selector over 2,000 characters, or one that
starts with a dash, is refused: the bot is told to use a ref from a snapshot.
An element the engine finds but the server cannot describe (it is inside a
frame from another site, or has no area) is judged by the name the last
snapshot gave it, as money when the page has a payment frame it could be in,
and refused when it has no name. The engine measures an element inside a
frame from the frame's own corner, so a ref can also match something else on
the page; when the snapshot's name is not that element's and the measured
box starts within a payment frame's own size, it is taken to be in the
frame.

**Two reads.** The server first reads only the element and its form or
region, enough to decide. A click that is no commitment goes on at once,
however large the page. Only for a commitment does it read the fields, the
text around the button and the rest of what the approval is bound to.

### What the card shows

The site, the button's label, the text of the row, list item, card or dialog
the button is in (so you can tell which "Buy now" it is), and the form's
visible fields as they are right now. On a page with no form, the filled
fields of the dialog or region around the button stand in for the form's.
Fields elsewhere on the page are never listed. When the button has no form
and no region with a field of its own, the card says how many other filled
fields the page has, and the approval covers them all the same. The card
shows the first twelve fields and the first 200 characters of each. It says
when a value was shortened, with its full length, and how many fields it
left out. Text in a value that looks like a credential is masked, and so is
a card number written inside other text. The text around the button cannot
be shown in part: when it names a secret (a password, a code, a key) or
holds a card number or a credential, it is left off the card, and no picture
is taken.

A field is called by its label's own words, cut to 60 characters: never by
the text or value of a control inside the label (a text area's content, a
list's choices). Fields inside a component's open shadow root are read like
any others. A component that keeps its inside closed cannot be read: when
the form or region holds one, the card says "Part of this form could not be
read", and what is in there is neither on the card nor part of the approval.

**Values the card never carries.** Some values are counted inside the page
and never leave it: the card, the notification and both logs say only how
long each is ("16 characters, not shown"). The server's own script does read
them in the page, to count them and to test for a card number. It sends back
the length and nothing else. These are:

- a password field, and a field whose autofill type is a current or new
  password, a one-time code, or anything of a card (`cc-number`, `cc-csc`,
  `cc-exp`, `cc-name` and the rest);
- a one-line field whose name, id, label or placeholder says it is a card
  number, a security code (CVC, CVV), a code of any kind (one-time,
  verification, backup, or just "Code"), a PIN, a password or a passcode, a
  security answer, a key, a secret or a token, a recovery or backup phrase,
  or a national, tax or bank identifier (a social security or national
  insurance number, a passport number, a tax number, an IBAN, an account or
  routing number, a DNI, NIF, CPF and the like), in English or by its common
  Spanish, French, German or Portuguese name. A password shown as plain text
  is still one;
- a box of many lines whose name says it is a key, a secret, a token or a
  recovery phrase;
- any value that is 13 to 19 digits and passes the card-number check (Luhn),
  whatever the field is called.

Any other multi-line message is never hidden for its label, because it is
what you are asked to approve. "PIN code", "Pincode", "Postal code" and
"Promo code" are shown: they are not secrets.

**The picture.** While the card is open it also shows a screenshot the
server takes itself, removed once the card is answered. No screenshot is
taken when the page shows any of the fields above, anywhere on it, or a
payment or sign-in frame from another site that cannot be looked into, or
when the page could not be read at all: the picture would show what the card
masks. The card says so. A screenshot left by a server that stopped while a
card was open is deleted the next time the server starts.

**An approval covers what you were shown, and everything that goes with it.**
It is bound to the address, to the element itself (where it sits in the page,
and the attributes that say what it does), to the text around it, and to
every control of the form or region: each field at full length, the fields
and the text the card had no room for, hidden fields and fields that are not
displayed, which boxes are ticked and what each list has chosen (tick boxes,
switches, radio buttons, options and toggle buttons that are roles on a
plain element too, by their `aria-checked`, `aria-selected` and
`aria-pressed`), fields inside open shadow roots, and the text inside a
frame of the page's own site (a rich-text editor keeps its message there). When the region around a button with no form has no control
of its own, it is bound to every control on the page. When you answer, the
bot's selector is resolved again. If it now points at another element, or
any of the rest changed, nothing is clicked, the card says the page changed,
and a new card is raised for the page as it is. If the bot's request has
gone away by then, nothing is clicked either.

Some changes are not changes. An element's style, classes and state
attributes are not part of what it is, so a button a page keeps restyling is
still that button. In the text around it, relative times ("3s ago", "just
now", "in 5 minutes") and clocks are evened out before comparing; any other
number, a price included, is compared as it is. **A page that keeps changing
by itself:** when two approvals in a row are void, the third card says the
page keeps changing, and that approval is bound to the address, the
element's label and every control as above. It is not bound to the text
around the element, to its attributes, or to its place in the page: a list
that keeps gaining rows above a button moves it every time.

The bot's call waits up to nine minutes, the same as a connected-app send, or
up to the configured MCP call timeout when that is shorter. Then the card
closes and the bot is told nobody answered. The card also closes, and the
browser is the bot's again, as soon as the call behind it is gone: the turn
was stopped, the engine cancelled the call or went away, or the hold itself
failed part-way. Allowing a card that has closed clicks nothing. On Deny the
bot is told not to retry and to ask you what you want instead. Each hold and
each answer is in the bot's activity log and the decision log, with the site
and the label.

While a card is open the bot can still read that browser but cannot act in
it. You can use the browser yourself at any time, and your own clicks are
never held. When you hand it back after touching the page, the bot's next
browser result starts with a line telling it to re-read the page.

**What an action changed.** After a click, a fill, typed text, a key press,
a select or a check, the server reads the page's address, title and visible
text before and after, and the bot's result ends with what changed, so it
does not have to read the page back. This is the same for an action you
allowed on a card, for typed text and for the Enter after it: each is read
around once it is sent. A call that is waiting on a card, or that was
refused, is not read for this, and a refusal never carries any of it: the
bot gets the refusal in the server's own words. No action is sent, and no
page is read ahead of one, while a card is open or while you have the
browser: an action that was already on its way when a card opened is
stopped before it reaches the page. The read sits between the server's last
look at the page and the action itself; on a local test page it took about
25 milliseconds. If the bot's call is cancelled during it, the action is not
made.

**A browser call that never answered.** A call that outlasts its time limit
(a page waiting on a slow server) may still be running, and may already have
taken effect. The browser is not restarted for it: the bot's next call first
waits for the browser to answer again, and is then told that the earlier call
has ended, where the page is now, and that this call did not run. That next
call is not judged and raises no card, whatever it was. Asked again, it is
judged like any other. Until the bot has taken a new snapshot, a click, a
check, a select or typed text with a line break aimed at a `@ref` from
before the lost call is refused: the browser gives its refs new numbers with
every snapshot, and one may have been lost with that call, so the server can
no longer tell what such a ref would act on. A selector that is not a ref is
read and judged as ever. A card is not a lost call: a
call that waits on you keeps nothing running in the browser, however long
you take. And when a call is lost while a card is open, Allow sends nothing
until the browser answers again: the card closes, and the bot is told the
page could not be read.

### Page scripts

A bot can run a script in the page (`agent_browser_eval`). A script is
refused, not held, when its text:

- clicks or submits something, by the element's own method or by calling its
  handler (`el.click()`, `form.submit()`, `el.onclick()`);
- sends a network request (`fetch`, `XMLHttpRequest`, `sendBeacon`,
  `WebSocket`, jQuery's `$.post`, `$.ajax` and `$.get`, `axios`);
- writes into a field, or changes what the rules above read an element by:
  its text, its role, its type, its attributes (`setAttribute`,
  `removeAttribute`, `el.ariaLabel = …`), or whether an option is chosen
  (`option.selected = …`). A script that fills a result of its own is a
  read and runs, when that result is made as an empty object or array,
  once, under a name used for nothing else (`const out = {}; out.value =
  el.value`). `const el = [document.querySelector("#amount")][0]; el.value
  = "999"` is a write to the page and is refused;
- makes an event by hand (`dispatchEvent`, jQuery's `.trigger(…)`, or a
  handler of a person's own action called directly: `el.onchange()`,
  `el.onkeydown(…)`). `x.onload()` and `emitter.once(…)` are not that;
- navigates.

The bot is told to use the click and fill tools, which the rules above
cover. A line break typed with `agent_browser_type` is a real Enter key
press; it is refused where it would send or submit, and wherever the server
cannot be sure which element it lands on (see "Typed text with a line
break" above). Typed text with a tab and a line break is refused wherever it
is typed: a tab moves the focus, so the server cannot tell where that Enter
would land.

This is a guard against a bot acting through a script by habit. **It is not a
wall**: it reads the script's text, so a script written to hide what it does
(a method name built from pieces, a library the list does not know) gets
past it.

### Limits

The hold is a guard against a bot over-acting on ordinary pages. It is not a
guarantee that nothing is ever sent or paid without a card. What it does not
catch:

**Payments**

- **A payment behind a button that says nothing of money, on a page with no
  card field.** "Confirm", "Continue", "Complete", "Approve" or "Authorize"
  on a one-click checkout that charges a saved card passes: there is no card
  field, no frame for typing a card in and no money word to go by. This is
  the largest gap. A check on the payment request itself is planned as
  separate work.
- **A page with a wallet or pay-later frame, and no card field of its own.**
  That frame does not make the page a card region, so a "Continue" on the
  page beside a wallet button is judged by its label and passes. Only a
  click inside the frame is money.
- **A payment frame known only by its address.** A frame with no title,
  name or label that says card, payment or checkout, served from an address
  that is not one of the few known card-field hosts, is not recognised at
  all: the page around it is no card region, and a button inside it is
  judged by its name.
- A card region with no autofill hints and only one sign (a field called
  "Card number" and nothing called a security code or an expiry, with no
  card number typed in yet) is not read as one. A library or membership card
  form that also asks for an expiry date is.
- **Card fields the read cannot name.** A card number split over several
  boxes, and fields whose only label is text in a neighbouring table cell
  (no `<label>`, no placeholder, no `aria-label`, no telling name or id) are
  not recognised as card fields.
- A button with no form is judged by the nearest region around it. One that
  sits in a different section from the card fields it pays with is judged by
  its label alone. The other way round, on a page with no regions at all,
  every button outside a form counts as inside the page's card region when
  the page holds a card signal, so an unrelated button there asks too.
- A list inside a payment frame that submits when its choice changes
  passes: nothing can be read in there, and only a button, link, menu item,
  option, tab or switch is taken for money.
- A plain element with the default cursor that pays when clicked, inside a
  card region, is not taken for a control.
- The word lists are English. A "Pagar" button outside a card region passes.

**Sends**

- **An English send label the lists do not know.** On an English page a
  form with a multi-line field is not a send unless its button says so by
  one of the listed words. "Dispatch", "Broadcast", "Ship it" or "Go" on a
  message form passes.
- **A link that commits when it is opened.** A plain link is never held, and
  opening an address never is: a one-click unsubscribe, or a "Send" link
  that sends by loading a page, goes through. So does a `#/…` route or a
  contents link whose page acts on it by script.
- A send on a form with a password field and no multi-line field, or an
  "Apply" with no file and no multi-line field (a one-click job
  application).
- **Enter in a box the rules do not take for a composer.** A chat box that
  shares its region with another text field and has no keyboard hint, or
  whose name is not in English and has no Send button beside it, sends on
  Enter without asking. A one-line box outside any form that sends on Enter
  is not recognised either.
- A page that is not in English and does not say so (no `lang`), with a send
  button in plain Latin letters ("Enviar"), is read as English: on a form
  with a multi-line field it passes. With no multi-line field a send button
  in another language passes on any page.

**What it cannot see**

- A page script, a listener added with `addEventListener`, or a field that
  submits as it is filled. A list or checkbox is held only for a handler
  written on the element.
- Inside an embedded frame from another site, such as a payment or comment
  widget, a click is judged by the name the last snapshot gave the element,
  and as money when the frame is recognised as a payment frame. The card
  shows no fields and no picture, and the approval is bound to that name and
  the address, not to the element itself. Enter and Space there are refused,
  not judged: the bot has to click the frame's button instead. The same
  holds for a closed part of the page, and for a focused custom element that
  does not say what it is: the refusal there can be a false alarm.
- **Inside a component that keeps its contents closed** (a closed shadow
  root): its fields are not listed, not counted as card fields and not part
  of the approval. The card says part of the form could not be read when it
  can tell: the component has no content of its own on the page and takes up
  room. One it cannot tell from an ordinary element goes unmentioned.
- A typed space is not judged: the engine inserts it as text, with no key
  press. Only a Space key press is.
- A secret in a field that nothing marks as one (no type, no autofill hint,
  no telling name, not a card number) is shown like any other value. A frame
  from another site that holds one, and does not name a payment or a
  sign-in, is in the picture.
- **A button that a script enables just after typing, and that is not its
  form's submit button.** The server looks at the page and then presses the
  key, and a page can change in between. For Enter in a form's field that
  gap is closed: the form's submit button is judged even while it is
  disabled. For anything else it remains: a button outside a form, or a
  script that starts listening for Enter a moment after the last key, is
  judged as it was when the server looked. The server's read of the page
  for "what an action changed" is inside that gap, and makes it about 25
  milliseconds longer.
- **A turn stopped with a card open.** The card closes at once; the call
  behind it notices within a second. An Allow sent in that second is
  recorded as allowed and then as closed because the call was gone. Nothing
  is clicked.
- After OpenMausBot restarts while a browser stays open, a reload in that
  browser is no longer held: what was sent before the restart is not
  remembered.
- On a page that keeps changing by itself, the third card is bound to less:
  with a selector that is not a ref, it can then be used for another element
  with the same label and the same controls around it.

**Where it asks, or refuses, more than it needs to**

- **Buttons that only open something, but carry a word from the lists,
  still ask.** The rules go by the label, and cannot tell a button that
  sends or pays from one that opens a dialog or the next page. Measured on
  ordinary pages: "Forward", "Share screen", "Subscribe", "Notify me",
  "Renew", "Sell", "Message", "Proceed to checkout", "Book appointment" and
  "Charge" each raise a card. So do "Upgrade", "Trade" and "Reply".
- **A page with a frame that calls itself payment or checkout** (one titled
  "Checkout", or an express-checkout frame that names no brand) is a card
  region: every button around it asks, "Add to cart" included, not only the
  one that pays.
- Under **Allow a daily amount**, the shared count goes up for every browser
  press the rules read as a send, and some of those send nothing: a "Reply"
  button that only opens a box to type in. The daily number is used up
  sooner than the sends alone would.
- Inside a card region every button asks, a quantity stepper, a tab and a
  "Terms" link included.
- On a page in another language, every form with a multi-line field asks
  unless its button has one of the listed harmless labels: "Speichern" on a
  notes form asks.
- **Some typed text with a line break is still refused** where it would
  have been harmless: a line break alone, or several lines, at a field that
  was not clicked first; several lines stopped part-way because one Enter
  was not a plain new line; more than 50 line breaks; text at a field the
  read wrongly takes for unreachable; and, on a page with a frame, text
  typed by ref into a field the snapshot gives no name (or another name than
  the read does). Use `agent_browser_fill` and press Enter.
- Typed text with a line break takes several engine calls where it used to
  take one: the text, a look at the page, and the key.
- When the server types the text itself and the Enter is then declined or
  refused, the text stays in the field.
- Enter in a field asks when the form's pay or send button is disabled,
  although Enter would do nothing at that moment.
- **More than 5,000 fields in one form or region:** a commitment there is
  refused, not held. The approval could not be bound to all of them.
- **A reading script that fills a result it did not start empty.** `const
  row = { id: 1 }; row.value = cell.innerText`, a second name in one
  declaration (`const a = {}, b = []; b.value = …`), and a result declared
  with `let` or `var` are refused as writes. Start from `const out = {}`.
- A number that changes in the text around the button (a price, a count)
  voids an approval like any other change. On a page where that keeps
  happening, two cards are void before the third one stops minding the text
  around the button.
- After any send or payment in a browser, every reload there asks until the
  browser is closed.

**Elsewhere**

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

OpenMausBot's built-in agents MCP server describes its scoped reads with
explicit read-only, non-destructive, idempotent, closed-world metadata:
`list_bots`, `list_rooms`, `list_threads`, `assignment_status` (and its
deprecated aliases `check_delegation` and `wait_delegation`),
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
provider's session. Its quieter default is Full access; OpenMausBot keeps Ask
as the default, and Full access is one pick away, applied without a
confirmation.

## Verification for contributors

The [Full Access workflow recipe](verification/full-access.md) tests immediate
profile, routine, team, skill, and peer actions through the real server and MCP
proxy. Its fixture also verifies that explicit Ask sibling threads still wait.

Run `pnpm exec electron scripts/smoke-approval-modes.cjs` to exercise the real
private desktop-to-server grant protocol in a disposable fixture. It verifies
that Full access applies over HTTP while Custom is refused there, Full → Auto → Ask on resumed Claude turns, and
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
