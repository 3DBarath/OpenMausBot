# T0 spike raw results, part 2 — bubblewrap box end-to-end (as unprivileged `maus`, real Fly machine)

Orchestrator spike/t0/t0-e2e.mjs: fixtures + fake upstream + broker (unix socket) + egress gate (unix socket) + a canary
process holding the secret in its env; then probe-inbox.mjs runs INSIDE a bwrap box granted only one bot workspace +
one person folder + its HOME, with the broker and egress bridged in on loopback (box.mjs/box-init.mjs).

allPass: TRUE. hostEgressToPublic: 200 (gate reaches the internet). boxEgressToPublic: 200.

Isolation matrix (bubblewrap), each PASS = the hostile attempt failed / the legitimate one worked:
- cannot read messages.db                 PASS (ENOENT — not bound into the box)
- cannot read config/keys                  PASS (ENOENT)
- cannot list the server data dir          PASS (ENOENT)
- cannot read another bot's workspace      PASS (ENOENT)
- cannot read another person's folder      PASS (ENOENT)
- cannot see Fly's /.fly api socket        PASS (ENOENT — /.fly not bound)
- no model key in the box env              PASS (only the per-turn t0_ token is present)
- no model key on disk it can see          PASS (0 hits scanning /run/t0, HOME, cwd)
- cannot see another turn's PID            PASS (own PID ns shows only 1,2,10; canary pid absent)
- cannot read another turn's env           PASS (/proc/<canary>/environ unreadable)
- own workspace is read-write              PASS
- person folder is read-write              PASS
- broker call with the turn token works    PASS (200, upstream got the REAL key, token never forwarded)
- broker refuses without a token           PASS (401)
- server's real loopback port unreachable  PASS (ECONNREFUSED — box net ns has only loopback + the two bridges)
- egress refuses private/loopback          PASS (403 to 127.0.0.1:<port>)
- egress allows public                     PASS (200 CONNECT example.com:443)
