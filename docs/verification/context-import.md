# Context import and shared notes

An import reads a ChatGPT or Claude export, or pasted text, proposes lasting
facts about the person, and saves what they keep: core facts to About me, the
rest to shared notes that any bot recalls in a private chat. See
[the memory guide](../memory.md).

## Exercise the real path

```sh
pnpm exec vitest run server/context-import.e2e.test.ts server/context-import-failures.e2e.test.ts
pnpm exec vitest run server/context-import server/routes/context-import.test.ts server/routes/shared-notes.test.ts
pnpm exec vitest run server/shared-notes.e2e.test.ts server/shared-notes-owner.e2e.test.ts
pnpm exec vitest run server/shared-notes-cards.e2e.test.ts server/shared-notes-adopt.e2e.test.ts server/shared-notes-adopt-lost.e2e.test.ts
pnpm exec vitest run server/shared-notes.test.ts server/shared-notes-owner.test.ts server/shared-notes-threads.test.ts server/shared-notes-threads-order.test.ts server/shared-notes-adopt.test.ts server/recall.test.ts server/request-auth.test.ts
pnpm exec vitest run server/profile-learned.test.ts server/workspace-backup.test.ts
pnpm exec vitest run src/lib/context-import.test.ts src/components/ContextImportDialog.test.ts src/components/ImportedNotes.test.ts
```

The API fixture launches the shared isolated server with the fake engine. The
extraction and conflict calls are answered by `FAKE_CLAUDE_TEXT_ROUTES`, a
JSON file mapping a prompt marker (`IMPORT_MARKER`, `TIDY_MARKER`) to a reply.
`FAKE_CLAUDE_PROMPTS` records every turn the engine received, which is where
recall shows. No real engine is called and no usage is spent.

Evidence covers:

- A synthetic ChatGPT export zip is uploaded, scanned without a model, and read with the fake engine.
- Before save, About me, the learned-facts list and the shared notes are all unchanged.
- Save adds the core fact to About me as a learned fact from "ChatGPT import" and files the subject facts in shared notes; the sensitive fact stays out.
- After save the import folder is gone and `context-imports.json` holds no text.
- A shared note is recalled in the owner's 1:1 chats, by a bot that existed and by one created afterwards, and never in a routine run or a room.
- A device paired with chat-only access cannot read the notes or start an import (`403`), and its own 1:1 chat never recalls them; the owner's device paired with full access does both.
- **Delete everything imported** removes the entries, the About me line and the record.
- The import's own model calls ask the engine to keep no session and mount no tool (`server/context-import.e2e.test.ts` reads the fake engine's arguments), and the list of engines says this one keeps no record of the text (`keepsText: false`).
- Started with a fake CLI that lacks the session option (`FAKE_CLAUDE_ISOLATION=0`), the list says the engine may keep the text (`keepsText: true`), and a pasted import is still read with it, without the option.

`server/routes/context-import.test.ts` covers an upload that is refused, over a real connection written to a piece at a time:

- The import refuses an upload part-way (over the limit): the answer is held back while the sender is still writing, the rest is read and thrown away, the `413` then arrives with `connection: close`, and the connection ends by an ordinary close with no error on the sender's side. Nothing of the upload is on disk at any point, and the import can still take a file.
- Uploads of 65 KB to 24 MB get their reason, not a network error, for each refusal: over the limit (`413`), no such import (`404`), not the owner (`403`), an import that has its file or takes pasted text (`409`); and a cancel during an upload (`409`).
- The bound: an upload that says it has more left than will be thrown away is answered at once and nothing more of it is read; one that does not say is read for about the bound; one that stalls is waited for as long as the bound says. Each is then answered and the connection closed.
- 256 MB thrown away holds no more memory than one piece does (measured after a collection) and writes nothing.

`server/shared-notes-owner.e2e.test.ts` covers whose turn it is:

