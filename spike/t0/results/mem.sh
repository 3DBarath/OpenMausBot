set +e
BW="bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp --bind /root/box /box"
echo "== bwrap monitor RSS =="
$BW sleep 15 & sleep 1
ps -o pid,rss,comm -C bwrap 2>/dev/null
echo "bwrap_total_rss_kb=$(ps --no-headers -o rss -C bwrap 2>/dev/null | awk '{s+=$1} END{print s}')"
wait 2>/dev/null
echo "== gvisor sentry RSS (one sandbox) =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do sleep 15 >/dev/null 2>&1 & sleep 3
ps -eo pid,rss,comm | grep -iE 'runsc|sentry' | grep -v grep
echo "gvisor_rss_kb=$(ps --no-headers -eo rss,comm | grep -iE 'runsc' | awk '{s+=$1} END{print s}')"
wait 2>/dev/null
echo "== compat: versions under bwrap =="
$BW /usr/bin/git --version 2>&1 | head -1
$BW /usr/local/bin/claude --version 2>&1 | head -1
$BW /usr/local/bin/codex --version 2>&1 | head -1
$BW /usr/bin/python3 --version 2>&1 | head -1
echo "== compat: git init+commit in /box under bwrap =="
$BW sh -c 'cd /box && rm -rf r && mkdir r && cd r && git init -q && git -c user.email=a@b.c -c user.name=x commit --allow-empty -qm hi && git log --oneline | head -1 && echo GIT_OK' 2>&1 | tail -3
