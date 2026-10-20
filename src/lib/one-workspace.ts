import { useSyncExternalStore } from "react";
import type { OneWorkspaceBridge, OneWorkspaceView, RosterBot, RosterRoom, SideState, WorkspaceSide } from "../../shared/one-workspace";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionName } from "./sidebar-layout";

export const VIEW_REFRESH_MS = 10_000;
const ERROR_SHOWN_MS = 8_000;
const OPENING_GIVES_UP_MS = 45_000;

export type { RosterBot, RosterRoom, WorkspaceSide };

/** Where a row's bot or room lives, and whether the other side has a copy with the same id. */
export interface Home {
  side: WorkspaceSide;
  twin: boolean;
}

/** One page's own bots and rooms (its store) beside the other side's, each id once. */
export interface MergedWorkspace {
  page: WorkspaceSide;
  other: WorkspaceSide;
  cloudName: string;
  state: SideState;
  reason?: string;
  /** This page's own ids that show as their other copy instead. */
  hidden: ReadonlySet<string>;
  /** The other side's bots and rooms that show here. */
  bots: RosterBot[];
  rooms: RosterRoom[];
  homes: ReadonlyMap<string, Home>;
  /** Teams only the other side has, in its order. */
  sections: string[];
  /** Every team to list, the same on both pages: this computer's in its order, then My Cloud's own. */
  teams: string[];
}

interface HereSide {
  /** Until this page's own store has loaded, nothing is merged: a bot both sides have would show as its other copy. */
  hydrated?: boolean;
  bots: ReadonlyArray<{ id: string; hidden?: boolean; section?: string }>;
  groups: ReadonlyArray<{ id: string; dm?: boolean; section?: string }>;
  sections?: readonly string[];
  selectedId?: string | null;
}

/**
 * Every id shows once. A bot or room both sides have (Send keeps its id) shows as `twinHome`'s copy, except the copy
 * this page has open, which keeps its row.
 */
export function mergeWorkspace(view: OneWorkspaceView, here: HereSide): MergedWorkspace {
  const page = view.page, other = view.other.side;
  const mine = new Set([...here.bots.filter((bot) => !bot.hidden).map((bot) => bot.id), ...here.groups.filter((group) => !group.dm).map((group) => group.id)]);
  const theirs = new Set([...view.other.bots.map((bot) => bot.id), ...view.other.rooms.map((room) => room.id)]);
  const hereWins = (id: string) => id === here.selectedId || view.twinHome === page;
  const hidden = new Set<string>();
  const homes = new Map<string, Home>();
  const shownThere = <T extends { id: string }>(items: readonly T[]) => items.filter((item) => {
    if (!mine.has(item.id)) {
      homes.set(item.id, { side: other, twin: false });
      return true;
    }
    if (hereWins(item.id)) return false;
    hidden.add(item.id);
    homes.set(item.id, { side: other, twin: true });
    return true;
  });
  const bots = shownThere(view.other.bots);
  const rooms = shownThere(view.other.rooms);
  for (const id of mine) if (!hidden.has(id)) homes.set(id, { side: page, twin: theirs.has(id) });
  const known = new Set([...(here.sections ?? []), ...here.bots.flatMap((bot) => bot.section ? [bot.section] : []), ...here.groups.flatMap((group) => group.section ? [group.section] : [])].map((name) => name.trim()));
  const sections = [...new Set([...view.other.sections, ...bots.flatMap((bot) => bot.section ? [bot.section] : []), ...rooms.flatMap((room) => room.section ? [room.section] : [])])]
    .filter((name) => !known.has(name.trim()) && [...bots, ...rooms].some((item) => item.section === name));
  const mineTeams = here.sections ?? [];
  const [computerTeams, cloudTeams] = page === "computer" ? [mineTeams, view.other.sections] : [view.other.sections, mineTeams];
  const teams = [...new Set([...computerTeams, ...cloudTeams])].filter((name) => mineTeams.includes(name) || sections.includes(name));
  return { page, other, cloudName: view.cloudName, state: view.other.state, ...(view.other.reason ? { reason: view.other.reason } : {}), hidden, bots, rooms, homes, sections, teams };
}

/** The other side's rows a sidebar section holds: a team's by name, else the built-in Bots and Channels sections. */
export function otherSideIn(merged: MergedWorkspace | null, sectionId: string): { bots: RosterBot[]; rooms: RosterRoom[] } {
  if (!merged) return { bots: [], rooms: [] };
  const name = userSectionName(sectionId);
  if (name) {
    const bots = merged.bots.filter((bot) => bot.section === name);
    return { bots: [...bots.filter((bot) => bot.chiefOfStaff), ...bots.filter((bot) => !bot.chiefOfStaff)], rooms: merged.rooms.filter((room) => room.section === name) };
  }
  if (sectionId === BOTS_SECTION_ID) return { bots: merged.bots.filter((bot) => !bot.section), rooms: [] };
  if (sectionId === CHANNELS_SECTION_ID) return { bots: [], rooms: merged.rooms.filter((room) => !room.section) };
  return { bots: [], rooms: [] };
}

