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
shares with the note's name, title or aliases.

- **Only in a private chat you started.** A shared note is recalled in a 1:1
  chat with you. It is never recalled in a room, a routine run, or a turn
  started by another bot, a webhook or a teammate hand-off.
- **Yours alone.** Shared notes belong to the installation's owner, like
  About me. If other people use the same installation, their chats never
  recall your notes and they cannot open them: not a device paired with
  chat-only access, not a member who signs in by email, not a message relayed
  from Slack, and on My Cloud not a conversation a guest opened or wrote in.
  The owner is whoever uses the computer OpenMausBot runs on, and any device
  paired with full access, as long as at most one address may sign in as
  admin. With a second admin, only the computer itself counts; on a hosted
  installation, which has no single owner, shared notes are not used at all.
- **After the bot's own notes.** Shared passages come after the bot's own,
  inside the same limit of four notes and 6,000 characters, labelled
  `shared/<file>`. A bot's own note on a subject wins over a shared one.
- **No tool.** Bots cannot read, write or tidy this folder. Recall is their
  only way in, so a shared note changes only when you change it.
- **Limits.** At most 200 notes of 64 KB each. Files are owner-only (`0600`),
  written atomically, and pass the same credential scrub as bot memory.
- **Backups.** The folder is part of a full backup, like any other data.

### Import from ChatGPT or Claude

**Settings → Profile → Import from ChatGPT or Claude** reads a data export
from either assistant, or text you paste, and proposes lasting facts about
you. Nothing is saved before you have reviewed it, and the chats themselves
are never kept. Only the installation's owner sees the button, because what
it saves goes to the owner's About me and shared notes.

1. **Choose a source.** The export zip (or the `conversations.json` inside
   it), or pasted text of up to 100,000 characters. Paste is there because a
   ChatGPT export may not hold its saved memories.
2. **Scan.** No model is used. The export is read as a stream on the computer
   running OpenMausBot, one conversation at a time, and the dialog shows how
   many conversations it holds, the date range, and what reading them will
   cost. The default is the last 12 months, newest first, at most 500
   conversations; you can change the dates and the number (up to 2,000).
3. **Read.** You pick which bot's engine reads it. Only your own messages are
   sent, with each conversation's title and date: each message cut at 1,500
   characters, code blocks dropped, 6,000 characters a conversation, about
   24,000 characters a call. You can pause, resume and cancel, and close the
   window while it runs.
4. **Review.** Facts are listed in two groups. **Core** (at most 30) goes to
   About me, which every bot reads on every message. The rest is filed by
   subject in shared notes. Facts about health, money, relationships, politics
   or religion start unticked. When two facts disagree, the newer one is kept
   and the older one is shown unticked.
5. **Save.** Core facts are added to About me as learned facts, so each has a
   **Remove** button; subject facts are written to shared notes, each entry
   ending in `(imported · ChatGPT)`. If About me is full, the core facts that
   did not fit go to a shared note called "About me, continued".

On save or cancel the uploaded file, the text cut from it and the proposed
facts are deleted. What stays is one record per import in
`~/.openmausbot/context-imports.json`: the source, the time, counts, the date
range, and a hash of each conversation's id and update time, which is how a
later import skips what was already read. It holds no text. An import in
progress lives in `~/.openmausbot/context-import/` and is never part of a
backup.

**Imported notes** under About me lists the shared notes: open, edit or delete
each one. **Delete everything imported** removes every imported entry from the
shared notes, every imported line from About me, and the record of what was
read, so a later import starts over.

Calls are paced for engines whose limits are not known: one at a time, two
seconds apart, one retry after 15 seconds, and after three parts in a row fail
the import pauses itself and keeps what it has read. After a restart a running
import comes back paused.

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
| `POST` | `/api/context-import/:id/pause`, `/resume`, `/cancel` | Job control. Cancel deletes the upload and everything read from it. |
| `PATCH` | `/api/context-import/:id/candidates` | Tick, edit, move and rename: `{ changes?, renameSubject? }`. |
| `POST` | `/api/context-import/:id/save` | Writes the kept facts and deletes the upload. |

All of them need the owner (admin) session, like the other bot-settings routes.
The shared-notes and import routes also refuse an admin who is not the owner
(`403`), and are not offered to a paired phone.
