import { Cloud, CloudOff, Laptop, Loader2, Moon, Users } from "lucide-react";
import type { BotAvatarCrop } from "../../shared/bot-avatar";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import type { MausColor } from "../../shared/wire";
import { BotAvatar } from "./Avatar";
import { WorkingDots } from "./WorkingIndicator";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { lastOf, openElsewhere, otherSideIn, otherSideNeeds, searchMerged, useMergedWorkspace, useOneWorkspace, useOwnHome, type Home, type MergedWorkspace, type RosterBot, type RosterRoom } from "@/lib/one-workspace";
import { userSectionName } from "@/lib/sidebar-layout";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { AppState, Bot } from "@/state/store";
import type { MapComputer } from "../../shared/map-computer";

/** The sidebar's merged view: all of it, what the search keeps, and the built-in sections the other side's rows need. */
export interface SidebarWorkspace {
  merged: MergedWorkspace;
  searched: MergedWorkspace;
  needs: { bots: boolean; channels: boolean };
}

const sidebarWorkspace = lastOf((merged: MergedWorkspace | null, query: string): SidebarWorkspace | null => {
  if (!merged) return null;
  const searched = searchMerged(merged, query) ?? merged;
  return { merged, searched, needs: otherSideNeeds(searched) };
});

export function useSidebarWorkspace(state: Pick<AppState, "hydrated" | "bots" | "groups" | "sections" | "selectedId">, query: string): SidebarWorkspace | null {
  return sidebarWorkspace(useMergedWorkspace({ hydrated: state.hydrated === true, bots: state.bots, groups: state.groups, sections: state.sections, selectedId: state.selectedId }), query);
}

/** A team's name when this page has that team; null for one only the other side has, whose menu would act here. */
export function ownSectionName(one: SidebarWorkspace | null, id: string): string | null {
  const name = userSectionName(id);
  return name && one?.merged.sections.includes(name) ? null : name;
}

/** "On this computer", "On My Cloud", with "also on …" for a bot both sides have. */
export function homeLabel(home: Home, cloudName: string): string {
  const where = home.side === "cloud" ? t("oneWorkspace.onCloud", { cloud: cloudName }) : t("oneWorkspace.onComputer");
  if (!home.twin) return where;
  return `${where} · ${home.side === "cloud" ? t("oneWorkspace.alsoOnComputer") : t("oneWorkspace.alsoOnCloud", { cloud: cloudName })}`;
}

/** The small home mark on a row's avatar, at its bottom-left `corner` or top-left where the model mark sits below (or
 * beside a room's name, `inline`). */
export function HomeBadge({ home, cloudName, inline = false, corner = "bottom" }: { home: Home; cloudName: string; inline?: boolean; corner?: "bottom" | "top" }) {
  const Icon = home.side === "cloud" ? Cloud : Laptop;
  const label = homeLabel(home, cloudName);
  return (
    <span data-home-badge={home.side} data-home-twin={home.twin || undefined} role="img" aria-label={label} title={label}
      className={inline
        ? "inline-flex shrink-0 items-center text-ink-secondary"
        : cn("pointer-events-none absolute -left-1 flex size-[19px] items-center justify-center rounded-full border-2 border-panel bg-raised text-ink-secondary", corner === "top" ? "-top-1" : "-bottom-1")}>
      <Icon size={inline ? 12 : 11} strokeWidth={2.25} aria-hidden="true" />
    </span>
  );
}

/** The badge on a row of this page's own, while This computer and My Cloud show together. */
export function OwnHomeBadge({ id, inline = false, corner }: { id: string; inline?: boolean; corner?: "bottom" | "top" }) {
  const home = useOwnHome(id);
  const { view } = useOneWorkspace();
  if (!home || !view) return null;
  return <HomeBadge home={home} cloudName={view.cloudName} inline={inline} corner={corner} />;
}

function stateNote(merged: MergedWorkspace): string | null {
  if (merged.state === "ready") return null;
  if (merged.other === "computer") return t("oneWorkspace.computerUnreachable");
  if (merged.state === "asleep") return t("oneWorkspace.cloudAsleep", { cloud: merged.cloudName });
  if (merged.state === "signed-out") return t("oneWorkspace.cloudSignedOut", { cloud: merged.cloudName });
  return merged.reason ?? t("oneWorkspace.cloudUnreachable", { cloud: merged.cloudName });
}

