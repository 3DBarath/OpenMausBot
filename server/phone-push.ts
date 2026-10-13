// Closed-app phone alerts (APNs through the hosted relay), harness side.
//
// The live `notify` frame reaches a phone only while its app holds the event
// stream; iOS suspends a backgrounded app within seconds and then nothing
// arrives. This sends the same alert as an APNs push instead, through the
// relay in the hosted control plane, which holds the project's APNs key.
// The harness authenticates with the installation credential it already has
// for the hosted transport, so it needs nothing but outbound HTTPS: a Mac, a
// VPS or a container work alike. The wire contract is shared/phone-push.ts.
//
// What it decides, in order, for each notification and each registered phone:
//   - nothing at all unless the relay is reachable with a credential and the
//     workspace's `features.phonePush` is on (the default);
//   - nothing for a phone that opted out, or that may not see the bot or
//     room (the same audience rule as its event stream);
//   - nothing while that phone holds a live event stream: its app is in the
//     foreground (or its short background grace) and shows the frame itself;
//   - at most one push per kind and conversation every 10 s, and 30 per
//     phone every 10 minutes, so a looping bot cannot buzz a pocket forever.
// The per-bot `notifications` switch already decided whether there is a
// notification at all (buildNotification returns null when it is off).
//
// A phone's registration is keyed by who vouched for it: `companion:<id>`
// for a phone paired through the desktop's companion sidecar, `session:<id>`
// for one paired with the server directly. Revoking either drops it, here
// and at the relay.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { COMPANION_INSTALLATION_CREDENTIAL_FIELD } from "../electron/companion-account-service.mjs";
import { normalizeControlPlaneURL } from "../electron/control-plane-client.mjs";
import {
  APNS_TOKEN,
  PAIRING_TAG,
  PHONE_PUSH_RELAY_PATHS,
  PHONE_PUSH_WIRE_VERSION,
  PUSH_RELAY_ERRORS,
  phonePushNotification,
  type ApnsEnvironment,
  type PhonePushDeviceRegistration,
  type PhonePushNotification,
} from "../shared/phone-push.ts";
import type { Notification } from "../shared/notification.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Where and as whom the harness talks to the relay. */
export interface PhonePushAccess {
  /** The control plane's origin, e.g. https://accounts.openmausbot.com */
  controlPlane: string;
  /** `omb_install_…`: the installation credential of this harness. */
  credential: string;
}

export const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
/** Companion device ids and session ids, as their registries mint them. */
export const PUSH_DEVICE_KEY = /^(companion|session):[\w-]{1,128}$/;

export const PUSH_COALESCE_MS = 10_000;
export const PUSH_DEVICE_WINDOW_MS = 10 * 60_000;
export const PUSH_DEVICE_WINDOW_MAX = 30;
/** How long the relay is left alone after it said it cannot push at all. */
export const RELAY_UNAVAILABLE_PAUSE_MS = 60 * 60_000;
/** ...and after a transient failure (5xx, network). */
export const RELAY_FAILURE_PAUSE_MS = 60_000;
const RELAY_TIMEOUT_MS = 10_000;
/** Bounds the file; the companion allows 20 phones, sessions are similar. */
export const MAX_PUSH_DEVICES = 50;

