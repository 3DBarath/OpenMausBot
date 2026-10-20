// T0 bot box (spike): the argv that runs one engine process, and everything it starts, inside bubblewrap.
// Unprivileged: the server (user `maus`) runs it directly, because Fly's kernel allows unprivileged user namespaces.
//
// What the box sees:
//   - the image's code read-only (/usr, /bin, /lib*, /etc, /opt, /app);
//   - its own folders read-write at their real paths: the bot workspace, the asking person's folder, its HOME;
//   - this turn's private files (MCP config, system prompt) read-only, and its permission socket;
//   - a private /tmp, /dev/shm and /proc (its own PID namespace: no other turn's processes exist for it);
//   - a network namespace with loopback only. box-init.mjs bridges two loopback ports to unix sockets bound in from
//     outside: the credential broker and the egress gate. Nothing else on the server's loopback is reachable.
// What it never sees: the server's data dir (messages.db, config.json, logins), other bots' and people's folders,
// other turns' processes, environment or sockets, Fly's /.fly/api socket.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const BOX_INIT = join(HERE, "box-init.mjs");
export const BROKER_PORT = 18080;
export const EGRESS_PORT = 3128;

/**
 * @param {object} spec
 * @param {string} spec.workspace   bot workspace (rw)
 * @param {string} [spec.person]    asking person's folder (rw)
 * @param {string} spec.home        HOME for the engine CLI (rw)
 * @param {string[]} [spec.readOnly] extra read-only paths (turn files)
 * @param {string[]} [spec.writable] extra read-write paths (permission socket dir)
 * @param {{broker: string, egress: string}} spec.sockets  host unix sockets
 * @param {Record<string,string>} spec.env  the engine's whole environment (nothing is inherited)
 * @param {boolean} [spec.nestedUserns=true] false adds --disable-userns (Chrome then needs --no-sandbox)
 * @param {string[]} command
 */
export function bwrapArgs(spec, command) {
  const args = ["--unshare-user", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--die-with-parent", "--new-session", "--hostname", "box", "--clearenv"];
  // Mutation knobs (spike): dropping either must make an isolation check fail, proving it has teeth.
  if (!spec.noUnsharePid) args.unshift("--unshare-pid");
  if (!spec.noUnshareNet) args.push("--unshare-net");
  if (spec.nestedUserns === false) args.push("--disable-userns");
  for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/app"]) args.push("--ro-bind-try", path, path);
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm", "--tmpfs", "/run");
  for (const path of [spec.workspace, spec.person, spec.home, ...(spec.writable ?? [])]) if (path) args.push("--bind", path, path);
  for (const path of spec.readOnly ?? []) args.push("--ro-bind", path, path);
  args.push("--ro-bind", BOX_INIT, "/run/t0/box-init.mjs");
  args.push("--bind", spec.sockets.broker, "/run/t0/broker.sock", "--bind", spec.sockets.egress, "/run/t0/egress.sock");
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    HOME: spec.home,
    // Everything that honours a proxy goes through the egress gate; the broker is plain loopback.
    HTTPS_PROXY: `http://127.0.0.1:${EGRESS_PORT}`, HTTP_PROXY: `http://127.0.0.1:${EGRESS_PORT}`,
    https_proxy: `http://127.0.0.1:${EGRESS_PORT}`, http_proxy: `http://127.0.0.1:${EGRESS_PORT}`,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    // Node's own fetch honours the variables above only with this (Node 24).
    NODE_USE_ENV_PROXY: "1",
    T0_BRIDGES: JSON.stringify([{ port: BROKER_PORT, socket: "/run/t0/broker.sock" }, { port: EGRESS_PORT, socket: "/run/t0/egress.sock" }]),
    ...spec.env,
  };
  for (const [name, value] of Object.entries(env)) args.push("--setenv", name, String(value));
  args.push("--chdir", spec.workspace, "--", process.execPath, "/run/t0/box-init.mjs", ...command);
  return args;
}

export function spawnInBox(spec, command, options = {}) {
  return spawn("bwrap", bwrapArgs(spec, command), { stdio: options.stdio ?? ["pipe", "pipe", "pipe"], detached: true });
}
