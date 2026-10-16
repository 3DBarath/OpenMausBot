import { describe, expect, it } from "vitest";
import { oneTapAnswer, oneTapQuestion, visibleRequests, type AttentionRequest } from "./attention-requests";

const request = (requestId: string, card: Record<string, unknown> = {}): AttentionRequest => ({
  botId: "ada", botName: "Ada", threadId: "t", threadTitle: "Deploy",
  message: { id: requestId, role: "bot", kind: "options", at: 1, card: { title: "x", subtitle: "", options: [], requestId, ...card } } as AttentionRequest["message"],
});

describe("attention requests on screen", () => {
  it("hides an ask answered here or settled since", () => {
    const list = [request("a"), request("b"), request("c", { expired: true }), request("d", { answered: "Allow" })];
    expect(visibleRequests(list, new Set(["b"])).map((entry) => entry.message.id)).toEqual(["a"]);
  });

  it("offers one-tap answers only for a single single-choice question with options", () => {
    const one = { question: "Where?", options: [{ label: "staging" }, { label: "prod" }] };
    expect(oneTapQuestion(request("q", { questionRequest: { questions: [one] } }))).toEqual(one);
    expect(oneTapQuestion(request("q", { questionRequest: { questions: [{ ...one, multiSelect: true }] } }))).toBeNull();
    expect(oneTapQuestion(request("q", { questionRequest: { questions: [one, one] } }))).toBeNull();
    expect(oneTapQuestion(request("q", { questionRequest: { questions: [{ question: "Why?", options: [] }] } }))).toBeNull();
    expect(oneTapAnswer(one, "prod")).toContain("prod");
  });
});