/** The built-in sections the other side's rows need, beyond the teams it adds. */
export function otherSideNeeds(merged: MergedWorkspace | null): { bots: boolean; channels: boolean } {
  return { bots: Boolean(merged?.bots.some((bot) => !bot.section)), channels: Boolean(merged?.rooms.some((room) => !room.section)) };
}

/** The other side's rows a sidebar search keeps; its `sections` are every team those rows sit in, so a match in a team
 * both sides have still shows when this page has no match there. */
export function searchMerged(merged: MergedWorkspace | null, query: string): MergedWorkspace | null {
  const q = query.trim().toLowerCase();
  if (!merged || !q) return merged;
  const bots = merged.bots.filter((bot) => bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q));
  const rooms = merged.rooms.filter((room) => room.name.toLowerCase().includes(q));
  return { ...merged, bots, rooms, sections: [...new Set([...bots, ...rooms].flatMap((item) => item.section ? [item.section] : []))] };
}

export function oneWorkspaceBridge(): OneWorkspaceBridge | undefined {
  if (typeof window === "undefined" || window.ogb?.remoteClient?.active) return undefined;
  return window.ogb?.oneWorkspace;
}

export interface OneWorkspaceSnapshot {
  view: OneWorkspaceView | null;
  /** A row of the other side the person opened, while the window moves there. */
  opening: { side: WorkspaceSide; id: string } | null;
  error: string | null;
}

const EMPTY: OneWorkspaceSnapshot = { view: null, opening: null, error: null };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

function publish(patch: Partial<OneWorkspaceSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of Array.from(listeners)) listener();
}

function watch(bridge: OneWorkspaceBridge): () => void {
  let live = true;
  const refresh = () => { void bridge.view().then((view) => { if (live) publish({ view }); }, () => {}); };
  const off = bridge.onView((view) => { if (live) publish({ view }); });
  const whenVisible = () => { if (document.visibilityState === "visible") refresh(); };
  refresh();
  const timer = window.setInterval(whenVisible, VIEW_REFRESH_MS);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", whenVisible);
  return () => {
    live = false;
    off();
    window.clearInterval(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", whenVisible);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && !stopWatching) {
    const bridge = oneWorkspaceBridge();
    if (bridge) stopWatching = watch(bridge);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopWatching?.();
      stopWatching = null;
    }
  };
}

const read = () => snapshot;

/** Main's view of the other side, kept current while anything shows it; null while the two are shown apart. */
export function useOneWorkspace(): OneWorkspaceSnapshot {
  return useSyncExternalStore(subscribe, read, read);
}

/** The last answer for the same arguments (compared by identity), so every render of the same store and view shares one. */
export function lastOf<A extends unknown[], R>(compute: (...args: A) => R): (...args: A) => R {
  let last: { args: A; result: R } | null = null;
  return (...args: A) => {
    if (last && last.args.length === args.length && last.args.every((value, index) => Object.is(value, args[index]))) return last.result;
    last = { args, result: compute(...args) };
    return last.result;
  };
}

const merged = lastOf((view: OneWorkspaceView | null, bots: HereSide["bots"], groups: HereSide["groups"], sections: HereSide["sections"], selectedId: HereSide["selectedId"]) =>
  view ? mergeWorkspace(view, { bots, groups, sections, selectedId }) : null);

/** This page's store merged with the other side; null while the two are shown apart. */
export function useMergedWorkspace(here: HereSide): MergedWorkspace | null {
  const { view } = useOneWorkspace();
  return merged(here.hydrated === false ? null : view, here.bots, here.groups, here.sections, here.selectedId);
}

/** A row of this page's own: its home is this page's side; `twin` when the other side has it too. */
export function useOwnHome(id: string): Home | null {
  const key = useSyncExternalStore(subscribe, () => ownHomeKey(snapshot.view, id), () => ownHomeKey(snapshot.view, id));
  if (!key) return null;
  const [side, twin] = key.split(":");
  return { side: side as WorkspaceSide, twin: twin === "1" };
}

function ownHomeKey(view: OneWorkspaceView | null, id: string): string | null {
  if (!view) return null;
  const twin = view.other.bots.some((bot) => bot.id === id) || view.other.rooms.some((room) => room.id === id);
  return `${view.page}:${twin ? 1 : 0}`;
}

/** Shows a bot or room of the other side there: main moves the window and that side's page opens it. */
export async function openElsewhere(target: { side: WorkspaceSide; id: string }): Promise<void> {
  const bridge = oneWorkspaceBridge();
  if (!bridge || snapshot.opening) return;
  publish({ opening: target, error: null });
  const giveUp = window.setTimeout(() => { if (snapshot.opening === target) publish({ opening: null }); }, OPENING_GIVES_UP_MS);
  try {
    await bridge.open(target);
  } catch (error) {
    window.clearTimeout(giveUp);
    const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "") : String(error);
    publish({ opening: null, error: message });
    window.setTimeout(() => { if (snapshot.error === message) publish({ error: null }); }, ERROR_SHOWN_MS);
  }
}

export function setOneWorkspaceForTests(next: Partial<OneWorkspaceSnapshot> | null): void {
  snapshot = next ? { ...EMPTY, ...next } : EMPTY;
  for (const listener of Array.from(listeners)) listener();
}
