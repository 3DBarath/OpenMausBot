import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreContext } from "@/state/store";
import { t } from "@/lib/i18n";
import type { AttentionRequest } from "@/lib/attention-requests";
import { AttentionRequestItem } from "./AttentionRequests";

type Props = { children?: ReactNode; onClick?: () => void; [key: string]: unknown };
function buttons(tree: ReactNode, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<Props>(child)) continue;
    if (child.type === "button") out.push(child);
    buttons(child.props.children, out);
  }
  return out;
}
const text = (node: ReactNode): string => Children.toArray(node).map((child) => typeof child === "string" ? child : isValidElement<Props>(child) ? text(child.props.children) : "").join("");

const base = { botId: "ada", botName: "Ada", threadId: "t-1", threadTitle: "Deploy" };
const approval: AttentionRequest = { ...base, message: { id: "m1", role: "bot", kind: "options", at: 1,
  card: { title: "Ada wants to run a command", subtitle: "pnpm deploy --prod", options: ["Allow", "Deny"], requestId: "req-1", tool: "Bash" } } as AttentionRequest["message"] };
const question: AttentionRequest = { ...base, message: { id: "m2", role: "bot", kind: "options", at: 2,
  card: { title: "Question", subtitle: "", options: [], requestId: "req-2", requestType: "question",
    questionRequest: { questions: [{ question: "Deploy to which environment?", options: [{ label: "staging" }, { label: "prod" }] }] } } } as unknown as AttentionRequest["message"] };

function render(request: AttentionRequest) {
  const dispatch = vi.fn();
  const onAnswered = vi.fn();
  const value = { state: { bots: [] }, dispatch } as unknown as NonNullable<React.ContextType<typeof StoreContext>>;
  const markup = renderToStaticMarkup(createElement(StoreContext.Provider, { value }, createElement(AttentionRequestItem, { request, dispatch, onAnswered })));
  return { markup, dispatch, onAnswered, tree: AttentionRequestItem({ request, dispatch, onAnswered }) };
}

describe("an ask in the attention panel", () => {
  it("shows an approval's action, detail and the composer's own decisions", () => {
    const { markup } = render(approval);
    expect(markup).toContain("Ada · Deploy");
    expect(markup).toContain("pnpm deploy --prod");
    expect(markup).toContain(t("approval.action.deny"));
    expect(markup).toContain(t("approval.action.allowOnce"));
  });

  it("answers a provider question with one tap, through the same respond path", () => {
    const { markup, tree, dispatch, onAnswered } = render(question);
    expect(markup).toContain("Deploy to which environment?");
    const prod = buttons(tree).find((button) => text(button.props.children) === "prod")!;
    prod.props.onClick!();
    expect(onAnswered).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "decideRequest", threadId: "t-1", requestId: "req-2", behavior: "answer" }));
    expect(dispatch.mock.calls[0]![0].message).toContain("prod");
  });

  it("sends a question it cannot answer in one tap to its conversation", () => {
    const multi = { ...question, message: { ...question.message, card: { ...question.message.card!, questionRequest: { questions: [
      { question: "Which?", multiSelect: true, options: [{ label: "a" }, { label: "b" }] }] } } } } as AttentionRequest;
    const { tree, dispatch } = render(multi);
    const open = buttons(tree).find((button) => text(button.props.children) === t("attention.requests.answerThere"))!;
    open.props.onClick!();
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "ada", threadId: "t-1" });
  });
});