function placeName(merged: MergedWorkspace): string {
  return merged.other === "cloud" ? merged.cloudName : t("oneWorkspace.thisComputer");
}

/** The other side's state while it is not answering, and an open on its way or refused. */
export function OneWorkspaceStatus({ merged, density }: { merged: MergedWorkspace | null; density: SidebarDensity }) {
  const { opening, error } = useOneWorkspace();
  if (!merged || density === "icons") return null;
  const note = error ?? (opening ? (opening.side === "cloud" ? t("oneWorkspace.openingCloud", { cloud: merged.cloudName }) : t("oneWorkspace.openingComputer")) : stateNote(merged));
  if (!note) return null;
  const Icon = error ? CloudOff : opening ? Loader2 : merged.state === "asleep" ? Moon : CloudOff;
  return (
    <p role={error ? "alert" : "status"} data-one-workspace-status={error ? "error" : opening ? "opening" : merged.state}
      className={cn("mx-2 mb-1 flex items-start gap-2 rounded-lg bg-raised/50 px-2.5 py-2 text-[12px] leading-[16px]", error ? "text-danger" : "text-ink-secondary")}>
      <Icon size={13} aria-hidden="true" className={cn("mt-[1px] shrink-0", opening && !error && "animate-spin")} />
      <span>{note}</span>
    </p>
  );
}

const asAvatar = (bot: RosterBot) => ({
  name: bot.name, color: bot.color as MausColor, avatarUrl: bot.avatarUrl, avatarCrop: bot.avatarCrop as BotAvatarCrop | undefined,
  avatarZoom: bot.avatarZoom, avatarFocusX: bot.avatarFocusX, avatarFocusY: bot.avatarFocusY, mascotBody: (bot.mascotBody ?? null) as MascotBodyId | null,
});

function rowClasses(density: SidebarDensity, simple: boolean) {
  return cn(
    "relative flex w-full items-center rounded-xl text-left outline-none transition-colors duration-150 hover:bg-raised/50 focus-visible:ring-1 focus-visible:ring-accent/60",
    density === "icons" ? (simple ? "h-[52px] justify-center" : "justify-center px-1 py-1.5")
      : density === "compact" ? "gap-2.5 py-1.5 pl-2 pr-3" : simple ? "gap-2.5 py-2 pl-2 pr-3" : "gap-3 py-2 pl-2.5 pr-3",
  );
}

