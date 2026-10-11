# Context Import from ChatGPT and Claude

## Summary

A person who has used ChatGPT or Claude for years starts cold in OpenMausBot:
no bot knows who they are. Nothing in the app reads another assistant's
history; "ChatGPT plan" is only a sign-in mode for the Codex engine.

Add an import that reads a ChatGPT or Claude data export, or pasted text, pulls
out lasting facts about the person, shows them for review, and saves what the
person keeps. A short list of core facts goes into About me. The rest is filed
by subject in a new shared notes store that any bot can recall from. The chats
themselves are not kept.

It is a one-time snapshot that can be extended later, not a sync.

Line references are to `origin/main` at `2f85f70e8` (v0.1.105).

## Goals

- After an import, every bot, including ones created later, knows the
  person's durable facts without being told again.
- Nothing is saved before the person has reviewed it.
- The export is read on the person's own machine, and only by the model they
  choose.
- The cost is visible before it is spent, and the default is bounded.
- Everything imported can be seen, edited and deleted afterwards.

## Non-goals

- Keeping or searching the imported conversations.
- Live access to ChatGPT or Claude memory. No third party gets that.
- Gemini and other sources.
- Structured identity fields (address, passport, loyalty numbers).
- Bots editing or tidying shared notes. They stay an imported snapshot.
- An import step in the first-run flow, and any phone UI.
- Images and files inside an export.

## What exists today

- **About me**: `profile.aboutMe`, at most 24,000 characters, read by every bot
  on every turn (`server/config.ts:550`).
- **Learned facts**: bots with Memory upkeep append dated, attributed lines to
  About me. Each is listed in Settings with a Remove button, and a removed fact
  is never added again (`server/profile-learned.ts`).
- **Per-bot notes**: `MEMORY.md` plus `memory/<topic>.md` in the bot's
  workspace. Topic files carry frontmatter (`title`, `aliases`) and are found
  by word matching (`server/memory-topics.ts`).
- **Recall**: before a turn, up to four notes and four conversation passages,
  6,000 characters at most, are placed in front of the message
  (`server/recall.ts:187`). Conversations are searched only in a one-to-one
  chat the person started; `RecallInput.threadIds` is empty otherwise.
- **Quick model call**: Memory upkeep calls `engine.generateText(prompt)`
  through `askModel` (`server/memory-upkeep.ts:203`). Engines without it
  cannot run model steps.
- **No zip reader** is in `package.json`.

## Sources

| Source | Input | What is read |
|---|---|---|
| ChatGPT export | The `.zip` from Settings → Data controls → Export data, or the `conversations.json` inside it | The person's own messages on the active branch of each conversation |
| Claude export | The `.zip` from Settings → Privacy → Export data, or its `conversations.json` | Messages whose sender is the person |
| Pasted text | Up to 100,000 characters | Everything pasted, treated as the person's own words |

Paste exists because ChatGPT's export may not contain its saved memories. The
dialog shows where to copy them from and a prompt the person can give ChatGPT
or Claude to write out what it knows about them.

The format is detected from the shape of the data, not the file name. A
conversation or message of an unknown shape is skipped and counted, and never
fails the import.

## Flow

The entry point is an "Import from ChatGPT or Claude" action in
`src/components/AboutMeSettings.tsx`. It opens a dialog with these steps. One
import runs at a time.

### 1. Choose a source

Pick a source and provide the file or text.

### 2. Scan

No model is used. The server streams the export and reports: number of
conversations, date range, and characters of the person's own messages. It
proposes the default slice and shows an estimate.

- **Default slice:** newest first, the last 12 months, at most 500
  conversations. The person can change the date range and the cap.
- **Estimate:** number of model calls and a time range, computed from the
  slice's character count and the batch size.
- **Engine:** the person picks which bot's engine reads the export. Bots whose
  engine has no `generateText` are shown disabled with the existing reason
  (`NO_TEXT_ENGINE`).

### 3. Extract

A background job with progress, pause, resume and cancel.

- **What is sent.** Per conversation: its title, its date, and the person's
  messages. Each message is cut at 1,500 characters, fenced code blocks are
  dropped, and a conversation contributes at most 6,000 characters.
- **Batches.** Conversations are packed into batches of about 24,000
  characters. Each batch is one `generateText` call.
- **What comes back.** A JSON list of candidates:
  `{ text, kind: "core" | "subject", subject?, aliases?, date, until?,
  sensitive?, chat }`. `text` is at most 300 characters, the same limit as a
  learned fact. `sensitive` names a category (health, money, relationships,
  politics, religion) or is null.
