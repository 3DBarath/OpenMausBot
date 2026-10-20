set +e
echo "== uname =="; uname -a
echo "== caps (root) =="; grep -E 'Cap(Prm|Eff|Bnd)' /proc/self/status
echo "== seccomp field =="; grep Seccomp /proc/self/status
echo "== lsm =="; cat /sys/kernel/security/lsm 2>/dev/null || echo "no securityfs"
echo "== userns sysctls =="
for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces /proc/sys/kernel/apparmor_restrict_unprivileged_userns /proc/sys/kernel/yama/ptrace_scope; do
  printf "%s = " "$f"; cat "$f" 2>/dev/null || echo "(absent)"
done
echo "== create userns as root (unshare -Ur) =="; unshare -Ur sh -c 'echo ok id=$(id -u)' 2>&1
echo "== create userns as nobody (maus) =="; su maus -s /bin/sh -c 'unshare -Ur sh -c "echo ok inner=$(id -u)"' 2>&1
echo "== pid1 =="; cat /proc/1/comm; ls -la /proc/1/root >/dev/null 2>&1 && echo "can see pid1 root" || echo "pid1 root hidden"
echo "== cgroup =="; cat /proc/self/cgroup | head -3; echo "controllers:"; cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null
echo "== /dev/kvm =="; ls -l /dev/kvm 2>&1
echo "== hidepid mount of /proc =="; mount 2>/dev/null | grep -E '/proc ' || cat /proc/mounts | grep -E ' /proc '
echo "== landlock abi (syscall 444) =="
python3 - <<'PY'
import ctypes,ctypes.util
libc=ctypes.CDLL(None,use_errno=True)
# landlock_create_ruleset(NULL,0,LANDLOCK_CREATE_RULESET_VERSION=1<<0)
r=libc.syscall(444,0,0,1)
import os
print("abi" , r, "errno", ctypes.get_errno() if r<0 else 0)
PY
echo "== pnpm/npm =="; which npm pnpm 2>&1; npm --version 2>&1 | head -1
echo "== setpriv present =="; which setpriv newuidmap newgidmap 2>&1
