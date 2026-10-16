import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  snapshot: undefined as undefined | (() => boolean),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean) => {
    hook.snapshot = snapshot;
    return snapshot();
  },
}));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

let local: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("animated background", () => {
  it("is on until the person turns it off", async () => {
    const preference = await import("./ascii-background-preference");
    expect(preference.readAsciiBackground()).toBe(true);
    expect(preference.useAsciiBackground()).toBe(true);
    local.setItem(preference.ASCII_BACKGROUND_KEY, "0");
    expect(preference.readAsciiBackground()).toBe(false);
    local.setItem(preference.ASCII_BACKGROUND_KEY, "1");
    expect(preference.readAsciiBackground()).toBe(true);
  });

  it("stays on when this device's storage cannot be read", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => {} });
    const preference = await import("./ascii-background-preference");
    expect(preference.readAsciiBackground()).toBe(true);
  });

  it("remembers the choice on this device", async () => {
    let preference = await import("./ascii-background-preference");
    preference.setAsciiBackground(false);
    expect(local.getItem(preference.ASCII_BACKGROUND_KEY)).toBe("0");
    vi.resetModules();
    preference = await import("./ascii-background-preference");
    expect(preference.readAsciiBackground()).toBe(false);
    preference.setAsciiBackground(true);
    expect(local.getItem(preference.ASCII_BACKGROUND_KEY)).toBe("1");
    expect(preference.readAsciiBackground()).toBe(true);
  });
});