- A device paired with chat-only access edits its own message, and then the owner's message, and regenerates it: none of those turns is sent a shared note. The owner's own edit, at the computer and from a device paired with full access, still is.
- Someone else writes in a conversation that recalled a note: their turn is sent no note and starts a fresh engine session with the conversation replayed, instead of resuming the session that holds the note; the owner's next message there recalls nothing. The same for a conversation someone else wrote in first or edited a message in. A conversation only the owner wrote in still recalls.
- While the owner's turn that recalled a note is still running (the fake engine holds it open), a chat-only device's message waits in the queue instead of being added to that turn, and then runs as its own turn in a fresh session with no note; the owner's own message is added to the running turn.
- Run as the desktop app runs it (`OMB_TEST_DESKTOP_OWNER_TOKEN`), the shared-notes and import routes answer the app's own capability and refuse a local request without it, reads included, while `/api/health` and `/api/bots` still answer.

`server/shared-notes-cards.e2e.test.ts` covers cards, on a server whose fake ACP engine asks a question or a permission in every turn:

- A device paired with chat-only access answers the question card, and refuses the permission card with words of its own, of the owner's running turn that recalled a note, on both respond routes: each is `403`, the card stays open, and the owner then answers it.
- The same device answers a card in a conversation that recalled nothing: allowed as before, and the owner's next message there is sent no note. Where the owner answered their own card, it is.
- Another bot asks a bot in its main conversation after the owner's message there recalled a note: that ask starts a fresh session with the conversation replayed and no note; the next ask, with no owner message in between, resumes as usual; after the owner's next message recalls again, the ask after it replays again.

`server/shared-notes-adopt.e2e.test.ts` covers conversations from before this version. The fixture is made older the way an upgrade does it: conversations are written, the server stops, both record files (`shared-notes-threads.json` and `shared-notes-proof.json`) are removed as if this version had never run, and the server starts again.

- Before the owner adopts anything, their own question in an older conversation is sent no shared note, while a conversation started now is.
- A device paired with chat-only access calling `POST /api/shared-notes/adopt` gets `403`, and nothing changes.
- The owner's call adopts the conversation only they wrote in and leaves the one a chat-only device also wrote in (`skipped.sender`); the same question is then sent the note in the first and still none in the second.
- Calling it again adopts nothing more and takes nothing back. After a chat-only device writes in the adopted conversation, it recalls nothing, and calling it again does not restore that.

`server/shared-notes-adopt-lost.e2e.test.ts` covers what the owner's click must never take:

- A chat-only device edits the owner's message after proof began: the stored edit carries its sender, and the conversation is left for that reason. Then `shared-notes-threads.json` is deleted and the server restarted: no conversation from before is sent a note, the click adopts none of them (not the edited one, not the one adopted before, not one that was the owner's alone), and it reports how many it could not take because the record was lost (`skipped.lost`). A conversation started after the loss recalls as usual. Deleting `shared-notes-proof.json` instead has the same effect, and what the record still proves keeps its standing.
- A team backup is exported and imported on the same fixture: the imported conversation's lines carry no sender, and the click does not adopt it (`skipped.restored`), on a second click and after a restart either; the owner's own older conversation is adopted, and a new conversation with the imported bot recalls. Then both record files are deleted: proof begins again and the owner's own conversations can be adopted, but the imported one is still left and still sent no note, because its mark is on the conversation itself.
- The whole installation is backed up and restored from that archive (`POST /api/workspace-backup/restore`, then a restart): an older conversation that could have been adopted before the restore is left afterwards (`skipped.restored`), on every later start too; the conversation the archive's record proves still recalls, and so does a new one.

`server/context-import-failures.e2e.test.ts` covers what an import may never do to the server:

- The import folder loses its write permission while an upload is being scanned: the import fails with a message, the server keeps answering, and the import can be cancelled once the folder can be changed.
- The server is started with a job file that is not JSON in a folder nothing can be removed from, and with a readable job in a folder that cannot be written: both times it starts normally and shows no import. A review that a restart interrupted, in a folder that can be written, is still there.

