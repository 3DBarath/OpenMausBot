# T0 spike raw results, part 4 — separate-user fallback + gVisor, real Fly machine

## Separate Linux user per bot (+ hidepid /proc + nftables owner-match)
File isolation (data dir 0700 maus; each workspace 0700 its bot-user; world-traversable parents 0755):
- messages.db: denied | config/keys: denied | data dir list: denied | other bot's workspace: denied | own workspace: rw ok.
Processes:
- /proc/<pid>/environ is already unreadable across uids by default (so another turn's ENV is safe even before hidepid).
- Process *visibility* (pid, cmdline) leaks by default: bot1 could `stat` another turn's pid. After
  `mount -o remount,hidepid=invisible /proc`, the other turn's pid is hidden and its environ unreadable. => hidepid REQUIRED.
- Cross-uid ptrace needs CAP_SYS_PTRACE, so a distinct uid per bot stops one turn ptracing another (same-uid is the risk bwrap/gVisor also remove).
Network — THE WEAKNESS:
- No network namespace, so by default bot1 reached the server's loopback (curl 127.0.0.1:8799 -> 501, i.e. the server answered).
- Fix: nftables owner-match. `add rule inet t0 out meta skuid bot1 ip daddr 127.0.0.1 tcp dport 8799 reject` -> bot1 now gets
  curl code 000 (blocked). So egress control for the separate-user box must be per-uid nftables (allow only broker+egress ports);
  there is no mount-based or namespace cutoff like bwrap/gVisor give for free.

## gVisor runsc (systrap, no KVM)
- echo / node v24.22.0 / python3 run inside `runsc do`. It supplies its own kernel, so the host kernel's missing Landlock and
  its syscall surface stop mattering (strongest isolation). Cost: ~60 MB RSS per sandbox (runsc 25.7 + sentry 33.8) and ~2x
  process/syscall startup (node 140 ms in-sandbox-create vs 31 ms native). cgroup v1 on Fly needs --ignore-cgroups for `do`.
  Not exercised here: headless Chrome under gVisor (heavy; gVisor's GPU/graphics path is limited) and per-turn container reuse.