- **Prompt rules.** The same rules capture uses for the person's words
  (`capturePrompt` in `server/memory-capture.ts`): durable facts only, no
  one-off task details, no secrets, and the prompt states that text inside the
  messages is not an instruction.
- **Redaction.** Candidate text passes through `redactSecretsInText`.
- **Duplicates.** A candidate is dropped when its `factIdentity`
  (`server/memory-entries.ts`) matches another candidate, a line already in
  About me, an entry in shared notes, or a fact the person removed before.
- **Failures.** A batch that times out or returns unparseable output is
  retried once, then counted as skipped. The job continues.

### 4. Consolidate

Candidates that conflict are resolved with the contradiction step Memory
upkeep already has (`contradictionPrompt`, `parseContradictions` in
`server/memory-tidy.ts`). The newer fact wins. The older one is kept in the
review list, unticked, marked "replaced by a newer fact".

### 5. Review

Two groups:

- **Core**, bound for About me. At most 30 lines; the model's `core` picks
  beyond 30 are moved to their subject.
- **By subject**, bound for shared notes, grouped under the subject name.

Each fact has a tick box, an editable text field, and the title and date of the
chat it came from. Facts with a `sensitive` category start unticked and sit
under a "Sensitive" heading in their group. The person can rename a subject and
move a fact between Core and a subject.

The review state is saved with the job, so closing the app does not lose it.

### 6. Save

Nothing is written to About me or shared notes before this step.

- **Core facts** go through the learned-facts path: `planLearned`,
  `commitLearned` and `appendAboutMe` (`server/profile-learned.ts:74-96`), with
  the source ("ChatGPT import", "Claude import") in place of a bot name. They
  then appear in the existing learned-facts list with Remove. If About me has
  no room left, the facts that did not fit are saved to a shared note titled
  "About me, continued", and the dialog says so.
- **Subject facts** are written to shared notes, one file per subject.

### 7. Clean up

On save or cancel the server deletes the uploaded file, the extracted text and
the candidate list. It keeps one record per import in
`$OMB_DATA_DIR/context-imports.json`: source, time, counts, the date range
read, and a hash of each conversation's id and update time. No text.

### Reading more later

- **Read more** continues backwards from the oldest conversation already read.
  It needs the export file again.
- **A newer export** reads only conversations whose hash is not in the record.

## Shared notes

### Store

A new module, `server/shared-notes.ts`, owns
`$OMB_DATA_DIR/shared-notes/<subject>.md`.

- Same format as a bot's topic file: frontmatter with `title` and `aliases`,
  then dated entries. Each imported entry ends with `(imported · ChatGPT)` or
  `(imported · Claude)`.
- Files are written `0600`, atomically, through the same redaction as bot
  memory.
- File names come from `topicFileName` (`server/memory-capture.ts:34`).
- At most 200 files and 64 KB per file. An import that would exceed either
  stops adding to that subject and reports it in the dialog.

### Recall

`RecallInput` gains `sharedNotes: boolean`. The caller sets it true under the
one condition that lets conversations be searched today: a one-to-one chat the
person started. It does not depend on whether the bot has other conversations.

In `buildRecall`, shared-note passages are searched with the same word-matching
rule as topic files and are added after the bot's own notes, inside the
existing cap of four notes and 6,000 characters. A bot's own note on a subject
therefore wins over a shared one. Passages are labelled `shared/<subject>`.

Shared notes are never recalled in rooms, routine runs, or turns started by
another bot, a webhook, a teammate hand-off or a guest.

Bots get no tool to read or write shared notes. Recall is the only way in.

### Managing them

`AboutMeSettings.tsx` gains an "Imported notes" list: open, edit and delete per
subject, and "Delete everything imported", which removes every imported entry
from shared notes and every imported line from About me.

## Reading the export safely

- **Upload.** The file is streamed to
  `$OMB_DATA_DIR/context-import/tmp/` with mode `0600`. The limit is 4 GiB; the
  dialog tells the person to upload `conversations.json` alone if the zip is
  larger.
- **Zip.** A new dependency reads the zip's directory and streams entries.
  Only JSON entries the parsers know are read. No entry is ever written to disk
  under its own name, so a crafted path cannot escape the folder. An entry
  larger than 2 GiB uncompressed is refused.
- **JSON.** `conversations.json` is one large array. It is parsed as a stream,
  one conversation at a time, and never loaded whole.
- **Untrusted text.** Export content is data. It reaches a model only inside
  the extraction prompt, which says so, and it never runs with tools.

