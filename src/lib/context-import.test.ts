import { describe, expect, it } from "vitest";

import type { ImportCandidate, ImportJobView } from "../../shared/context-import";
import { dayInputTime, dayInputValue, estimateMinutes, importIsBusy, importStep, keptCounts, megabytes, reviewGroups } from "./context-import";

const job = (status: ImportJobView["status"]): ImportJobView => ({ id: "j", origin: "chatgpt", status });
const fact = (text: string, over: Partial<ImportCandidate> = {}): ImportCandidate =>
  ({ id: text, text, kind: "subject", subject: "General", aliases: [], date: "2026-01-01", sensitive: null, chatTitle: "", keep: true, ...over });

describe("the import dialog's step", () => {
  it("follows the job's status", () => {
    expect(importStep(null)).toBe("source");
    expect((["created", "uploading", "scanning", "scanned", "preparing", "extracting", "paused", "consolidating", "review", "failed"] as const).map((status) => importStep(job(status))))
      .toEqual(["provide", "waiting", "waiting", "scan", "progress", "progress", "progress", "progress", "review", "failed"]);
  });

  it("keeps asking only while the server is working by itself", () => {
    expect(importIsBusy(null)).toBe(false);
    expect((["created", "uploading", "scanning", "scanned", "preparing", "extracting", "paused", "consolidating", "review", "failed"] as const).filter((status) => importIsBusy(job(status))))
      .toEqual(["uploading", "scanning", "preparing", "extracting", "consolidating"]);
  });
});

describe("review groups", () => {
  it("puts Core first, then subjects by name, with sensitive facts apart", () => {
    const groups = reviewGroups([
      fact("Loves pasta", { subject: "food" }),
      fact("Lives in Pune", { kind: "core", subject: "Home" }),
      fact("Has asthma", { subject: "Health", sensitive: "health", keep: false }),
      fact("Hates olives", { subject: "Food" }),
      fact("Votes early", { kind: "core", subject: "Civic", sensitive: "politics", keep: false }),
    ]);
    expect(groups.map((group) => [group.key, group.title, group.core, group.facts.map((entry) => entry.text), group.sensitive.map((entry) => entry.text)])).toEqual([
      ["core", "", true, ["Lives in Pune"], ["Votes early"]],
      ["subject:food", "food", false, ["Loves pasta", "Hates olives"], []],
      ["subject:health", "Health", false, [], ["Has asthma"]],
    ]);
    expect(reviewGroups([])).toEqual([]);
  });

  it("counts what is ticked", () => {
    expect(keptCounts([fact("a", { kind: "core" }), fact("b", { kind: "core", keep: false }), fact("c"), fact("d")])).toEqual({ core: 1, subjects: 2 });
  });
});

describe("how numbers read", () => {
  it("shows an estimate in whole minutes, never zero", () => {
    expect(estimateMinutes({ minSeconds: 20, maxSeconds: 94 })).toEqual({ min: 1, max: 2 });
    expect(estimateMinutes({ minSeconds: 400, maxSeconds: 1_880 })).toEqual({ min: 7, max: 32 });
    expect(estimateMinutes({ minSeconds: 0, maxSeconds: 0 })).toEqual({ min: 1, max: 1 });
  });

  it("turns a time into a date input's day and back, covering the whole last day", () => {
    const noon = new Date(2026, 9, 10, 12).getTime();
    expect(dayInputValue(noon)).toBe("2026-10-10");
    expect(dayInputTime("2026-10-10", false)).toBe(new Date(2026, 9, 10).getTime());
    expect(dayInputTime("2026-10-10", true)).toBe(new Date(2026, 9, 10, 23, 59, 59, 999).getTime());
    expect(dayInputTime("", false)).toBeNull();
    expect(dayInputTime("10/10/2026", true)).toBeNull();
  });

  it("shows megabytes", () => {
    expect(megabytes(1_572_864)).toBe("1.5");
    expect(megabytes(734_003_200)).toBe("700");
  });
});
