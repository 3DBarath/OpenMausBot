// "Use my notes in my existing conversations": the button, the one sentence
// that says what pressing it claims, and the counts it shows afterwards.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import type { AdoptionResult } from "../../shared/shared-notes";
import { AdoptConversationsPanel } from "./AdoptConversations";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (props: Partial<Parameters<typeof AdoptConversationsPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(AdoptConversationsPanel, { busy: false, result: null, error: false, onAdopt: () => undefined, ...props }));

describe("adopting older conversations", () => {
  it("says what pressing the button claims, before it is pressed", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*>Use my notes in my existing conversations<\/button>/);
    expect(text(html)).toContain("This tells OpenMausBot that you wrote the messages in your existing conversations. Use it only if nobody else has written in them.");
    expect(render({ busy: true })).toMatch(/<button[^>]*disabled=""/);
  });

  it("shows what was adopted and what was left, with each reason that applies", () => {
    const result: AdoptionResult = { adopted: 14, already: 3, empty: 2, skipped: { room: 2, routine: 1, relayed: 0, sender: 4, card: 1, later: 0, restored: 0, lost: 0 } };
    const words = text(render({ result }));
    expect(words).toContain("Conversations that now use your notes: 14. Already using them: 3.");
    expect(words).toContain("Left as they are: 8.");
    expect(words).toContain("Rooms and group conversations: 2.");
    expect(words).toContain("Started by a routine or a webhook: 1.");
    expect(words).toContain("Holding a message from a device that is not one of yours with full access: 4.");
    expect(words).toContain("Holding a card that was answered from another device: 1.");
    // a reason that did not apply is not listed
    expect(words).not.toContain("relayed");
    expect(words).not.toContain("written since");
    // it can be run again
    expect(render({ result })).toMatch(/<button[^>]*>Use my notes in my existing conversations<\/button>/);
    // nothing left: no list of reasons
    expect(text(render({ result: { ...result, skipped: { room: 0, routine: 0, relayed: 0, sender: 0, card: 0, later: 0, restored: 0, lost: 0 } } }))).not.toContain("Left as they are");
    expect(text(render({ error: true }))).toContain("That did not work. Try again.");
  });

  it("says when conversations came from a backup, and when the record of whose messages are whose was lost", () => {
    const result: AdoptionResult = { adopted: 0, already: 2, empty: 0, skipped: { room: 0, routine: 0, relayed: 0, sender: 0, card: 0, later: 0, restored: 6, lost: 9 } };
    const words = text(render({ result }));
    expect(words).toContain("Left as they are: 15.");
    expect(words).toContain("Brought in from a backup, so nothing here recorded who wrote them: 6.");
    // the person is told the record was lost, and how many conversations that cost
    expect(words).toContain("OpenMausBot lost its record of which messages are yours, so it cannot do this for conversations from before then: 9.");
    // neither is mentioned when it did not happen
    const usual = text(render({ result: { ...result, skipped: { ...result.skipped, restored: 0, lost: 0, room: 1 } } }));
    expect(usual).not.toContain("backup");
    expect(usual).not.toContain("lost its record");
  });
});