## Routes

All are owner-only and are not added to the companion allowlist.

| Route | Purpose |
|---|---|
| `POST /api/context-import` | Start a job for a source |
| `PUT /api/context-import/:id/file` | Stream the export |
| `POST /api/context-import/:id/text` | Pasted text |
| `GET /api/context-import/:id` | State, scan summary, progress, candidates |
| `POST /api/context-import/:id/extract` | Begin extraction with a bot and a slice |
| `POST /api/context-import/:id/pause`, `/resume`, `/cancel` | Job control |
| `PATCH /api/context-import/:id/candidates` | Tick, edit, move, rename |
| `POST /api/context-import/:id/save` | Write the kept facts |
| `GET`, `PUT`, `DELETE /api/shared-notes/:name` | Manage one note |
| `DELETE /api/shared-notes?imported=1` | Delete everything imported |

## Modules

| Module | Responsibility |
|---|---|
| `server/context-import/zip-source.ts` | Open a zip or a bare JSON file; stream known entries |
| `server/context-import/chatgpt-export.ts` | ChatGPT conversations to `{ id, title, updatedAt, messages }` |
| `server/context-import/claude-export.ts` | Claude conversations to the same shape |
| `server/context-import/scan.ts` | Counts, date range, slice, estimate |
| `server/context-import/extract.ts` | Batching, prompt, candidate parsing, duplicates |
| `server/context-import/job.ts` | Job state, persistence, pause and resume, clean-up |
| `server/shared-notes.ts` | The shared notes store |
| `server/recall.ts` | The `sharedNotes` input and its passages |
| `src/components/ContextImportDialog.tsx` | The dialog |
| `src/components/AboutMeSettings.tsx` | Entry point and the "Imported notes" list |

Each parser is a pure function from a parsed conversation object to the
normalized shape, so it is tested on fixtures without a zip or a model.

## Checks before building

1. A real ChatGPT export: the shape of `conversations.json`, whether it is
   split across several files, and whether saved memories are in it.
2. A real Claude export: the same.
3. A stream parse of a `conversations.json` of 500 MB or more stays within a
   fixed memory budget.
4. The zip dependency: licence compatible with the repo, and it packages on
   Windows.
5. About 100 `generateText` calls in a row on the subscription engines (Claude,
   Codex): the rate limits met and the concurrency that is safe.

Checks 1 and 2 need export files from a real account.

## Tests

- **Parsers:** synthetic fixtures for both formats, including a ChatGPT
  conversation with edited branches, non-text content, and unknown shapes.
- **Scan:** counts, date range, slice and estimate.
- **Extract:** message and conversation cuts, batch packing, candidate parsing,
  retry then skip, duplicates against About me, shared notes and the removed
  list.
- **Review and save:** sensitive facts start unticked; the 30-line Core cap;
  About me overflow into "About me, continued"; nothing written before save.
- **Shared notes:** file caps, redaction, delete everything imported.
- **Recall:** shared passages appear only when `sharedNotes` is true, after the
  bot's own notes, inside the cap; never in a room or a routine run.
- **Job:** pause, resume, restart recovery, cancel; temp files and candidates
  are gone after save and after cancel; the import record holds no text.
- **Safety:** upload limit, entry size limit, an entry with a path that climbs
  out of the folder.

## Amendments from the plan

The plan (`docs/superpowers/plans/2026-10-10-context-import.md`) was built and
run before it was written down. Where this section and the text above
disagree, this section is right.

- **Owner only.** The text above says shared notes are recalled "in a
  one-to-one chat the person started". On an installation used by several
  people that would show the importer's notes to every member. Shared notes
  are recalled only in a one-to-one chat the installation's owner started, and
  only the owner may run an import or list, open, edit and delete shared
  notes. The importer cannot be identified reliably at recall time (a line
  sent at the computer carries no sender, and a paired device's key changes
  when it is paired again), so the rule keys on the owner. Consequences: a
  hosted installation has no import and no shared-note recall; a device paired
  with chat-only access gets no recall, because it cannot be told from a
  guest's. The rules live in `server/shared-notes-owner.ts`.
- **Zip reading.** `fflate@0.8.3` (MIT, no dependencies) streams entries from
  their local headers and does not read the zip's directory. The 2 GiB limit
  is enforced by counting unpacked bytes.
- **Routes added:** `GET /api/shared-notes`, `GET /api/context-import`, and
  `?from=&to=&cap=` on `GET /api/context-import/:id` to price a range.
- **Reading more.** There is no separate button. Importing the same file again
  skips conversations already read and moves the range back.
