// Closed-app phone alerts need the harness to reach the push relay in the
// hosted control plane as this installation (server/phone-push.ts). On the
// desktop the installation credential lives in the OS-encrypted credential
// store, which only this main process reads, so main hands the server the
// relay's origin and that credential over the utility process's private
// parent port: on every server start and whenever the stored document
// changes (sign-in, rotation, sign-out). Nothing else of the account crosses.
// Without a hosted sign-in the message says `access: null` and phone push
// stays off.
import {
  COMPANION_INSTALLATION_CREDENTIAL_FIELD,
  companionAccountCleanupPending,
} from "./companion-account-service.mjs";

export const PHONE_PUSH_RELAY_MESSAGE = "openmausbot:phone-push-relay";
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

/** The message for the server, from the credential document and the
 * control plane's origin ("" when hosted access is off in this build). */
export function phonePushRelayMessage(credentials, controlPlane) {
  const credential = credentials?.[COMPANION_INSTALLATION_CREDENTIAL_FIELD];
  const usable = typeof controlPlane === "string" && controlPlane !== ""
    && typeof credential === "string" && INSTALLATION_CREDENTIAL.test(credential)
    && !companionAccountCleanupPending(credentials);
  return { type: PHONE_PUSH_RELAY_MESSAGE, access: usable ? { controlPlane, credential } : null };
}

/** Sends the message when it differs from the last one the current server
 * got. `post` returns false when there is no server to send to. */
export function createPhonePushRelaySync() {
  let last = "";
  return {
    sync(message, post) {
      const serialized = JSON.stringify(message);
      if (serialized === last) return false;
      if (!post(message)) return false;
      last = serialized;
      return true;
    },
    /** A new server child knows nothing yet. */
    reset() {
      last = "";
    },
  };
}

/** What main runs: `sync()` after the credential document may have changed,
 * `serverStarted()` once a new server child is ready. The getters are read
 * at each call, since main reassigns the credentials and the server child. */
export function createPhonePushRelay({ controlPlane, credentials, server, log }) {
  const relaySync = createPhonePushRelaySync();
  const sync = () => relaySync.sync(phonePushRelayMessage(credentials(), controlPlane()), (message) => {
    const proc = server();
    if (!proc) return false;
    try {
      proc.postMessage(message);
      return true;
    } catch (error) {
      log(`phone push relay sync failed: ${error?.message ?? error}`);
      return false;
    }
  });
  return {
    sync,
    serverStarted() {
      relaySync.reset();
      sync();
    },
  };
}