Unit tests add: whose the notes are on every kind of installation (a second
admin, a member, a Slack relay, a hosted installation, a Cloud home) and for
every way a turn starts, the record of which lines the owner's own requests
wrote (that the moment proof began survives the loss of either file, that a
first start cut short between the two files is not read as a loss, that a
write made at once is never replaced by a slower, older one, and that every
copy is synced before it is renamed into place), that adoption gives way
between batches and a conversation read for it is not kept loaded, that a
list with no conversation among its first 10,000 items is refused and read no
further, that a list stops at 2,000,000 items and an upload at 4,000,000
within a time bound and without a long stall, what each engine says about
keeping the text (a hosted provider none, a model server on this computer or
network unknown), a password written in groups cut as one value, both parsers on
synthetic conversations (edited branches,
images, unknown shapes), the list splitter on a 512 MB file within a fixed
amount of memory, zip handling (names that climb out of the folder, the entry
size limit, an unknown compression method, a large entry that is not read
within a fixed amount of memory, a cut-off zip, too many entries), cuts and
batch packing, the import's screen (passwords, card and identity and bank
numbers, instructions, commands and links, common-word aliases, sensitive
labels, and a written sample of ordinary facts and messages of which at most
2 in 100 may be touched), retry then skip, a part that never parses being skipped, the job
pausing itself after three engine failures and skipping them on request,
stopping at 2,000 facts, pause and resume, coming back paused after a restart,
cancel waiting for the upload's file, expiry after 14 days, the 30-fact Core
limit, About me overflow going to the fact's subject, a save that does not fit
being refused whole, exact deletion of imported lines, and the backup leaving
an import in progress out.

## A look at a real export

```sh
node --experimental-strip-types scripts/context-import-scan.ts ~/Downloads/export.zip
```

Prints what the archive holds, how many conversations each parser understood,
the date range, the cost of the default read and the shapes no parser knew.
It calls no model and prints counts, dates, entry names and key names only.

## Stated limits

