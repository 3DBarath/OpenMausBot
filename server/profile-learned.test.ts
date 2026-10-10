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
    // the person edited one imported line by hand: it is theirs now and stays
    aboutMe = aboutMe.replace("Lives in Pune", "Lives in Pune, near the river");
    const saved: string[] = [];
    const result = removeLearnedWhere((fact) => fact.botId.startsWith("import:"), aboutMe, (text) => saved.push(text));
    expect(result.removed).toBe(2);
    expect(result.aboutMe).toBe("- 2026-10-10 · learned by Scout · Prefers short replies\n- 2026-10-10 · learned by ChatGPT import · Lives in Pune, near the river");
    expect(saved).toEqual([result.aboutMe]);
    expect(listLearnedFacts().map((fact) => fact.botName)).toEqual(["Scout"]);
    expect(planLearned(chatgpt, ["The person is vegetarian"], result.aboutMe, TODAY)).toHaveLength(1);
    expect(removeLearnedWhere((fact) => fact.botId.startsWith("import:"), result.aboutMe)).toEqual({ removed: 0, aboutMe: result.aboutMe });
  });
});
