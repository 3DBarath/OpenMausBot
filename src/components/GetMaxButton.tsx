import { useEffect, useRef, useState } from "react";
import { Crown, Loader2 } from "lucide-react";
import { useStore } from "@/state/store";
import { useCloudPlan } from "./ProIntroduction";
import { useCloudOffer } from "@/lib/use-cloud-offer";
import { usd } from "@/lib/cloud-plan";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const UPGRADE_POLL_MS = 3_000;
const UPGRADE_WAIT_MS = 3 * 60_000;

type Outcome = "waiting" | "slow" | "unavailable" | "done" | LocaleKey | null;

export function GetMaxButton({ className }: { className?: string }) {
  const { dispatch } = useStore();
  const plan = useCloudPlan();
  const bridge = window.ogb?.cloudAccount;
  const offer = useCloudOffer(plan !== null, plan?.account?.offer);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const inFlight = useRef(false);
  const waiting = outcome === "waiting";

  useEffect(() => {
    if (!waiting || !bridge) return;
    let active = true;
    const stop = () => { active = false; clearInterval(poll); clearTimeout(deadline); };
    const poll = setInterval(() => {
      void bridge.refresh().then((next) => { if (active && next.entitlement?.tier === "max") { stop(); setOutcome("done"); } }, () => {});
    }, UPGRADE_POLL_MS);
    const deadline = setTimeout(() => { stop(); setOutcome("slow"); }, UPGRADE_WAIT_MS);
    return stop;
  }, [waiting, bridge]);

  if (!plan || !bridge || outcome === "done") return null;
  const { view, account } = plan;
  const mode = view.kind === "signed-out" || view.kind === "free" ? "checkout"
    : view.kind === "paid" ? (account?.entitlement?.tier === "max" ? null : "upgrade")
      : view.kind === "unknown" || view.kind === "connecting" ? null : "settings";
  if (mode === null || (mode === "checkout" && !bridge.checkout) || (mode === "upgrade" && !bridge.upgrade)) return null;

  const max = offer?.plans.find((entry) => entry.tier === "max");
  const label = max ? t("science.getMax", { price: usd(max.amount / 100) }) : t("science.getMaxNoPrice");

  const start = async () => {
    if (inFlight.current) return;
    if (mode === "settings") { dispatch({ type: "toggleAppSettings", open: true, section: "cloudAccount" }); return; }
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
    try {
      const result = mode === "upgrade" ? await bridge.upgrade!("max", "science") : await bridge.checkout!("max", "science");
      setOutcome(outcomeFor(mode, result.outcome));
    } catch {
      setOutcome(mode === "upgrade" ? "science.upgradeError" : "cloudAdd.failed");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex flex-col items-end gap-1.5", className)}>
      <button type="button" disabled={busy || waiting} onClick={() => void start()} className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-2 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
        {busy || waiting ? <Loader2 size={14} className="animate-spin" /> : <Crown size={14} />} {label}
      </button>
      {waiting && <div role="status" className="text-[11.5px] text-ink-secondary">{t("science.upgradePending")}</div>}
      {outcome === "slow" && <div role="status" className="max-w-xs text-right text-[11.5px] text-ink-secondary">{t("science.upgradeSlow")}</div>}
      {outcome === "unavailable" && (
        <div role="alert" className="flex max-w-xs flex-col items-end gap-1.5 text-right text-[11.5px] text-warning">
          {t("science.planChangeUnavailable")}
          <button type="button" onClick={() => void bridge.openDashboard()} className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover">{t("cloudProPopup.manage")}</button>
        </div>
      )}
      {outcome && outcome !== "waiting" && outcome !== "slow" && outcome !== "unavailable" && (
        <div role="alert" className="max-w-xs text-right text-[11.5px] text-danger">{t(outcome)}</div>
      )}
    </div>
  );
}

function outcomeFor(mode: "checkout" | "upgrade", outcome: string): Outcome {
  if (outcome === "upgraded" || outcome === "already-on-plan") return "done";
  if (outcome === "pending") return "waiting";
  if (outcome === "unavailable") return "unavailable";
  if (outcome === "payment-failed") return "science.upgradeFailed";
  if (outcome === "rate-limited") return mode === "upgrade" ? "science.upgrade.rateLimited" : "cloudAdd.rateLimited";
  if (outcome === "opened" || outcome === "signing-in") return null;
  return mode === "upgrade" ? "science.upgradeError" : "cloudAdd.failed";
}
