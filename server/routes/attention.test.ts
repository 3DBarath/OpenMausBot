import { describe, expect, it } from "vitest";
import { attentionRequests, openAsk } from "./attention.ts";

const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  id, role: "bot", kind: "options", at: Number(id.replace(/\D/g, "")) || 1,
  card: { title: "Run a command", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestId: `req-${id}`, tool: "Bash", ...extra },
});
const question = (id: string) => ({
  id, role: "bot", kind: "options", at: 5,
  card: { title: "Which?", subtitle: "", options: [], requestId: `req-${id}`, requestType: "question",
    questionRequest: { questions: [{ question: "Deploy to which?", options: [{ label: "staging" }, { label: "prod" }] }] } },
});

function storeWith(threads: Record<string, unknown[]>, bots: unknown[]) {
  return { bots, messagesFor: (threadId: string) => threads[threadId] ?? [] } as never;
}

describe("attention requests", () => {
  it("lists only live, unanswered approvals and questions", () => {
    expect(openAsk(approval("a1") as never)).toBe(true);
    expect(openAsk(question("q1") as never)).toBe(true);
    for (const settled of [{ answered: "Allow" }, { dismissed: true }, { expired: true }, { requestId: undefined }, { tool: undefined }]) {
      expect(openAsk(approval("a2", settled) as never), JSON.stringify(settled)).toBe(false);
    }
    expect(openAsk({ id: "t", role: "bot", kind: "text", at: 1 } as never)).toBe(false);
  });

  it("reads only conversations waiting on the person and the viewer may see, oldest ask first", () => {
    const store = storeWith({
      main: [approval("a3")],
      side: [question("q1"), approval("a9", { answered: "Deny" })],
      busy: [approval("a2")],
      hidden: [approval("a1")],
    }, [
      { id: "ada", name: "Ada", threadId: "main", activity: "waiting-on-you", tasks: [
        { threadId: "main", title: "Main" },
        { threadId: "side", title: "Deploy", activity: "waiting-on-you" },
        { threadId: "busy", title: "Busy", activity: "working" },
      ] },
      { id: "bo", name: "Bo", threadId: "hidden", activity: "waiting-on-you", tasks: [] },
    ]);
    const out = attentionRequests(store, (threadId) => threadId !== "hidden");
    expect(out.map((request) => [request.botName, request.threadTitle, request.message.card?.requestId])).toEqual([
      ["Ada", "Main", "req-a3"],
      ["Ada", "Deploy", "req-q1"],
    ]);
  });
});
