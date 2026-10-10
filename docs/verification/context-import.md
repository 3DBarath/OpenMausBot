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
pnpm exec vitest run server/shared-notes.test.ts server/shared-notes-owner.test.ts server/shared-notes-threads.test.ts server/recall.test.ts server/request-auth.test.ts
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
- The import's own model calls ask the engine to keep no session and mount no tool (`server/context-import.e2e.test.ts` reads the fake engine's arguments).

`server/shared-notes-owner.e2e.test.ts` covers whose turn it is:

- A device paired with chat-only access edits its own message, and then the owner's message, and regenerates it: none of those turns is sent a shared note. The owner's own edit, at the computer and from a device paired with full access, still is.
- Someone else writes in a conversation that recalled a note: their turn is sent no note and starts a fresh engine session with the conversation replayed, instead of resuming the session that holds the note; the owner's next message there recalls nothing. The same for a conversation someone else wrote in first or edited a message in. A conversation only the owner wrote in still recalls.
- While the owner's turn that recalled a note is still running (the fake engine holds it open), a chat-only device's message waits in the queue instead of being added to that turn, and then runs as its own turn in a fresh session with no note; the owner's own message is added to the running turn.
- Run as the desktop app runs it (`OMB_TEST_DESKTOP_OWNER_TOKEN`), the shared-notes and import routes answer the app's own capability and refuse a local request without it, reads included, while `/api/health` and `/api/bots` still answer.

`server/context-import-failures.e2e.test.ts` covers what an import may never do to the server:

- The import folder loses its write permission while an upload is being scanned: the import fails with a message, the server keeps answering, and the import can be cancelled once the folder can be changed.
- The server is started with a job file that is not JSON in a folder nothing can be removed from, and with a readable job in a folder that cannot be written: both times it starts normally and shows no import. A review that a restart interrupted, in a folder that can be written, is still there.

Unit tests add: whose the notes are on every kind of installation (a second
admin, a member, a Slack relay, a hosted installation, a Cloud home) and for
every way a turn starts, the record of which lines the owner's own requests
wrote, both parsers on synthetic conversations (edited branches,
images, unknown shapes), the list splitter on a 512 MB file within a fixed
amount of memory, zip handling (names that climb out of the folder, the entry
size limit, an unknown compression method, a large entry that is not read
within a fixed amount of memory, a cut-off zip, too many entries), cuts and
batch packing, the import's screen (passwords, card and identity and bank
numbers, instructions, commands and links, common-word aliases, sensitive
labels), retry then skip, a part that never parses being skipped, the job
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
- **The dialog.** `control-omb` does not drive Settings. The dialog's steps
  are rendered in unit tests; drive it by hand against a fixture to see it
  work (set `OMB_PORT` to the fixture's port before `pnpm dev`, so the UI
  never talks to your own installation).
