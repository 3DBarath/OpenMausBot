# Context import and shared notes

An import reads a ChatGPT or Claude export, or pasted text, proposes lasting
facts about the person, and saves what they keep: core facts to About me, the
rest to shared notes that any bot recalls in a private chat. See
[the memory guide](../memory.md).

## Exercise the real path

```sh
pnpm exec vitest run server/context-import.e2e.test.ts
pnpm exec vitest run server/context-import server/routes/context-import.test.ts server/routes/shared-notes.test.ts
pnpm exec vitest run server/shared-notes.e2e.test.ts server/shared-notes.test.ts server/shared-notes-owner.test.ts server/recall.test.ts
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

Unit tests add: whose the notes are on every kind of installation (a second
admin, a member, a Slack relay, a hosted installation, a Cloud home), both
parsers on synthetic conversations (edited branches,
images, unknown shapes), the list splitter on a 512 MB file within a fixed
amount of memory, zip handling (names that climb out of the folder, the entry
size limit, an unknown compression method), cuts and batch packing, retry then
skip, the job pausing itself after three failed parts, pause and resume,
coming back paused after a restart, cancel, the 30-fact Core limit, About me
overflow, and the backup leaving an import in progress out.

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
- **Shared installations beyond paired devices.** The end-to-end test pairs a
  chat-only device and a full-access device. Email sign-in with members or a
  second admin, a hosted installation and a Cloud home are covered by unit
  tests of the rule only, not by a running server.
- **The dialog.** `control-omb` does not drive Settings. The dialog's steps
  are rendered in unit tests; drive it by hand against a fixture to see it
  work (set `OMB_PORT` to the fixture's port before `pnpm dev`, so the UI
  never talks to your own installation).