const storedDevice = z.object({
  key: z.string().regex(PUSH_DEVICE_KEY),
  token: z.string().regex(APNS_TOKEN),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  enabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const storedFile = z.object({ version: z.literal(1), devices: z.array(storedDevice) });
type StoredDevice = z.infer<typeof storedDevice>;

/** A registration as the phone may read it back: never another phone's. */
export interface PublicPushDevice {
  environment: ApnsEnvironment;
  enabled: boolean;
  pairing?: string;
  updatedAt: number;
}

export const registrationSchema = z.object({
  token: z.string().trim().toLowerCase().regex(APNS_TOKEN),
  environment: z.enum(["production", "sandbox"]),
  pairing: z.string().regex(PAIRING_TAG).optional(),
  enabled: z.boolean().optional(),
}).strict();

export type PushOutcome =
  | "sent"
  | "off"
  | "opted-out"
  | "not-visible"
  | "live"
  | "coalesced"
  | "rate-limited"
  | "paused"
  | "dropped"
  | "failed";

export interface PhonePushOptions {
  /** push-devices.json in the data dir */
  file: string;
  /** The relay and credential, or null when this harness has no control-plane account. */
  access: () => PhonePushAccess | null;
  /** The workspace's global switch (features.phonePush). */
  enabled: () => boolean;
  /** Whether this phone holds a live event stream right now. */
  live: (key: string) => boolean;
  /** Whether this phone may see this notification (bot visibility, admin-only frames). */
  audience: (key: string, notification: Notification, adminOnly: boolean) => boolean;
  /** The room a notification came out of, for its name. */
  room: (notification: Notification) => { id: string; name: string } | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface RelayAnswer {
  status: number;
  code?: string;
  retryAfterMs?: number;
}

export class PhonePush {
  private devices: StoredDevice[] = [];
  private readonly options: PhonePushOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (line: string) => void;
  /** key → recent send times, for the per-phone window */
  private readonly sent = new Map<string, number[]>();
  /** `${key}|${kind}|${threadId}` → last send */
  private readonly lastByThread = new Map<string, number>();
  private pausedUntil = 0;

  constructor(options: PhonePushOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? ((line) => console.log(line));
    this.load();
  }

  private load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.options.file, "utf8"));
    } catch {
      return; // none yet, or unreadable: a phone registers again when it next opens
    }
    const parsed = storedFile.safeParse(raw);
    if (parsed.success) this.devices = parsed.data.devices;
  }

  private persist(): void {
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
  }

  device(key: string): PublicPushDevice | null {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return null;
    return {
      environment: device.environment,
      enabled: device.enabled,
      ...(device.pairing ? { pairing: device.pairing } : {}),
      updatedAt: device.updatedAt,
    };
  }

  /** Whether pushes can leave this harness at all right now. */
  status(): "on" | "off" | "no-account" {
    if (!this.options.enabled()) return "off";
    return this.options.access() ? "on" : "no-account";
  }

  /** The phone behind `key` registers (or updates) its token. A token
   * belongs to one app on one phone, so a newer registration of the same
   * token under another key (a phone that paired again) replaces the old
   * one rather than buzzing the phone twice. The relay registration is
   * attempted at once; a failure there is retried on the next send. */
  async register(key: string, input: PhonePushDeviceRegistration): Promise<{ device: PublicPushDevice; relay: "registered" | "pending" | "off" }> {
    if (!PUSH_DEVICE_KEY.test(key)) throw new Error("not a phone");
    const now = this.now();
    const previous = this.devices.find((device) => device.key === key);
    const others = this.devices.filter((device) => device.key !== key && device.token !== input.token);
    if (!previous && others.length >= MAX_PUSH_DEVICES) {
      throw Object.assign(new Error(`At most ${MAX_PUSH_DEVICES} phones can receive alerts from this computer.`), { status: 409 });
    }
    const next: StoredDevice = {
      key,
      token: input.token,
      environment: input.environment,
      ...(input.pairing ? { pairing: input.pairing } : {}),
      enabled: input.enabled ?? previous?.enabled ?? true,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.devices = [...others, next];
    this.persist();
    if (previous && previous.token !== next.token && !this.tokenInUse(previous.token)) {
      void this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, token: previous.token });
    }
    if (this.status() !== "on") return { device: this.device(key)!, relay: "off" };
    const answer = await this.relay(PHONE_PUSH_RELAY_PATHS.register, {
      v: PHONE_PUSH_WIRE_VERSION,
      token: next.token,
      environment: next.environment,
    });
    return { device: this.device(key)!, relay: answer && answer.status < 300 ? "registered" : "pending" };
  }

  /** The phone asked to stop: drop its registration here and at the relay. */
  async remove(key: string): Promise<boolean> {
    const device = this.devices.find((candidate) => candidate.key === key);
    if (!device) return false;
    this.devices = this.devices.filter((candidate) => candidate.key !== key);
    this.persist();
    if (!this.tokenInUse(device.token)) {
      await this.relay(PHONE_PUSH_RELAY_PATHS.unregister, { v: PHONE_PUSH_WIRE_VERSION, token: device.token });
    }
    return true;
  }

  /** A paired phone was revoked (or its session expired): forget it. */
  forget(key: string): void {
    void this.remove(key).catch((error) => this.log(`[phone-push] could not forget a phone: ${error instanceof Error ? error.message : String(error)}`));
  }

  private tokenInUse(token: string): boolean {
    return this.devices.some((device) => device.token === token);
  }

  /** Send one notification to every phone that should get it. Resolves when
   * every relay call has settled; never rejects. */
  async dispatch(notification: Notification, options: { adminOnly?: boolean } = {}): Promise<Array<{ key: string; outcome: PushOutcome }>> {
    try {
      if (!this.devices.length) return [];
      if (this.status() !== "on") return this.devices.map((device) => ({ key: device.key, outcome: "off" as const }));
      const push = phonePushNotification(notification, this.options.room(notification));
      if (!push) return [];
      const now = this.now();
      return await Promise.all(this.devices.map(async (device) => {
        let outcome: PushOutcome;
        try {
          outcome = await this.deliver(device, push, notification, options.adminOnly === true, now);
        } catch (error) {
          this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
          outcome = "failed";
        }
        return { key: device.key, outcome };
      }));
    } catch (error) {
      // a push is never worth an unhandled rejection in the harness
      this.log(`[phone-push] could not push: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** The decisions for one phone, in order, then the send. */
  private async deliver(device: StoredDevice, push: PhonePushNotification, notification: Notification, adminOnly: boolean, now: number): Promise<PushOutcome> {
    if (!device.enabled) return "opted-out";
    if (!this.options.audience(device.key, notification, adminOnly)) return "not-visible";
    if (this.options.live(device.key)) return "live";
    if (now < this.pausedUntil) return "paused";
    const threadKey = `${device.key}|${push.kind}|${push.threadId}`;
    if (now - (this.lastByThread.get(threadKey) ?? -Infinity) < PUSH_COALESCE_MS) return "coalesced";
    const recent = (this.sent.get(device.key) ?? []).filter((at) => now - at < PUSH_DEVICE_WINDOW_MS);
    if (recent.length >= PUSH_DEVICE_WINDOW_MAX) return "rate-limited";
    this.sent.set(device.key, [...recent, now]);
    this.lastByThread.set(threadKey, now);
    if (this.lastByThread.size > 2_000) this.lastByThread.clear();
    return this.send(device, push);
  }

  private async send(device: StoredDevice, notification: PhonePushNotification): Promise<PushOutcome> {
    const body = {
      v: PHONE_PUSH_WIRE_VERSION,
      token: device.token,
      ...(device.pairing ? { pairing: device.pairing } : {}),
      notification,
    };
    let answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    if (answer?.status === 404 && answer.code === PUSH_RELAY_ERRORS.unknownDevice) {
      // The relay lost or never had this registration (registered while it
      // was unreachable, or before it existed): register, then retry once.
      const registered = await this.relay(PHONE_PUSH_RELAY_PATHS.register, {
        v: PHONE_PUSH_WIRE_VERSION,
        token: device.token,
        environment: device.environment,
      });
      if (registered && registered.status < 300) answer = await this.relay(PHONE_PUSH_RELAY_PATHS.send, body);
    }
    if (!answer) return this.pause(RELAY_FAILURE_PAUSE_MS, "failed");
    if (answer.status < 300) return "sent";
    if (answer.status === 410 || answer.code === PUSH_RELAY_ERRORS.unregistered) {
      // APNs says the token is dead (the app was deleted, or it was never
      // valid for this build). The relay dropped it already.
      this.devices = this.devices.filter((candidate) => candidate.token !== device.token);
      this.persist();
      return "dropped";
    }
    if (answer.code === PUSH_RELAY_ERRORS.unavailable) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS, "failed");
    if (answer.status === 429) return this.pause(answer.retryAfterMs ?? RELAY_FAILURE_PAUSE_MS, "rate-limited");
    if (answer.status === 401) return this.pause(RELAY_UNAVAILABLE_PAUSE_MS, "failed");
    if (answer.status >= 500) return this.pause(RELAY_FAILURE_PAUSE_MS, "failed");
    return "failed";
  }

  private pause(ms: number, outcome: PushOutcome): PushOutcome {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + Math.min(Math.max(ms, 1_000), 6 * 60 * 60_000));
    return outcome;
  }

  /** One POST to the relay. Null when it could not be reached at all. The
   * credential travels only in the Authorization header, to the control
   * plane's own origin, and is never logged. */
  private async relay(path: string, body: unknown): Promise<RelayAnswer | null> {
    const access = this.options.access();
    if (!access) return null;
    try {
      const response = await this.fetchImpl(`${access.controlPlane}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${access.credential}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const retryAfter = Number(response.headers.get("retry-after"));
      return {
        status: response.status,
        ...(typeof payload?.error === "string" ? { code: payload.error } : {}),
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1_000 } : {}),
      };
    } catch (error) {
      this.log(`[phone-push] the relay could not be reached: ${error instanceof Error ? error.name : "error"}`);
      return null;
    }
  }
}