export function OtherSideBotRow({ bot, merged, density }: { bot: RosterBot; merged: MergedWorkspace; density: SidebarDensity }) {
  const advanced = useAdvancedMode();
  const { opening } = useOneWorkspace();
  const home = merged.homes.get(bot.id) ?? { side: merged.other, twin: false };
  const ready = merged.state === "ready";
  const iconOnly = density === "icons";
  const simple = !advanced;
  const working = ready && (bot.busy === true || bot.activity === "working");
  const waiting = ready && bot.activity === "waiting-on-you";
  const unread = ready && bot.unread;
  const thisOne = opening?.id === bot.id;
  const size = iconOnly ? (simple ? 36 : 44) : density === "compact" ? 36 : simple ? 36 : 44;
  const place = placeName(merged);
  const line = thisOne ? (merged.other === "cloud" ? t("oneWorkspace.openingCloud", { cloud: merged.cloudName }) : t("oneWorkspace.openingComputer"))
    : waiting ? t("sidebar.preview.waiting") : !ready ? (merged.state === "asleep" ? t("oneWorkspace.asleepBadge") : t("oneWorkspace.unreachableBadge")) : bot.title || place;
  const label = t("oneWorkspace.openOn", { name: bot.name, place });
  return (
    <div className={cn("group relative", iconOnly && simple && "mx-auto w-[52px]")}>
      <button type="button" data-other-side-bot={bot.id} data-home={home.side} aria-label={`${label} · ${homeLabel(home, merged.cloudName)}${unread ? ` · ${t("task.unread")}` : ""}`}
        title={iconOnly ? label : undefined} disabled={Boolean(opening)} onClick={() => void openElsewhere({ side: merged.other, id: bot.id })}
        className={cn(rowClasses(density, simple), "disabled:cursor-progress")}>
        <span className={cn("relative flex shrink-0", !ready && "opacity-60")}>
          <BotAvatar bot={asAvatar(bot)} state="happy" size={size} animated={false} />
          {working && <span className={cn("absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-panel bg-success", iconOnly ? "size-3" : "size-2.5")} />}
          {waiting && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-panel bg-warning" />}
          <HomeBadge home={home} cloudName={merged.cloudName} />
        </span>
        {!iconOnly && <span className="min-w-0 flex-1">
          <span className={cn("flex items-center justify-between gap-2", simple ? "text-[14px] font-normal leading-[19px]" : "text-[15px] font-semibold leading-5")}>
            <span className={cn("truncate", ready ? "text-ink" : "text-ink-secondary")}>{bot.name}</span>
            {density === "compact" && unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" />}
          </span>
          {density !== "compact" && <span className="flex items-center justify-between gap-2">
            <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-[13px] leading-[18px]", waiting ? "font-semibold text-warning" : "text-ink-secondary")}>
              {thisOne ? <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin" /> : !ready && (merged.state === "asleep" ? <Moon size={12} aria-hidden="true" className="shrink-0" /> : <CloudOff size={12} aria-hidden="true" className="shrink-0" />)}
              {working && !thisOne ? <span className="flex h-[1.5em] items-center"><WorkingDots size={3.5} /><span className="sr-only">{t("sidebar.preview.working")}</span></span> : <span className="truncate">{line}</span>}
            </span>
            {unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
          </span>}
        </span>}
        {iconOnly && unread && <span className={cn("pointer-events-none absolute size-2 rounded-full border border-panel bg-accent", simple ? "right-1 top-1" : "bottom-1.5 right-1.5")} />}
      </button>
    </div>
  );
}

export function OtherSideRoomRow({ room, merged, density }: { room: RosterRoom; merged: MergedWorkspace; density: SidebarDensity }) {
  const advanced = useAdvancedMode();
  const { opening } = useOneWorkspace();
  const home = merged.homes.get(room.id) ?? { side: merged.other, twin: false };
  const ready = merged.state === "ready";
  const iconOnly = density === "icons";
  const simple = !advanced;
  const members = room.memberIds.map((id) => merged.bots.find((bot) => bot.id === id)).filter((bot): bot is RosterBot => Boolean(bot)).slice(0, 2);
  const label = t("oneWorkspace.openOn", { name: room.name, place: placeName(merged) });
  const unread = ready && room.unread;
  return (
    <div className={cn("group relative", iconOnly && simple && "mx-auto w-[52px]")}>
      <button type="button" data-other-side-room={room.id} data-home={home.side} aria-label={`${label} · ${homeLabel(home, merged.cloudName)}`} title={iconOnly ? label : undefined}
        disabled={Boolean(opening)} onClick={() => void openElsewhere({ side: merged.other, id: room.id })} className={cn(rowClasses(density, simple), "disabled:cursor-progress")}>
        <span className={cn("relative flex shrink-0 items-center justify-center", iconOnly ? "size-12" : simple ? "size-9" : "size-8", !ready && "opacity-60")}>
          {members.length ? <span className="flex items-center -space-x-2.5">{members.map((bot) => <BotAvatar key={bot.id} bot={asAvatar(bot)} state="happy" size={members.length > 1 ? (iconOnly ? 30 : 26) : (iconOnly ? 44 : 32)} animated={false} />)}</span>
            : <Users size={22} aria-hidden="true" className="text-ink-secondary" />}
          <HomeBadge home={home} cloudName={merged.cloudName} />
        </span>
        {!iconOnly && <span className="min-w-0 flex-1">
          <span className={cn("flex items-center justify-between gap-2 text-[14px]", simple ? "font-normal leading-[19px]" : "font-semibold")}>
            <span className={cn("truncate", ready ? "text-ink" : "text-ink-secondary")}>{room.name}</span>
            {unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
          </span>
          {density !== "compact" && <span className="block truncate text-[13px] leading-[18px] text-ink-secondary">{!ready ? (merged.state === "asleep" ? t("oneWorkspace.asleepBadge") : t("oneWorkspace.unreachableBadge")) : room.working ? t("sidebar.preview.working") : placeName(merged)}</span>}
        </span>}
      </button>
    </div>
  );
}

/** The other side's rows in one sidebar section, as a section lists its own: chiefs, rooms, then bots. This computer's
 * rows come first on both pages (`place` "before" this page's own rows on My Cloud's page, "after" them on this
 * computer's), so the list reads the same wherever the window is. */
export function OtherSideRows({ merged, sectionId, density, place }: { merged: MergedWorkspace | null; sectionId: string; density: SidebarDensity; place: "before" | "after" }) {
  const { bots, rooms } = otherSideIn(merged, sectionId);
  if (!merged || bots.length + rooms.length === 0 || (place === "before") !== (merged.other === "computer")) return null;
  return <>
    {bots.filter((bot) => bot.chiefOfStaff).map((bot) => <OtherSideBotRow key={bot.id} bot={bot} merged={merged} density={density} />)}
    {rooms.map((room) => <OtherSideRoomRow key={room.id} room={room} merged={merged} density={density} />)}
    {bots.filter((bot) => !bot.chiefOfStaff).map((bot) => <OtherSideBotRow key={bot.id} bot={bot} merged={merged} density={density} />)}
  </>;
}

/** The other side's bots as the Team map draws them, with each one's computer when it has one there. */
export interface ElsewhereOnMap {
  merged: MergedWorkspace;
  ids: ReadonlySet<string>;
  bots: Bot[];
  computers: MapComputer[];
}

const MAP_COMPUTER_KINDS = new Set(["cloud", "vm"]);

export function elsewhereOnMap(merged: MergedWorkspace | null): ElsewhereOnMap | null {
  if (!merged) return null;
  const ready = merged.state === "ready";
  const bots = merged.bots.map((bot) => ({
    ...bot, description: "", messages: [], tasks: undefined, modelSelection: { instanceId: "", model: "" }, unread: ready && bot.unread,
    busy: ready && bot.busy, activity: ready ? bot.activity : undefined,
  }) as unknown as Bot);
  const computers = merged.bots.filter((bot) => bot.computer && MAP_COMPUTER_KINDS.has(bot.computer)).map((bot): MapComputer => ({
    id: bot.id, kind: "bot", name: bot.name, botIds: [bot.id], state: !ready ? "asleep" : bot.busy ? "working" : "idle",
  }));
  return { merged, ids: new Set(merged.bots.map((bot) => bot.id)), bots, computers };
}

/** A Team-map card for a bot of the other side: it opens there; its settings, model and team live on its own side. */
export function ElsewhereCard({ bot, merged }: { bot: Bot; merged: MergedWorkspace }) {
  const { opening } = useOneWorkspace();
  const home = merged.homes.get(bot.id) ?? { side: merged.other, twin: false };
  const ready = merged.state === "ready";
  const place = placeName(merged);
  const label = t("oneWorkspace.openOn", { name: bot.name, place });
  const thisOne = opening?.id === bot.id;
  const status = !ready ? (merged.state === "asleep" ? t("oneWorkspace.asleepBadge") : t("oneWorkspace.unreachableBadge"))
    : bot.activity === "waiting-on-you" ? t("sidebar.preview.waiting") : bot.busy ? t("sidebar.preview.working") : null;
  return <article data-elsewhere-card={bot.id} data-home={home.side} className="relative h-[126px] w-[236px] shrink-0 rounded-xl border border-dashed border-hairline/70 bg-card/80 shadow-sm">
    <button type="button" aria-label={`${label} · ${homeLabel(home, merged.cloudName)}`} disabled={Boolean(opening)} onClick={() => void openElsewhere({ side: merged.other, id: bot.id })}
      className="flex h-[82px] w-full items-center gap-3 rounded-t-xl px-4 text-left focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-progress">
      <span className={cn("relative flex shrink-0", !ready && "opacity-60")}>
        <BotAvatar bot={bot} size={38} motion="none" motionKey={0} animated={false} />
        <HomeBadge home={home} cloudName={merged.cloudName} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold">{bot.name}</span>
        <span className="mt-1 block truncate text-[11px] text-ink-secondary">{bot.title || homeLabel({ side: home.side, twin: false }, merged.cloudName)}</span>
      </span>
    </button>
    <div className="flex h-[43px] items-center gap-2 border-t border-hairline/30 px-3 text-[10.5px] text-ink-secondary">
      {thisOne ? <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin" /> : home.side === "cloud" ? <Cloud size={12} aria-hidden="true" className="shrink-0" /> : <Laptop size={12} aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{thisOne ? (merged.other === "cloud" ? t("oneWorkspace.openingCloud", { cloud: merged.cloudName }) : t("oneWorkspace.openingComputer")) : status ?? homeLabel({ side: home.side, twin: false }, merged.cloudName)}</span>
    </div>
  </article>;
}
