// First process inside a T0 box: opens the loopback bridges named in T0_BRIDGES (127.0.0.1:<port> -> a unix socket
// bound in from outside), then runs the real command and exits with its code. Its own environment never carries a
// credential; the command gets the same environment minus T0_BRIDGES.
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";

const bridges = JSON.parse(process.env.T0_BRIDGES ?? "[]");
await Promise.all(bridges.map(({ port, socket }) => new Promise((resolve, reject) => {
  const server = createServer((client) => {
    const upstream = connect(socket);
    client.pipe(upstream); upstream.pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close); upstream.on("error", close);
  });
  server.on("error", reject);
  server.listen(port, "127.0.0.1", () => { server.unref(); resolve(); });
})));
const env = { ...process.env };
delete env.T0_BRIDGES;
const [command, ...args] = process.argv.slice(2);
const child = spawn(command, args, { stdio: "inherit", env });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(`box-init: ${error.message}`); process.exit(127); });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
