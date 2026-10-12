// Time bounds in tests, relative to the machine that runs them.
//
// "This takes under two seconds" is a statement about a machine: a CI runner
// three to five times slower fails it with nothing wrong, and a faster one
// passes it with something wrong. What such a test is for is a statement
// about the work: reading eight times as much costs no more than eight
// times as much; refusing a file costs no more than reading the part of it
// that may be read; no one stretch holds the event loop for longer than a
// step's worth of the work. So a bound here is never a number of
// milliseconds. It is a multiple of a reference that the same test measures
// on the same machine, moments apart, the same way.
//
//   cpuOf(work)        the processor time `work` used
//   watch(work)        how long `work` took by the clock, the longest it
//                      went without letting the event loop turn, and the
//                      longest this process was kept waiting with nothing
//                      to do, right after
//   least(times, run)  the least of several measurements
//   expectWithin(...)  measured <= bound, with both numbers in the failure
//   expectNoLongStretch(...)  the longest stretch of one of a few watched
//                      runs is within what the test allows for the work
//   expectAtLeast(...) counted >= floor, for a count no machine changes
//                      (reads of a file, items handed over)
//
// Processor time is the whole process's (this repository runs one test file
// at a time), and it does not count time spent waiting for a turn on a busy
// machine. On Windows it moves in steps of about 16 ms, so a reference has
// to be worth many of those: make it tens of milliseconds on a fast machine.
//
// A stretch (how long the event loop went without turning) is taken by the
// clock, which is exact on every system and does count waiting. Two things
// keep a busy machine from deciding. A stretch is taken from the best of a
// few runs: load only ever adds. And each watched run is followed by a
// watch of nothing at all, for as long: the longest gap in that is what the
// machine does to this process by itself, with no work to blame. A stretch
// may always be three times that. On a quiet machine that is a fraction of
// a millisecond and changes nothing. On one with every core taken twice
// over it is a tenth of a second, and a bound that ignored it would fail
// for a reason that has nothing to do with the code. (Under such load the
// time bounds say less; the counts say as much as ever.)
//
// `watch` ticks once per turn of the event loop (setImmediate), so a test
// can count what was done between two turns instead of timing it: that
// needs no reference at all. The ticking keeps the loop from sleeping while
// `work` waits on the disk. Two things follow. The loop turns many times
// during such a wait, so the count of turns says how often `work` gave way
// only for work that never waits on anything but its own turn. And the
// ticking burns processor time, so processor time is never taken from a
// watched run: measure it with `cpuOf` in a run of its own.
//
// Set TEST_TIME_LOG to a file and every bound that is checked appends a
// line of JSON there: what was measured, the bound, and the margin. That is
// how the margins on a given machine are read, pass or fail.
import { appendFileSync } from "node:fs";
import { expect } from "vitest";

/** Processor time this process has used so far, in milliseconds. */
function cpuNow(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/** The processor time `work` used, in milliseconds, and what it returned. */
export async function cpuOf<T>(work: () => T | Promise<T>): Promise<{ result: T; cpu: number }> {
  const before = cpuNow();
  const result = await work();
  return { result, cpu: cpuNow() - before };
}

export interface Watched<T> {
  result: T;
  /** How long it took by the clock, in milliseconds. */
  wall: number;
  /** The longest the event loop went without turning, in milliseconds. */
  stall: number;
  /** How many times the event loop turned: at least as often as `work` gave way, and more while it waited on the disk. */
  turns: number;
  /** The longest the event loop went without turning while nothing ran, watched right after for as long (a second at most). */
  quiet: number;
}

/** How long the machine is watched with nothing running, at most. */
const QUIET_MAX_MS = 1_000;

/** Tick on every turn of the event loop until `done` settles: the time it took, the longest gap between two ticks, and how many there were. */
async function ticking<T>(done: () => Promise<T>, onTurn: () => void): Promise<{ result: T; wall: number; stall: number; turns: number }> {
  let turns = 0;
  let stall = 0;
  let watching = true;
  const started = performance.now();
  let last = started;
  const tick = (): void => {
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
    turns += 1;
    onTurn();
    if (watching) setImmediate(tick);
  };
  setImmediate(tick);
  try {
    const result = await done();
    const ended = performance.now();
    return { result, wall: ended - started, stall: Math.max(stall, ended - last), turns };
  } finally {
    watching = false;
  }
}

/** Run `work` with a tick on every turn of the event loop. `onTurn` is
 * called at each tick, so a test can count what was done between two. */
export async function watch<T>(work: () => Promise<T>, onTurn: () => void = () => undefined): Promise<Watched<T>> {
  // a first turn, so that what the test did before this is not counted as a stall of the work
  await new Promise<void>((resolve) => setImmediate(resolve));
  const worked = await ticking(work, onTurn);
  const idle = await ticking(() => new Promise<void>((resolve) => setTimeout(resolve, Math.min(worked.wall, QUIET_MAX_MS))), () => undefined);
  return { ...worked, quiet: idle.stall };
}

/** The least of `times` measurements: whatever else the machine is doing only ever adds. */
export async function least(times: number, measure: () => Promise<number>): Promise<number> {
  let best = Infinity;
  for (let run = 0; run < times; run += 1) best = Math.min(best, await measure());
  return best;
}

const rounded = (value: number): number => Math.round(value * 1000) / 1000;

/** One line in the log, where there is one. `margin` is how many times over the measurement could go (or under) before the bound fails. */
function logged(what: string, measured: number, bound: number, margin: number): void {
  const log = process.env.TEST_TIME_LOG;
  if (!log) return;
  try {
    appendFileSync(log, `${JSON.stringify({ test: expect.getState().currentTestName, what, measured: rounded(measured), bound: rounded(bound), margin: Number.isFinite(margin) ? Math.round(margin * 10) / 10 : null })}\n`);
  } catch {
    /* the log is a convenience */
  }
}

/** `measured` is at most `bound`, both in the same unit. `what` says what is
 * measured and what the bound is made of, for the failure and for the log. */
export function expectWithin(what: string, measured: number, bound: number): void {
  logged(what, measured, bound, bound / measured);
  expect(measured, `${what}: measured ${rounded(measured)}, may be at most ${rounded(bound)}`).toBeLessThanOrEqual(bound);
}

/** How many times the machine's own longest gap a stretch may always be. */
const QUIET_TIMES = 3;

/** No long stretch: of these watched runs of the same work, the one with the
 * most room has its longest stretch within `allowed(run)` milliseconds, or
 * within three times the longest that run's machine kept this process
 * waiting with nothing to do, whichever is more. `allowed` is a multiple of
 * something measured (a share of the run itself, the cost of a smaller run),
 * never a number of milliseconds. */
export function expectNoLongStretch<T>(what: string, runs: ReadonlyArray<Watched<T>>, allowed: (run: Watched<T>) => number): void {
  const room = (run: Watched<T>) => Math.max(allowed(run), QUIET_TIMES * run.quiet) / run.stall;
  const best = runs.reduce((one, other) => (room(other) > room(one) ? other : one));
  expectWithin(what, best.stall, Math.max(allowed(best), QUIET_TIMES * best.quiet));
}

/** `counted` is at least `floor`: for a count that does not depend on the
 * machine (reads of a file), logged with the same margins. */
export function expectAtLeast(what: string, counted: number, floor: number): void {
  logged(what, counted, floor, counted / floor);
  expect(counted, `${what}: counted ${counted}, must be at least ${floor}`).toBeGreaterThanOrEqual(floor);
}