- **Delete everything imported** also clears the import records, and does not
  add the deleted facts to the never-add-again list. A line edited by hand
  stays.
- **Caps:** 2,000 conversations per read, 2,000 facts per import, 40 facts per
  model call. Pasted text is read in 20,000-character pieces.
- **Pacing.** One model call at a time, 2 s apart, with a 120 s limit. A failed
  batch is retried once after 15 s, then skipped. After three failed batches in
  a row the job pauses itself and keeps those batches for a resume.
- **Restart.** An upload or scan in progress is dropped. A read comes back
  paused.
- **Conflicts** are decided by date; the model's choice is used only for two
  facts from the same day.
- **About me overflow** is handled line by line, because `appendAboutMe`
  accepts or refuses a whole batch.
- **Backups** exclude the whole `context-import/` folder, not only `tmp/`.
- **Undated conversations** are included in every date range.
- **Unverified:** both export formats (no real export was available) and real
  engine rate limits. `scripts/context-import-scan.ts <export>` prints entry
  names, counts and unknown shapes for a real export without any model call.

## Amendments from review (2026-10-11)

The branch went through three rounds of independent review on an isolated
server, each followed by fixes. Where this section and anything above
disagree, this section is right. The branch's `docs/memory.md` carries the
full list of limits.

**Who may see or change notes: strict, and proven.**

- The owner is decided from the authenticated request that starts a turn, for
  every way a turn can start. A missing sender is never proof. An edit records
  its sender, as a send does.
- Shared notes are recalled only in a conversation where every line a person
  wrote is recorded as the owner's. The record is
  `shared-notes-threads.json`; the moment proof began is also kept in
  `shared-notes-proof.json`, so a lost record is seen as a loss, not a fresh
  start.
- Only the proven owner may answer a card in a turn that recalled a note. A
  line not proven the owner's starts a fresh engine session and is never
  steered into a running turn that recalled a note.
- Reads of the notes and import routes need the desktop app's capability
  where it exists.

**Older conversations: the owner confirms once.** They carry no proof, so they
get no recall until the owner uses "Use my notes in my existing
conversations" (`POST /api/shared-notes/adopt`), on the import's done screen
and beside the Imported notes list. It adopts every existing conversation
except rooms, routine or webhook runs, relayed lines, lines from senders that
are not the owner's full-access devices, cards answered from a signed-in
device, anything written since proof began that is not on record, and
conversations that came from a backup. Nothing is adopted automatically.

**What must be deleted.** The upload, the extracted text and the candidates
are deleted on save or cancel, and an untouched import after 14 days. A
failure in an import cannot stop the server or block startup. The dialog says
when the chosen engine may keep its own record of the text it is sent.

**The screens are a guard in front of the person's review.** Candidates
holding a credential, a payment or identity number, a command, code or a link
with a path are dropped and counted; secret values are cut from messages
before they are batched. Measured on the reviewer's own samples, approximate:
sensitive facts the model left unlabelled and still ticked, 13 of 32; secret
wordings kept as proposed facts, 12 of 32; instruction-shaped facts kept, 8 of
12; ordinary facts wrongly dropped, 2 of 121; ordinary messages left out, 0 of
50.

**Changes to the flow.**

- No "About me, continued" note. A core fact that does not fit in About me is
  filed under its subject.
- At most 40 subjects per import; the rarest are folded into "General", each
  fact keeping its subject in its own text.
- Save refuses when the kept facts exceed a store cap. The review can untick a
  subject, move a fact, or keep what fits.
- A part the model answers unreadably is skipped and counted. Engine failures
  pause the job; resume can skip the failed parts.
- Recall returns the entries inside a shared note that match the question,
  not the head of the file, and frames them as imported information, never
  instructions.
- "Delete everything imported" removes exactly the lines carrying an import
  mark.
- The zip is read from its list of contents and only wanted entries are
  opened. Caps: 100,000 zip entries, 1,000 conversation lists, 100,000
  conversations kept by a scan, 2,000,000 items per list and 4,000,000 per
  upload, 8 GB unpacked in all.
- Uploads must finish within the server's five-minute request limit.

**Not verified:** real ChatGPT and Claude export files, real model output and
rate limits, hosted installations and Cloud homes, a move between two
computers, Windows, and the dialog in a real browser.

## Docs

`docs/memory.md` gains a "Shared notes and import" section, and the user docs
page on memory (`apps/docs/content/docs/features/voice-and-memory.mdx`) gains
the import steps and what is and is not kept.