What the feature does not cover, as the memory guide lists it for the person
([What this does not cover](../memory.md#what-this-does-not-cover)). None of
these is a test gap; each is how it works.

- Messages from any paired device before senders were recorded (#1514, 18
  September 2026) and cards answered before answerers were recorded (#1717,
  23 September 2026) carry no trace of who wrote or answered them. They are
  adopted by the owner's click.
- A routine run older than the 2,000 runs the history keeps, later carried on
  by hand, is adopted. So is a webhook's conversation, or a routine that ran
  inside the bot's own conversation, once its run has left that history: a
  routine's own conversation is marked until someone writes in it, the other
  two are named by the run history only.
- A bot that runs commands as the app's user can read the shared-notes
  folder. On a headless server where a local request is the owner's, it can
  also call the owner's routes, adoption included, and change or delete the
  record files.
- A crash within a moment of a message loses that line's proof: the record is
  written about a quarter of a second after the message. That conversation
  then never recalls a shared note.
- Both record files deleted or damaged cannot be told from a first start:
  proof begins again, every existing conversation can be adopted, and an
  earlier loss of the record is forgotten. Still known then: which
  conversations a team backup brought in (the mark is on the conversation's
  own record in the store) and everything from before a restore of the whole
  installation (by the restore's receipt). One of the two files missing or
  unreadable is a loss and adopts nothing from before it.
- A conversation where the owner wrote from a device since removed, or
  answered a card from a signed-in device, is never adopted. Neither is one
  from a team backup, one from before a restore of the whole installation or
  a move between computers, or one from before the record was lost.
- A restore keeps what the archive's own record proves. An archive is taken
  as a whole: its conversations, its notes and its record arrive together.
- A chat-only device that approves or answers a card ends that conversation's
  standing (and is refused where the session already holds a recalled note).
- Another bot's ask after an owner turn that recalled a note starts a fresh
  session and replays the conversation.
- A note is found only by a word of its subject (file name or title) or an
  alias, never by its content alone.
- An engine may keep its own record of the text an import sends it, and the
  import cannot delete that. The dialog says so where the engine cannot be
  told otherwise or does not say, and for any OpenAI-compatible engine whose
  address is this computer, a private network address or a local name. Where
  it says nothing, that means only that this app's call to a hosted provider
  writes nothing on this computer; what a provider does with a request is not
  known to the app for any engine. The address is judged as written, with no
  lookup.
- The secret screen recognises a set of common wordings. A plain word given
  as a password ("my wifi password is sunflower") passes, as do wordings
  nobody wrote down.
- One list of an upload is read for at most 2,000,000 items and one upload
  for 4,000,000 in all; the rest is reported as read in part or not read.
- The screens for secrets, sensitive subjects and instruction-shaped facts are
  a guard in front of the person's own review, which is the real check. An
  independent review measured them at `ce7128f67` on samples of its own;
  the figures are approximate and the samples small:
  - sensitive facts left unlabelled by the model and still ticked: 13 of 32;
  - secret wordings kept as proposed facts: 12 of 32; the same wordings sent
    to the engine uncut: 12 of 32;
  - instruction-shaped facts kept: 8 of 12, the weakest of the screens;
  - ordinary facts wrongly dropped: 2 of 121; ordinary messages left out: 0
    of 50; messages with a value cut: 2 of 50; aliases refused: 4 of 40.

  One rule changed after that measurement (a password written in groups is
  cut whole), which was not measured again. The project's own written sample
  in `server/testing/context-import-ordinary.ts` passes, and says little
  about wordings nobody wrote down.

## Not proven here

- **The export formats.** The fixtures are synthetic and follow the shapes the
  parsers assume. Neither format has been checked against a real export.
- **What a real model extracts.** The fake engine answers with scripted JSON.
- **Engine limits.** The pacing (one call at a time, two seconds apart) was
  chosen without measuring any subscription engine's rate limit.
- **Shared installations beyond paired devices.** The end-to-end tests pair a
  chat-only device and a full-access device. Email sign-in with members or a
  second admin, a hosted installation and a Cloud home are covered by unit
  tests of the rule only, not by a running server.
- **The screen against real text.** The rules for secrets, instructions and
  sensitive facts are tested on written examples. What they catch and miss in
  a real export is not known.
- **The Claude CLI's options against a real call.** The driver test and the
  fixture read the fake engine's arguments. No real `claude -p` call was made
  with `--no-session-persistence` and `--tools ""`, and nothing was run on
  Windows.
- **What a real engine keeps.** Whether an engine keeps its own record of the
  text is taken from the Claude CLI's option list and from how each driver
  makes the call. No real engine's files were inspected after a call.
- **A power cut.** The record's writes are checked for their order (written,
  synced, renamed) and for what lands when the disk is slow. No machine was
  switched off.
- **Restores from another installation.** The restore test puts an
  installation back from its own archive. A move between two computers and
  the desktop app's company backups use the same restore and were not run.
- **The reset itself.** On this Mac an upload refused part-way lost its
  answer for some sizes (`write EPIPE` for 5 MB) and kept it for others (65
  KB); the tests above fail on the code from before the fix here. That the
  65 KB case, which failed with `read ECONNRESET` on the Windows runner
  only, now passes there can only be seen on that runner.
- **Time on other machines.** Bounds on time in these tests are multiples of
  a reference the same test measures (`server/testing/relative-time.ts`).
  They were run on one Mac, idle and with every core busy. Set
  `TEST_TIME_LOG` to a file to read the margins on another machine.
- **The dialog.** `control-omb` does not drive Settings. The dialog's steps
  are rendered in unit tests; drive it by hand against a fixture to see it
  work (set `OMB_PORT` to the fixture's port before `pnpm dev`, so the UI
  never talks to your own installation).
