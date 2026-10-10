# Bot memory

By default, bots keep notes between tasks. The notes are plain markdown files in a
folder on the computer running OpenMausBot — nothing is stored anywhere else,
and you can open, edit, or delete any of it in any editor. **Bot Settings →
Memory** shows the same files with a gauge of how much of them actually loads,
an editor that never overwrites something the bot wrote while you were typing,
and a journal of every change with one-click undo.

The **Let this bot use memory** switch is on by default. Turn it off while the
bot is idle to stop loading `MEMORY.md` into new turns, stop automatic recall
and upkeep, hide native memory tools, exclude memory files from `session_search`,
and stop automatic daily turn logs. Existing files remain for review. A bot
with filesystem access can still edit those files directly; use standing
instructions to forbid that when memory must stay in another source of truth.

## Where it lives

```
~/.openmausbot/workspaces/<botId>/
├── MEMORY.md            the notes that load into every conversation
└── memory/
    ├── <topic>.md       longer notes the bot reads on demand
    ├── archive.md       older notes moved out of MEMORY.md, and expired ones
    └── log/
        └── 2026-09-10.md   what the bot did that day, in its own words
```

The folder is the bot's private workspace: the directory its file tools work in
when it has no project folder set. It is created the first time the bot runs a
turn. **Open in Obsidian** and **Show in Finder** (Explorer, or your file
manager) in the Memory panel open this folder; because it is on the server's
disk, those buttons only work from the computer running OpenMausBot — a
paired phone or a remote browser is shown the path instead.

Files are written with owner-only permissions (`0600`), atomically (a crash
mid-write leaves the old file intact, never a torn one), and anything that
looks like a credential — API keys, tokens, `password: …` lines, private key
blocks — is replaced with `«redacted N chars»` before it reaches disk. A bot
that helpfully "remembers" a key it read from a `.env` does not get to keep it.

## What loads, and the budget

At the start of every turn the **first 200 lines or 24 KB of `MEMORY.md`,
whichever cuts first**, are placed into the bot's system prompt. Nothing past
that line loads, and the bot is only told that the file was cut off. Topic files
and daily logs are never loaded automatically; the bot reads a topic file with
its file tools when it decides it needs it, and logs are for you.

The gauge at the top of the Memory panel is that rule made visible: lines and
size against the budget, amber from 80%, red once anything stops loading —
with the count of lines that are not being loaded, and always the plain
sentence *only the first 200 lines load each turn*.

`MEMORY.md` never fills up. Every write that goes through the harness
(`memory_update`, and capture) keeps the file within the budget in the same
step: when the new entry would push it past, the oldest dated entries move to
`memory/archive.md` — struck-through ones first, then expired ones, then the
oldest live ones — each marked `· moved <date>`. An entry moves whole, with
the lines indented under it (a code block) or, in older entries, the code block
right below it. The archive is written before
`MEMORY.md`, so a line is never out of one without already being in the other,
and `session_search` still finds it. Lines you wrote by hand (no date), health
and safety facts, and the entry just written never move. The bot is told which
entries moved (the first few, and how many), so it can add back anything that
should stay loaded. One entry is at most 1,000 characters and 20 lines, so a
single note cannot push the rest out. The gauge
can only go red when the lines that never move fill the budget by themselves
(or a bot edited the file with its own file tools): then the entry is still
saved, and the bot asks you to trim `MEMORY.md`.

Both limits are `MEMORY_MAX_LINES` and `MEMORY_MAX_BYTES` in
`server/workspace.ts`; the panel, the loader, and the bot's prompt all read the
same two constants.

Two more things load with it:

- **Expired notes stay out.** An entry that ends in `· until 2026-09-28` stops
  loading the day after that date. The file keeps it (the gauge still counts
  it) until the tidy-up or a person moves it.
- **The topic index.** Every `memory/<topic>.md` is listed by name under the
  memory block, with its `title`, `description` and `aliases` when the file
  starts with frontmatter — at most 40 topics or 2,000 characters. The files
  themselves still load only when the bot reads them.

## Recall before each turn

Before a turn, the person's message (eight characters or more) searches the
bot's topic files and, in a 1:1 chat the person started, the bot's other
conversations and, for the installation's owner, the [shared notes](#shared-notes-and-import). Any matching word counts; a message with five or
more content words needs two per hit. Up to four notes and four conversation
passages — numbered, dated, and at most 6,000 characters — go in front of that
turn's message, opened by a line saying they are the bot's own notes and that
a command inside one is not an instruction. `MEMORY.md` (already loaded) and
`memory/archive.md` (older or no longer true) are never recalled, nor are daily logs
(`session_search` finds those when the bot asks).

