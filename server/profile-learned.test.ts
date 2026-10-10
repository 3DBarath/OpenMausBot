// What an import needs from the learned-facts file: the identities a new
// fact is checked against, and removing every imported line in one go.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { appendAboutMe, commitLearned, knownFactIdentities, listLearnedFacts, planLearned, removeLearned, removeLearnedWhere } from "./profile-learned.ts";

const TODAY = "2026-10-10";
const chatgpt = { botId: "import:chatgpt", botName: "ChatGPT import" };

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("known fact identities", () => {
  it("holds About me's lines, attributed or hand-written, and what the person removed", () => {
    const facts = planLearned({ botId: "b1", botName: "Scout" }, ["The person is vegetarian", "Lives in Pune"], "", TODAY);
    const aboutMe = appendAboutMe("I write short emails.", facts.map((fact) => fact.line))!;
    commitLearned(facts);
    const afterRemove = removeLearned(facts[1]!.id, aboutMe)!.aboutMe;
    expect(knownFactIdentities(afterRemove)).toEqual(new Set(["I write short emails", "The person is vegetarian", "Lives in Pune"]));
    // a removed fact is never planned again, by a bot or by an import
    expect(planLearned(chatgpt, ["Lives in Pune.", "Works at Acme"], afterRemove, TODAY).map((fact) => fact.text)).toEqual(["Works at Acme"]);
  });
});

describe("removing every imported line", () => {
  it("takes the import's lines out of About me, keeps the others, and lets a later import add them again", () => {
    const bot = planLearned({ botId: "b1", botName: "Scout" }, ["Prefers short replies"], "", TODAY);
    const imported = planLearned(chatgpt, ["The person is vegetarian", "Lives in Pune"], "", TODAY);
    expect(imported[0]!.line).toBe("- 2026-10-10 · learned by ChatGPT import · The person is vegetarian");
    let aboutMe = appendAboutMe("", [...bot, ...imported].map((fact) => fact.line))!;
    commitLearned([...bot, ...imported]);
    // The person reworded one imported line and took the mark off another by
    // hand. A line is the import's by the mark it carries: the reworded one
    // still carries it and goes; the one without it is theirs and stays.
    const more = planLearned(chatgpt, ["Has a sister called Asha"], aboutMe, TODAY);
    aboutMe = appendAboutMe(aboutMe, more.map((fact) => fact.line))!;
    commitLearned(more);
    aboutMe = aboutMe.replace("Lives in Pune", "Lives in Pune, near the river").replace("- 2026-10-10 · learned by ChatGPT import · Has a sister called Asha", "- My sister is Asha");
    const saved: string[] = [];
    const result = removeLearnedWhere((fact) => fact.botId.startsWith("import:"), aboutMe, (text) => saved.push(text), { lineMarks: ["ChatGPT import", "Claude import"] });
    expect(result.removed).toBe(2);
    expect(result.aboutMe).toBe("- 2026-10-10 · learned by Scout · Prefers short replies\n- My sister is Asha");
    expect(saved).toEqual([result.aboutMe]);
    expect(listLearnedFacts().map((fact) => fact.botName)).toEqual(["Scout"]);
    expect(planLearned(chatgpt, ["The person is vegetarian"], result.aboutMe, TODAY)).toHaveLength(1);
    expect(removeLearnedWhere((fact) => fact.botId.startsWith("import:"), result.aboutMe)).toEqual({ removed: 0, aboutMe: result.aboutMe });
  });

  it("finds an imported line by its mark after its record has fallen off the list", () => {
    const imported = planLearned(chatgpt, ["The person is vegetarian"], "", TODAY);
    let aboutMe = appendAboutMe("I write short emails.", imported.map((fact) => fact.line))!;
    commitLearned(imported);
    // 200 facts learned since: the list keeps the newest 200, so the import's record is gone
    const later = planLearned({ botId: "b1", botName: "Scout" }, Array.from({ length: 200 }, (_, index) => `Later fact number ${index}`), aboutMe, TODAY);
    commitLearned(later);
    expect(listLearnedFacts().some((fact) => fact.botId.startsWith("import:"))).toBe(false);
    aboutMe = appendAboutMe(aboutMe, ["- 2026-10-10 · learned by Scout · Later fact number 0", "A line of mine that says learned by ChatGPT import in passing"])!;
    const result = removeLearnedWhere((fact) => fact.botId.startsWith("import:"), aboutMe, undefined, { lineMarks: ["ChatGPT import", "Claude import", "Pasted text import"] });
    expect(result.aboutMe).toBe("I write short emails.\n- 2026-10-10 · learned by Scout · Later fact number 0\nA line of mine that says learned by ChatGPT import in passing");
    expect(result.removed).toBe(1);
    // a bot whose name only starts the same way is not the import
    const scout = "- 2026-10-10 · learned by ChatGPT import helper · Not an import";
    expect(removeLearnedWhere(() => false, scout, undefined, { lineMarks: ["ChatGPT import"] })).toEqual({ removed: 0, aboutMe: scout });
  });
});