// ── where the credential comes from ──────────────────────────────────────

export const PHONE_PUSH_DESKTOP_MESSAGE = "openmausbot:phone-push-relay";

/** A validated access pair, or null. */
export function phonePushAccess(controlPlane: unknown, credential: unknown): PhonePushAccess | null {
  const origin = typeof controlPlane === "string" ? normalizeControlPlaneURL(controlPlane) : "";
  if (!origin || typeof credential !== "string" || !INSTALLATION_CREDENTIAL.test(credential)) return null;
  return { controlPlane: origin, credential };
}

/** The harness's control-plane access, from whichever of three places this
 * kind of harness keeps it:
 *   - the desktop app hands it over its private parent port (it lives in
 *     the OS-encrypted credential store, which this process cannot read);
 *   - `openmausbot serve --tunnel` keeps it in tunnel-account.json;
 *   - a fleet container carries it in OMB_INSTALLATION_CREDENTIAL.
 * OMB_CONTROL_PLANE_URL overrides the control plane, as it does for the
 * tunnel. No credential anywhere: phone push is a silent no-op. */
export class PhonePushAccessSource {
  private desktop: PhonePushAccess | null | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tunnelFile: string;
  private readonly defaultControlPlane: string;

  constructor(options: { env?: NodeJS.ProcessEnv; tunnelFile: string; defaultControlPlane: string }) {
    this.env = options.env ?? process.env;
    this.tunnelFile = options.tunnelFile;
    this.defaultControlPlane = options.defaultControlPlane;
  }