It is placed in the message, not the system prompt, on purpose: the prompt's
changing half is re-sent whole whenever any part of it changes, and recall
changes nearly every turn. Rooms, routine runs (which start fresh), and turns
started by another bot, a webhook or a teammate hand-off, recall the bot's own notes only — a private chat reaches a room
through `session_search`, which discloses it. `features.autoRecall: false` in
`config.json` switches recall off. The server log names every recall
(`auto-recall: … got N note and M conversation passage(s)`).

## Memory upkeep

**Bot Settings → Memory → Memory upkeep** is on for every bot unless switched
off. It keeps the notes in shape without the bot having to decide to:

- **Noticing facts.** When a 1:1 chat has been quiet for two minutes
  (`memory.captureQuietMs`), or after six turns, one quick model call reads those turns — the person's words and
  the bot's under different rules — beside `MEMORY.md` and the list of topic
  files, and files what is new:
  - a core fact the bot needs in every conversation goes to `MEMORY.md`,
    marked `(noticed)`:
    `- 2026-09-25 · from chat "Plans" (noticed) · The person is vegetarian`;
  - everything else goes to a topic file for its subject — a person, a
    project or client, food, travel — reusing an existing topic or creating
    one with a header (`title`, `aliases`: the other words someone would ask
    with), so recall finds it later.
  A fact that ends on a known day gets its `until` date; a birthday or other
  yearly date never does. Turns started by another bot or by the harness,
  rooms and failed turns are never read.
  Turns still waiting when the app quits or restarts through its normal
  shutdown are kept as their ids (never their text) in
  `memory-capture-pending.json`, at most 50 chats, and read back from the
  chat at the next start, so what was said just before quitting is still
  noticed. A crash or a forced kill skips that step (on Windows a `SIGTERM`
  is one), and those turns are not captured. A chat deleted or rewound
  meanwhile leaves nothing to read.
