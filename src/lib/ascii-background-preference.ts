import { useSyncExternalStore } from "react";

export const ASCII_BACKGROUND_KEY = "omb-ascii-background";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readAsciiBackground(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(ASCII_BACKGROUND_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== ASCII_BACKGROUND_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setAsciiBackground(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(ASCII_BACKGROUND_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
}

export function useAsciiBackground(): boolean {
  return useSyncExternalStore(subscribe, readAsciiBackground, readAsciiBackground);
}
