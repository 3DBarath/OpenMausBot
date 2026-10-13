// The one line a routine run card's message carries as text, for clients
// that do not draw the card (moved unchanged from server/index.ts).
import type { Message } from "./store.ts";

export function routineRunFallbackText(card: NonNullable<Message["routineRun"]>): string {
  const goalState = card.goalStatus === "needs-input"
    ? "needs your input"
    : card.goalStatus === "blocked"
      ? "was blocked"
      : card.goalStatus === "limit-reached"
        ? "reached its limit"
        : card.goalStatus === "stopped"
          ? "was stopped"
          : card.goalStatus === "failed"
            ? "failed"
            : undefined;
  const state = goalState ?? (
    card.status === "waiting"
      ? "needs your attention"
      : card.status === "completed"
        ? "completed"
        : card.status === "failed"
          ? "failed"
          : card.status === "cancelled"
            ? "was cancelled"
            : card.status === "missed"
              ? "was missed"
              : card.status === "queued" && card.deferredAt != null
                ? "deferred: target busy"
              : card.status
  );
  // Clients without the card (older phones) draw only this line, so it
  // carries what the run said, not just that it finished.
  const detail = card.summary ?? card.error;
  return `Routine “${card.routineName}” ${state}${detail ? `\n\n${detail}` : ""}`;
}