- **Organizing.** Whoever wrote a line in `MEMORY.md` — the bot with
  `memory_update`, the person, or capture — after each capture and in the
  nightly tidy-up one quick model call looks at lines not judged before and
  moves the ones that are detail about a subject (another person, a project
  or client, a trip, likes in one domain) into that subject's topic file,
  unchanged, creating it with a header and other words for it. Core facts —
  the person's name, where they live, their company, diet, allergies and
  health needs, how they like replies — always stay; a line about diet,
  allergies or health is never even offered for moving (a fixed rule, not the
  model's choice), and a line judged core is not asked about again. At most 20 lines move in one pass; each file's change
  is a journal row (*filed into topics*) that can be undone.
- **About me.** A lasting fact about the person, taken from their own words,
  is added to **Settings → General → About me**, which every bot reads, as a
  dated line `- 2026-09-25 · learned by Scout · …`. **Added by your bots**
  under About me lists each one with **Remove**; a removed fact is never
  added again. On a shared installation, another person's messages never add
  to the owner's About me.
- **Nightly tidy-up.** Once a day after 3 am (`memory.tidyHour`), or at the
  next check if the computer was asleep, never while the bot is working, and
  on **Tidy up now**: expired entries move to `memory/archive.md` (from
  `MEMORY.md` and topic files); of two entries with exactly the same fact the
  newer stays; and in `MEMORY.md` one model call looks for pairs that cannot
  both be true, striking the older through (`~~…~~ · superseded <date>`)
  rather than deleting it; when that line also held something still true
  ("lives in Pune and prefers short replies"), that part is kept as its own
  entry `from tidy-up`. At most a fifth of the entries can be struck in one
  pass, and none in a file of fewer than five. The archive is written before
  the file it came from, so undoing the newest change never loses a line.

"Exactly the same fact" is narrow on purpose: spacing, a bullet and a final
full stop are ignored, nothing else — `Balance is -10` and `Balance is 10`,
`C++` and `C`, `1.5` and `15` are different facts.

Every upkeep change is a journal row by **Memory upkeep** and can be undone.
Upkeep pauses while a backup runs. The model steps need an engine with a
one-shot text call — Claude, Grok, OpenAI-compatible, Mistral and MiniMax,
and the agent engines that speak ACP (Grok CLI, Gemini, Kimi, Droid, Cursor,
OpenCode, Qwen, Hermes, Antigravity and custom ACP agents). On an ACP engine
each call starts the engine's own CLI in a fresh session of its own, never a
chat's, in an empty folder, with no MCP servers and in the ask-first approval
mode; it is refused and dropped the moment the agent asks for a tool, a file
or a permission. The text goes only to the provider the bot already uses.
On any other engine (Pi, for now) the panel says so and only the expiry and
exact-duplicate steps run.

## Editing

`MEMORY.md` and every topic file can be edited in the panel. A save carries
the hash of the text you opened; if the bot changed the file in between — it
writes with `memory_update` during a task, or with its own file tools — the
save is refused and the panel says so: *Scout changed this file while you were
editing.* **Reload** shows the bot's version and keeps your draft under the
editor so nothing you typed is lost; **Overwrite with mine** saves yours over it.
Either way the change is in the journal and can be undone.

Daily logs are read-only in the panel (they are the bot's own record) but can
be deleted. `MEMORY.md` can be emptied but never deleted — the bot expects it
to exist. Topic names are one file name under `memory/`: letters, numbers,
spaces, dots and dashes, ending in `.md`. Nothing nested, nothing starting
with a dot.

The old whole-file `PUT /api/bots/:id/memory` still works for one release; it
has no hash check, so it can overwrite what the bot just wrote. Clients should
move to `PUT /api/bots/:id/memory/file` with `expectedHash`.

## What a bot knows about its other conversations

A bot's 1:1 chats and its rooms are separate conversations, and its memory
holds only what stays true — so on its own, a bot answering in a room had no
idea what it did in its 1:1 an hour earlier, and a morning standup ended in
guesses. Three things close that gap without attaching transcripts:

- **The recent-work brief.** Every turn's system prompt, 1:1 or room, carries
  a short block: the newest thing the bot said in each of its *other*
  conversations over the last two days — `today 09:05 · 1:1 with Milind ·
  "Invoice reconciliation" · you said: "Sent the three flagged invoices…"`.
  At most ten lines and about 350 tokens; the current conversation is not
  listed. When a brief in a room names a private 1:1 chat, the room gets a
  chip — *Lead's recent-work brief covers 1 private chat with you* — once per
  chat, the same rule as recalled messages.
- **One log line per finished turn when memory is on.** The harness appends what the bot said
  last, the tools it used, and whether the turn failed to
  `memory/log/YYYY-MM-DD.md`, sourced to the chat or room. The log is never
  loaded into a prompt; `session_search` finds it.
- **Recall by time.** `session_search` takes `since` (`"24h"`, `"3d"`,
  `"yesterday"`, or a date) and `until`, with or without words, and covers
  the rooms the bot is a member of as well as its 1:1 tasks. "What happened
  since yesterday's standup" needs no keyword. Hits name the room or task
  they came from; a private chat recalled into a room is marked, and the
  room is told.

A daily standup is then a room routine: the chief asks, each member answers
from its brief and pulls detail with `session_search since`, and what was
agreed shows up in each member's next 1:1 brief.

## The journal

Every change to a memory file that the app can see is recorded — yours from
the panel, the bot's during a task, an import, an undo — in
`~/.openmausbot/memory-journal/<botId>.ndjson`. It lives *outside* the
workspace on purpose: the bot's file tools point at the workspace, and a
record the bot could edit would not be a record.

Each row says who (bot, person, or import), how (in Settings, during a task,
from which chat, changed outside the app, undo), which file, when, the
before/after hashes, a short diff, and the full earlier text so **Undo** can put
the file back without anything else. Undo is itself a journaled change, so it
can be undone in turn. Two kinds of row cannot be undone and say so: one
whose earlier text contained a credential (the stored copy is redacted, and
restoring it would write the redaction marker into the bot's memory), and one
whose earlier text was too large to keep.

Bot writes are caught at the turn boundary. When a turn starts, the app notes
what every memory file says; when the turn ends, whatever differs is recorded
as the bot's work for that chat. A file that changed between turns — edited in
Obsidian, say — is recorded as yours, *changed outside the app*. Two of the
same bot's threads running at once are both diffed; a change lands under
whichever thread finished first. Journaling never fails a turn: a row that
cannot be written is logged and dropped.

## Conventions inside the files

The files are yours and the bot's, and any markdown is fine. The app itself
reads them as plain text and never requires a structure. The conventions the
bot follows when it writes are:

- **Dated entries in `MEMORY.md`.** A note the bot adds during a task is one
  bullet with its date and the chat it came from:
  `- 2026-09-10 · from chat "Follow-up" · the user prefers short replies`.
  A person's hand-written bullet without a date is just as valid.
- **Superseded, not deleted.** When a fact is replaced, the old bullet is
  struck through and dated rather than removed —
  `- ~~the office is in Pune~~ · superseded 2026-09-10` — so the file itself
  shows what changed. Struck lines still count against the budget; trim them
  when the file fills up.
- **Daily logs** under `memory/log/YYYY-MM-DD.md` are the bot's diary of what
  it did; they are never loaded into a conversation and are meant for you to
  read in the panel or in Obsidian.
- **Until dates.** A fact that stops being true on a known day ends with
  `· until YYYY-MM-DD` (`memory_update` takes an `until` field for it) and
  stops loading the day after.
- **Topic files** are ordinary markdown. A topic may begin with a small YAML
  frontmatter block — `title`, `description`, and `aliases` (other words for
  the topic, since notes are found by matching words) — which the topic index
  reads, and may link to another topic with an Obsidian-style `[[wikilink]]`,
  which the app leaves as text. A pointer in `MEMORY.md` to a topic (`see memory/clients.md`)
  is how the bot knows the topic exists.

Nothing about the panel depends on these: an older `MEMORY.md` written in
free form, or one you rewrite by hand, works the same.

## Shared notes and import

Some facts about you belong to no single bot: where you live, who is in your
family, what you like to eat. **Shared notes** hold them, one markdown file per
subject, in a folder every bot can recall from:

```
~/.openmausbot/shared-notes/
├── food.md
└── family.md
```

A shared note has the shape of a topic file: frontmatter with `title` and
`aliases`, then dated entries. It is found the same way, by a word your message
shares with the note's name, title or aliases; a common word such as "today"
or "help" never finds a shared note, whatever its title says. What is recalled
from a note is the entries that share a word with your message, the best match
first, up to 600 characters; a number of two or more digits counts as a word
there ("project 57"). When only the note's name or an alias matched, its first
entries are given.

- **Only in a private chat you started.** A shared note is recalled in a 1:1
  chat with you. It is never recalled in a room, a routine run, or a turn
  started by another bot, a webhook or a teammate hand-off.
- **Yours alone, and only when that is proven.** Shared notes belong to the
  installation's owner, like About me. The owner is whoever uses the computer
  OpenMausBot runs on, and any device paired with full access, as long as at
  most one address may sign in as admin. With a second admin, only the
  computer itself counts; on a hosted installation, which has no single owner,
  shared notes are not used at all. A note reaches a turn only when two things
  are proven, never because something is unknown:
  - **The request that started the turn was yours.** This is taken from how
    that request signed in, whether it sent a message, edited or resent one,
    or answered a question late. A message that waited in the queue keeps the
    proof it was sent with, across a restart too. Someone else's edit of your
    message is their turn, not yours. A turn nobody can be named for (a
    routine, a webhook, another bot's words, a turn resumed after a card)
    is never yours.
  - **Every line a person wrote in the conversation is yours, and every card
    a person answered was answered by you.** Each line you send, and each card
    you answer, is recorded as yours at that moment. A conversation that holds
    any other line or answer recalls no shared note from then on: a line from a device
    paired with chat-only access, a member, a second admin, a Slack relay, a
    routine's prompt, or a line someone else edited. Start a new conversation
    to have them recalled again. On My Cloud the same holds for a conversation
    a guest opened or wrote in.
- **Conversations from before this version.** Nothing recorded whose lines
  they were, so a conversation that already had messages when this version
  first started recalls no shared note by itself. A new conversation does,
  and About me is not affected. To have your notes used in the older ones,
  press **Use my notes in my existing conversations**, on the last page of an
  import or beside the Imported notes list. That is you saying you wrote the
  messages in them, so use it only if nobody else has written in them. Only
  the owner can press it (`POST /api/shared-notes/adopt` is refused to
  everyone else, and in the desktop app needs the app's own capability), and
  nothing is ever adopted without that click. It adopts every one-to-one
  conversation except one that holds: a message relayed from another service;
  a message from a device that is not one of yours with full access; a card
  that was answered from a signed-in device or by a local service; or a
  message or answer written since this version that was not proven yours. It
  also leaves rooms, and conversations a routine or a webhook ran in. It then
  shows how many it adopted and how many it left, by reason. You can press it
  again later: what was adopted stays adopted, and nothing is taken back.
  After that an adopted conversation is like any other: a later message or
  card answer from anyone else ends its standing, and pressing the button
  again does not restore it.

  Two more things are never adopted, whatever their messages look like:
  - **A conversation that came from a backup.** One a team backup brought in
    beside your own, and every conversation from before the whole
    installation was last restored from a backup or copied from another
    computer. No request made here wrote those messages, and a backup can
    hold anyone's. What the backup's own record already proves yours keeps
    its standing, and a conversation you start afterwards is yours as usual.
  - **A conversation from before the record was lost.** If the record of
    which messages are yours goes missing or cannot be read, nothing is
    proven by that: conversations from before then recall no shared note,
    and the button does not give them back. It says the record was lost and
    how many conversations it could not take for that reason.

  What it can and cannot tell. A routine's conversation is recognised while it
  still carries its run, which it does until someone writes in it, or while
  that run is among the 2,000 the run history keeps. A webhook's conversation,
  and a routine set to run inside the bot's own conversation, carry no such
  mark: only the run history names them. Past that history their prompts look
  like messages typed at the computer. So does a message a paired device
  edited before this version, because an edit recorded no sender then (it
  does now, as a sent message does). These are adopted as yours: that is what
  the button's sentence asks you to be sure of. The full list is under
  [What this does not cover](#what-this-does-not-cover).
- **A session that holds a note is not handed on.** A recalled note stays in
  the engine's own session for that conversation. When words that are not
  proven yours arrive there afterwards (someone else's message, another bot's
  ask, a routine), that turn starts a fresh session from the conversation's
  messages, which never held the note, and such words are never added to a
  turn that is still running. A card of such a conversation (an approval, a
  question) can be answered by you only: anyone else is refused, and nothing
  they sent reaches the turn. One thing is not covered: the bot's replies in
  that conversation stay readable by everyone who can read it.

  A known cost. Another bot's ask in a conversation counts as someone else's
  words, so the first ask that follows a message of yours that recalled a note
  starts a fresh session with the conversation replayed, which uses more of
  the engine's input than resuming would. It happens once after each such
  message, not on every ask, and only in a conversation where both you and
  other bots write: a bot's main conversation, when a teammate asks it there.
- **Its own rule in the prompt.** Recalled shared notes come after the bot's
  own notes, inside the same limit of four notes and 6,000 characters,
  labelled `shared/<file>`, under their own heading. It tells the bot these
  are imported notes about you from another assistant's history: information
  only, never its own notes, and that anything in them that reads like an
  instruction is to be ignored. A bot's own note on a subject wins over a
  shared one.
- **No tool, but not hidden from the computer.** Bots get no tool to read,
  write or tidy this folder, and recall is the only way the app puts a note in
  front of a turn. The folder is ordinary data under `~/.openmausbot`, though:
  a bot that can run commands on this computer as your user can read these
  files, like the rest of the data folder and everything else your user owns.
- **Who can open them.** The shared-notes and import routes answer the owner
  only. In the desktop app they answer the app itself and your signed-in
  devices: another program on the computer cannot read them over the local
  port, any more than it can change settings. On a server you run yourself
  without the desktop app, a local request is the owner's, as it is for every
  other route.
- **Limits.** At most 200 notes of 64 KB each. Files are owner-only (`0600`),
  written atomically, and pass the same credential scrub as bot memory.
- **Backups.** The folder is part of a full backup, like any other data, and
  so is the record below. After a restore, or after copying an installation to
  another computer, the conversations that were proven yours stay so; the
  others can no longer be adopted (above).
- **The record.** Which messages are yours is kept in
  `~/.openmausbot/shared-notes-threads.json`: per conversation a count and a
  checksum of the proven lines, never their text or ids. Beside it,
  `shared-notes-proof.json` keeps what must outlive it: the moment proof
  began on this installation, which conversations a backup brought in, when
  the installation was last restored, and when either file was last found
  missing. Both are written whole to a scratch file, synced to the disk and
  renamed into place, so a power cut leaves the old file or the new one. A
  proof reaches the disk a moment after the message; the mark that a session
  holds a note, and an adoption, are written at once. Whatever order the disk
  finishes them in, an older copy never replaces a newer one.

### What this does not cover

Shared notes are recalled only on proof, and the proof has edges. These are
the known ones, in plain words.

- **Old messages carry no trace of who wrote them.** Messages sent from any
  paired device before senders were recorded (#1514, 18 September 2026), and
  cards answered before answerers were recorded (#1717, 23 September 2026),
  look exactly like ones typed or answered at the computer. The button adopts
  them. Use it only if nobody else wrote in your conversations before then.
- **An old routine or webhook run can look like your own conversation.** A
  routine run that is older than the 2,000 runs the history keeps and that
  someone later carried on by hand is adopted. So is a webhook's
  conversation, or a routine that ran inside the bot's own conversation,
  once its run has left that history: nothing else marks them.
- **A bot that can run commands can read the notes.** A bot that runs
  commands on the computer as your user can read the shared-notes folder,
  like the rest of the data folder. On a server you run yourself without the
  desktop app, where a local request counts as the owner's, such a bot can
  also call the owner's routes, the adopt button's included, and can change
  or delete the record files.
- **A crash can cost a conversation its notes.** A proof is written a moment
  after the message. If the server is killed in that moment, that line is
  never proven and its conversation recalls no shared note from then on.
  Start a new conversation.
- **Both record files gone is a fresh start.** If the record and the file
  beside it are both deleted, the next start cannot tell it from the first
  one: proof begins again, and every existing conversation counts as older
  and can be adopted. One of the two missing is a loss, and adopts nothing.
- **Some of your own conversations can never be adopted.** One where you
  wrote from a device you have since removed, or answered a card from a
  signed-in device rather than at the computer; one that came from a backup,
  or from before a restore or a move to another computer; and any from
  before the record was lost.
- **A chat-only device that answers a card ends that conversation's
  standing.** Its approval or answer is someone else's, like a message of
  theirs would be, and the conversation recalls no shared note afterwards.
  Where the conversation's session already holds a recalled note, the answer
  is refused instead.
- **Another bot's ask replays the conversation.** The first ask from another
  bot after a message of yours that recalled a note starts a fresh session
  with the whole conversation sent again, which uses more input.
- **A note is found by its subject or an alias, nothing else.** A message
  that is about a note's content but shares no word with its name, title or
  aliases recalls nothing from it.
- **The engine and its provider are not under this app's control.** The
  import deletes its own copies of your chat text. Whether the engine keeps
  its own is the engine's doing: the dialog says so beside the engine choice
  when it may. What the provider behind any engine does with text it is sent
  is that provider's policy.
- **The screens are a guard in front of your own review, not a guarantee.**
  The checks for secrets, sensitive subjects and instruction-like facts work
  on wording. An independent check of an earlier version of them, on
  wordings they had not been written against, found roughly half of the
  sensitive facts a model had left unlabelled still ticked (12 of 22) and
  roughly four in ten secret wordings still ticked (11 of 26), and about one
  in ten ordinary facts wrongly dropped (11 of 121). The rules were widened
  after that and now pass the project's own written sample, but those
  figures are approximate, the sample is small, and new wordings will get
  through at some similar rate. Read the list before you save.
- **Not tried.** A real ChatGPT or Claude export, a real model's answers, a
  hosted installation, a Cloud home and Windows have not been run with this
  feature. See `docs/verification/context-import.md`.

### Import from ChatGPT or Claude

**Settings → Profile → Import from ChatGPT or Claude** reads a data export
from either assistant, or text you paste, and proposes lasting facts about
you. Nothing is saved before you have reviewed it, and the chats themselves
are never kept. Only the installation's owner sees the button, because what
it saves goes to the owner's About me and shared notes.

1. **Choose a source.** The export zip (or the `conversations.json` inside
   it), or pasted text of up to 100,000 characters. Paste is there because a
   ChatGPT export may not hold its saved memories. An upload is at most 4 GB
   and has to arrive within 5 minutes, which is the server's limit for one
   request; over a slow connection, upload `conversations.json` by itself.
2. **Scan.** No model is used. The export is read as a stream on the computer
   running OpenMausBot, one conversation at a time, and the dialog shows how
   many conversations it holds, the date range, and what reading them will
   cost: the calls when nothing goes wrong, and the most there can be (every
   part read twice, plus up to ten checks for facts that disagree). The
   default is the last 12 months, newest first, at most 500 conversations; you
   can change the dates and the number (up to 2,000). A zip is read from its
   list of contents, so the photos and other files in it are never unpacked.
   One scan keeps at most 100,000 conversations, and a zip may hold at most
   100,000 files, of which the first 1,000 conversation lists are read, as
   long as together they unpack to no more than 8 GB; past any of these, the
   dialog says so. A list whose first 10,000 items hold no conversation is
   not a list of conversations: it is left there, unread, and the dialog
   names it.
3. **Read.** You pick which bot's engine reads it. When that engine may keep
   its own record of the text it is sent, the dialog says so under the choice
   before anything is read; it does not refuse (see below). Only your own
   messages are sent, with each conversation's title and date: each message cut at 1,500
   characters, code blocks dropped, 6,000 characters a conversation, about
   24,000 characters a call. You can pause, resume and cancel, and close the
   window while it runs. One import proposes at most 2,000 facts: it stops
   there, leaves the remaining conversations unread, and importing the same
   file again reads them.
4. **Review.** Facts are listed in two groups. **Core** (at most 30) goes to
   About me, which every bot reads on every message. The rest is filed by
   subject in shared notes, under at most 40 subjects: the rarest are folded
   into "General", and each folded fact keeps the subject it had in front of
   its text ("Asha: lives in Delhi"), which is how asking about that subject
   still finds it. Facts
   about health, money, relationships, politics or religion start unticked,
   and so does any fact the model marked sensitive in other words. The model
   is asked for a label on every fact, and the fact's own words are checked
   whatever it answers: reproductive and mental health, medication, trouble
   with the law, immigration status, sexuality, parties and voting, debt,
   bankruptcy and pay. When two facts disagree, the newer one is kept and the
   older one is shown unticked. You can tick or untick a whole group, and give
   any fact another subject, an existing one or a new one. If the facts you
   ticked would not fit (more new notes than there is room for, or a note past
   64 KB), the dialog says which, Save stays off until they do, and **Keep
   what fits and untick the rest** gets you there in one click: the newest
   facts stay ticked, and nothing leaves the list.
5. **Save.** Core facts are added to About me as learned facts, so each has a
   **Remove** button; subject facts are written to shared notes, each entry
   ending in `(imported · ChatGPT)`. A core fact About me has no room for is
   filed under its subject like the others. A save that would not fit is
   refused whole: nothing is cut short, the import stays open, and no
   conversation is recorded as read.

**What is never kept or sent.** Before anything reaches a model or is written
to the import's working files, the value of a secret is cut out of the message
that holds it and replaced by `[removed]`; the rest of the message is read,
and the dialog counts such messages. A secret here is a password, passcode or
PIN (said before or after its name), a door, gate, alarm or safe code, the
answer to a security question, a payment card number (one that passes the card
check anywhere, or any number of that length near the word "card"), a card's
security code, or a common identity or bank account number. A message that
only talks about passwords, keys, codes or a document's expiry date is read as
it is. A proposed fact that holds a secret is dropped whole, not masked.

A proposed fact is also dropped when it is an instruction to an assistant, a
grant of permission to one in any person ("has authorised assistants to…"),
or holds a command, code, a full link (one with a scheme or a path, in any
case) or a bare network address, because an imported note is later put in
front of a bot. A site's bare name ("amazon.com") is a name and stays. A
preference said as a statement about you ("prefers replies without emoji") is
a fact, and the model is asked to write preferences that way. A subject goes
through the same rules: one that holds a secret takes its fact with it, and
one that reads like an order is replaced by "General". A title that holds a
secret or a link is shown as "Untitled". An alias may not be a common word,
and a fact brings at most five.

The screen works on shapes and wording, held to a written sample from both
sides (`server/testing/context-import-ordinary.ts`): at most 2 in 100 ordinary
facts or messages touched, and every secret and instruction in the sample
caught. It is a net, not a guarantee, and the review asks you to look for
passwords and codes before you save.

On save or cancel the uploaded file, the text cut from it and the proposed
facts are deleted; if they cannot be deleted, the dialog says so and names the
folder. An import left unfinished is deleted the same way after 14 days. What
stays is one record per import in `~/.openmausbot/context-imports.json`: the
source, the time, counts, the date range, and a hash of each conversation's id
and update time, which is how a later import skips what was already read. It
holds no text. An import in progress lives in `~/.openmausbot/context-import/`
and is never part of a backup.

**Imported notes** under About me lists the shared notes: open, edit or delete
each one. **Delete everything imported** removes exactly the lines that carry
an import's own mark: every shared-note line ending in `(imported · ChatGPT)`,
`(imported · Claude)` or `(imported · Pasted text)`, and every About me line
that begins `learned by ChatGPT import` (or Claude, or Pasted text) after its
date, whether or not it is still on the list of learned facts. A line you
wrote yourself stays, including one under an imported entry. An imported line
you reworded goes if it still carries the mark; take the mark off to keep it.
The record of what was read goes too, so a later import starts over.

Calls are paced for engines whose limits are not known: one at a time, two
seconds apart, one retry after 15 seconds. A part whose answer cannot be used
after its retry is skipped and counted, and the import goes on. When the
engine itself fails three parts in a row (no answer, an error, a usage limit),
the import pauses itself and keeps what it has read; on resume you can have
those parts read again or skip them. A call may take 120 seconds, and the
engine is told the same limit. After a restart a running import comes back
paused.

**What the engine keeps.** The import deletes its own copies of your chat
text. The engine that reads it is a separate program or service, and each one
reports whether it can read text without keeping a record of its own. Where
it cannot, or does not say, the dialog shows this line under the engine
choice before reading starts, and reads with that engine all the same: "This
engine may keep its own record of the text it is sent. OpenMausBot deletes its
own copies either way."

- **The Claude engine** makes each call as a one-shot `claude -p`. Where the
  installed Claude CLI offers them (its `--help` is read, which calls no
  model), the import's calls add `--no-session-persistence`, so the CLI keeps
  no session file of the chat text, `--tools ""`, so the call has no built-in
  tool, and `--strict-mcp-config`, so it mounts no MCP server from your own
  settings. A CLI too old to list the first option makes the call without it:
  the text then lands in the CLI's own session files under its config folder,
  which the import's clean-up does not reach, and the dialog shows the line.
  It shows it too when the CLI could not be asked.
- **Engines called over an API** (the OpenAI-compatible ones) get one request
  per call from this app itself. No engine program runs, so no session or
  history of the text is written on this computer, and the line is not shown.
- **Engines that run their own agent program** (Gemini, Qwen, Cursor, Grok
  CLI and the others of that family) start a fresh session for each call, in
  an empty folder with no tools. Whether that program keeps its own history
  of the session is not known to this app, so the line is shown.

None of this covers what the provider behind an engine does with the text it
receives. That is the provider's own policy, whichever engine you pick.

Nothing an import does can stop the server. A failure in the background (a
full disk, a folder that cannot be written, a damaged file) fails that import
with a message; a job folder that is damaged or cannot be written when the
server starts is logged and ignored.

The two export formats are not documented by their makers. The parsers read
the shapes people have described and skip, and count, anything else. To see
what a real export holds without using a model:

```sh
node --experimental-strip-types scripts/context-import-scan.ts ~/Downloads/export.zip
```

## Routes

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/bots/:id/memory` | Overview: gauge numbers, topic and log lists, the folder path. |
| `GET` | `/api/bots/:id/memory/file?path=` | One file's text and hash (`MEMORY.md`, `memory/<topic>.md`, `memory/log/<day>.md`). |
| `PUT` | `/api/bots/:id/memory/file` | `{ path, text, expectedHash? }` — `409` with the current text when the hash no longer matches. |
| `DELETE` | `/api/bots/:id/memory/file?path=` | Removes a topic or log; refuses `MEMORY.md`. |
| `GET` | `/api/bots/:id/memory/journal?limit=` | Recent changes, newest first. |
| `POST` | `/api/bots/:id/memory/journal/:entryId/revert` | Puts the file back to that row's earlier text. |
| `POST` | `/api/bots/:id/memory/open` | `{ target: "obsidian" \| "folder" }` — opens the folder on this computer; loopback only. |
| `GET` | `/api/bots/:id/memory/upkeep` | Whether upkeep is on, whether the engine can run the model steps, and the last tidy-up and capture. |
| `POST` | `/api/bots/:id/memory/tidy` | Runs the tidy-up now (`409` when upkeep is switched off) and returns its report. |
| `GET` | `/api/profile/learned` | Facts bots added to About me on their own, newest first. |
| `POST` | `/api/profile/learned/:id/remove` | Takes that line out of About me; the fact is never added again. |
| `GET` | `/api/shared-notes` | Every shared note: title, other words for it, size, entry counts. |
| `GET` `PUT` `DELETE` | `/api/shared-notes/:name` | One note: its text, replace it with `{ text }`, or delete it. |
| `DELETE` | `/api/shared-notes?imported=1` | Deletes everything an import wrote, here and in About me. |
| `GET` | `/api/context-import` | The open import, which bots can read one, and past imports. |
| `POST` | `/api/context-import` | Starts an import: `{ source: "chatgpt" \| "claude" \| "paste" }`. One at a time. |
| `PUT` | `/api/context-import/:id/file` | The export as the request body (a zip or `conversations.json`, up to 4 GB). |
| `POST` | `/api/context-import/:id/text` | Pasted text: `{ text }`. |
| `GET` | `/api/context-import/:id?from=&to=&cap=` | State, scan, progress and, in review, the proposed facts. The query prices another range. |
| `POST` | `/api/context-import/:id/extract` | Starts reading: `{ botId, from?, to?, cap? }`. |
| `POST` | `/api/context-import/:id/pause`, `/resume`, `/cancel` | Job control. Resume takes `{ skipFailed? }`: `true` leaves out the parts the engine failed. Cancel deletes the upload and everything read from it. |
| `PATCH` | `/api/context-import/:id/candidates` | Tick, edit, move and rename: `{ changes?, renameSubject? }`. |
| `POST` | `/api/context-import/:id/save` | Writes the kept facts and deletes the upload. Refuses (`409`) when they would not fit, and then writes nothing. |

All of them need the owner (admin) session, like the other bot-settings routes.
The shared-notes and import routes also refuse an admin who is not the owner
(`403`), and are not offered to a paired phone. In the desktop app they need
the app's own capability for reads as well as changes, so another program on
the computer cannot read them.