  /** The desktop app's private message: true when it was one. */
  receive(message: unknown): boolean {
    if (!message || typeof message !== "object" || (message as { type?: unknown }).type !== PHONE_PUSH_DESKTOP_MESSAGE) return false;
    const access = (message as { access?: unknown }).access;
    this.desktop = access && typeof access === "object"
      ? phonePushAccess((access as { controlPlane?: unknown }).controlPlane, (access as { credential?: unknown }).credential)
      : null;
    return true;
  }

  private controlPlane(): string {
    if (Object.hasOwn(this.env, "OMB_CONTROL_PLANE_URL")) return normalizeControlPlaneURL(this.env.OMB_CONTROL_PLANE_URL ?? "");
    return this.defaultControlPlane;
  }

  current(): PhonePushAccess | null {
    // The desktop app is authoritative once it has spoken, including "none".
    if (this.desktop !== undefined) return this.desktop;
    const fleet = this.env.OMB_INSTALLATION_CREDENTIAL?.trim();
    if (fleet) return phonePushAccess(this.controlPlane(), fleet);
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(this.tunnelFile, "utf8"));
    } catch {
      return null;
    }
    const credential = document && typeof document === "object" ? (document as Record<string, unknown>)[COMPANION_INSTALLATION_CREDENTIAL_FIELD] : undefined;
    return phonePushAccess(this.controlPlane(), credential);
  }
}
