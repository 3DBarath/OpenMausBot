// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CloudAccountState } from "../../electron/cloud-account.mjs";
import { setLocale } from "@/lib/i18n";

const store = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: store.dispatch }) }));

import { GetMaxButton } from "./GetMaxButton";

const paid = (tier: string): CloudAccountState => ({ status: "connected", entitlement: { plan: "pro", tier, status: "active", expiresAt: null, version: 1 } });
const free: CloudAccountState = { status: "connected", entitlement: { plan: "free", status: "inactive", expiresAt: null, version: 1 } };
const signedOut: CloudAccountState = { status: "signed-out" };
const attention: CloudAccountState = { status: "connected", entitlement: { plan: "pro", tier: "pro", status: "inactive", expiresAt: null, version: 1 } };
const reauth: CloudAccountState = { status: "reauth-required", message: "expired" };
const offer = { plans: [{ tier: "personal", amount: 2900 }, { tier: "max", amount: 9900 }], recommended: "personal" };

let host: HTMLDivElement;
let root: Root;
let bridge: Record<string, ReturnType<typeof vi.fn>>;

const settle = () => act(async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const button = (label: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);

async function mount(account: CloudAccountState | null, extra: Record<string, unknown> = {}) {
  bridge = {
    state: vi.fn(async () => account),
    onState: vi.fn(() => () => {}),
    refresh: vi.fn(async () => account),
    openDashboard: vi.fn(async () => account),
    offer: vi.fn(async () => null),
    checkout: vi.fn(async () => ({ outcome: "opened", state: account })),
    upgrade: vi.fn(async () => ({ outcome: "upgraded", state: account })),
    ...extra,
  };
  Object.defineProperty(window, "ogb", { value: { cloudAccount: bridge }, configurable: true, writable: true });
  await act(async () => root.render(createElement(GetMaxButton)));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "ogb");
});

describe("Get Max", () => {
  it("shows the Admin's price, and none without an offer", async () => {
    await mount(free, { offer: vi.fn(async () => offer) });
    expect(button("Get Max · $99/month")).toBeTruthy();
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(free);
    expect(button("Get Max")).toBeTruthy();
  });

  it("shows nothing for a Max account or without the desktop bridge", async () => {
    await mount(paid("max"));
    expect(host.textContent).toBe("");
    await act(async () => root.unmount());
    root = createRoot(host);
    Reflect.deleteProperty(window, "ogb");
    await act(async () => root.render(createElement(GetMaxButton)));
    expect(host.textContent).toBe("");
  });

  it.each([["signed out", signedOut], ["a free account", free]])("%s opens checkout", async (_name, account) => {
    await mount(account);
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(bridge.checkout).toHaveBeenCalledWith("max", "science");
    expect(bridge.upgrade).not.toHaveBeenCalled();
  });

  it("says checkout failed or was rate limited", async () => {
    await mount(free, { checkout: vi.fn(async () => ({ outcome: "failed", state: free })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toContain("Checkout couldn't open");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(free, { checkout: vi.fn(async () => ({ outcome: "rate-limited", state: free })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toContain("You've opened several checkouts");
  });

  it("disables the button while a request is in flight", async () => {
    let release: (value: unknown) => void = () => {};
    await mount(paid("pro"), { upgrade: vi.fn(() => new Promise((resolve) => { release = resolve; })) });
    await act(async () => button("Get Max")!.click());
    expect(button("Get Max")!.disabled).toBe(true);
    await act(async () => button("Get Max")!.click());
    expect(bridge.upgrade).toHaveBeenCalledTimes(1);
    await act(async () => release({ outcome: "failed", state: paid("pro") }));
    await settle();
    expect(button("Get Max")!.disabled).toBe(false);
  });

  it.each(["personal", "pro"])("%s upgrades in place", async (tier) => {
    await mount(paid(tier));
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(bridge.upgrade).toHaveBeenCalledWith("max", "science");
    expect(bridge.checkout).not.toHaveBeenCalled();
  });

  it.each([
    ["payment-failed", "Your payment didn't go through, so your plan hasn't changed."],
    ["failed", "Max couldn't be added right now."],
    ["rate-limited", "Too many attempts. Try again in a few minutes."],
  ])("an upgrade that ends %s says so", async (outcome, text) => {
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome, state: paid("pro") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toContain(text);
  });

  it.each(["upgraded", "already-on-plan"])("%s is a success and the button goes", async (outcome) => {
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome, state: paid("max") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toBe("");
  });

  it("a payment still going through waits for Max", async () => {
    vi.useFakeTimers();
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome: "pending", state: paid("pro") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toContain("Waiting for your payment to go through…");
    expect(host.querySelector(".animate-spin")).not.toBeNull();
    await advance(3_000);
    expect(bridge.refresh).toHaveBeenCalledTimes(1);
    await advance(3_000);
    expect(bridge.refresh).toHaveBeenCalledTimes(2);
    bridge.refresh.mockResolvedValue(paid("max"));
    await advance(3_000);
    expect(host.textContent).toBe("");
    await advance(30_000);
    expect(bridge.refresh).toHaveBeenCalledTimes(3);
  });

  it("stops after three minutes and says it is slow", async () => {
    vi.useFakeTimers();
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome: "pending", state: paid("pro") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    await advance(3 * 60_000);
    const calls = bridge.refresh.mock.calls.length;
    expect(host.textContent).toContain("Your payment is taking longer than usual.");
    await advance(30_000);
    expect(bridge.refresh).toHaveBeenCalledTimes(calls);
  });

  it("stops polling when it unmounts", async () => {
    vi.useFakeTimers();
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome: "pending", state: paid("pro") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    await act(async () => root.unmount());
    root = createRoot(host);
    await advance(10_000);
    expect(bridge.refresh).not.toHaveBeenCalled();
  });

  it("a plan that can't change now points to the Plan page", async () => {
    await mount(paid("pro"), { upgrade: vi.fn(async () => ({ outcome: "unavailable", state: paid("pro") })) });
    await act(async () => button("Get Max")!.click());
    await settle();
    expect(host.textContent).toContain("Your plan can't be changed right now");
    await act(async () => button("Manage plan")!.click());
    expect(bridge.openDashboard).toHaveBeenCalledOnce();
  });

  it.each([["a plan needing attention", attention], ["a new sign-in", reauth]])("%s opens Settings → MausBot Cloud", async (_name, account) => {
    await mount(account);
    await act(async () => button("Get Max")!.click());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "cloudAccount" });
    expect(bridge.checkout).not.toHaveBeenCalled();
    expect(bridge.upgrade).not.toHaveBeenCalled();
  });
});
