# T0 spike raw results, part 1 (Fly app omb-test-t0-af48c4, machine 78111550c3e038, fra, shared-cpu-2x 2 GB)
Image: ghcr.io/milind-soni/openmausbot-cloud-home:latest @ sha256:2ff72e57415599daac0af75a736c6cada0056d56b7a699a599617e65e147eeec
(revision c192de3c2d4183f721a1c544f7fcd16ae719b899), entrypoint overridden to `sleep infinity`, run as root via the Machines exec API.

## Kernel facts (facts.sh)
- Linux 6.12.105-fly #1 SMP PREEMPT_DYNAMIC Fri Oct 16 2026 x86_64; Debian 12 bookworm userland.
- root in VM has full caps (CapEff 000001ffffffffff). Seccomp field 0 (no filter on the exec'd shell).
- securityfs not mounted (/sys/kernel/security/lsm absent).
- /proc/sys/kernel/unprivileged_userns_clone absent; /proc/sys/user/max_user_namespaces = 7754; no apparmor userns restriction; no yama.
- `unshare -Ur` as root: ok. As `maus` (uid 1001): ok (inner uid 1001 -> mapped). => UNPRIVILEGED USER NAMESPACES WORK.
- Landlock: syscall 444 (landlock_create_ruleset VERSION) -> -1 errno 38 ENOSYS. => LANDLOCK NOT BUILT INTO FLY'S KERNEL.
- /dev/kvm absent -> gVisor KVM platform impossible; systrap/ptrace only.
- cgroup v1 hierarchy (cpuset, perf_event, memory ...); no cgroup2 unified controllers file.
- /proc mounted rw,nosuid,nodev,noexec, no hidepid.
- npm 11.19.1 present; pnpm NOT in image. setpriv present; newuidmap/newgidmap absent (installed `uidmap` for tests).

## Installs (setup.sh)
- apt: bubblewrap 0.8.0 (Debian bookworm), uidmap, strace.
- gVisor runsc release-20261012.0 from gs://gvisor releases/release/latest/x86_64/gvisor.tar.bz2 (now a tarball: runsc + gvisor-bin/ sidecars; runsc needs gvisor-bin/ next to it; image has no bzip2, extracted with python tarfile).
- users bot1 (1002), bot2 (1003).

## gVisor
- `runsc --platform=systrap --network=none --ignore-cgroups do echo` -> works. node v24.22.0 and python3 run. ptrace platform also works.

## Startup overhead (bench.sh), per invocation, interleaved loops on the same machine
| what | per call |
|---|---|
| /bin/true direct | 0.69 ms |
| setpriv --reuid (separate user) true | 1.6 ms |
| bwrap (user+pid+ipc+uts ns, ro binds, tmpfs) true | 5.29 ms |
| node -e 0 direct | 31.6 ms |
| bwrap node -e 0 | 35.9 ms |
| runsc do (systrap) true — whole new sandbox | 76.2 ms |
| runsc do node -e 0 — whole new sandbox | 140 ms |

## Memory (mem.sh)
- bwrap: two monitor processes 1880 + 1228 KB = ~3.1 MB RSS per box.
- gVisor: runsc 25.7 MB + gvisor_sentry 33.8 MB (+ small helpers) = ~60 MB RSS per sandbox.
- separate user: no helper process.

## Compat under bwrap (mem.sh)
- git 2.39.5, Claude Code 2.1.305, codex-cli 0.163.0, Python 3.11.2 all start; git init+commit in a bound /box works.
