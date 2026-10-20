set +e
BW="bwrap --unshare-user --unshare-pid --unshare-ipc --unshare-uts --die-with-parent --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --ro-bind /sbin /sbin --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp --bind /root/box /box"
mkdir -p /root/box
t() { python3 -c "import time;print(round((time.time()-$1)*1000))"; }
echo "== baseline true x200 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 200); do /bin/true; done; echo "total_ms=$(t $S) -> per=$(python3 -c "print(round($(t $S)/200,2))")"
echo "== setpriv(reuid) true x200 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 200); do setpriv --reuid 1002 --regid 1002 --clear-groups /bin/true; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/200,2))")"
echo "== bwrap true x200 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 200); do $BW /bin/true; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/200,2))")"
echo "== baseline node x30 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 30); do /usr/local/bin/node -e 0; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/30,1))")"
echo "== bwrap node x30 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 30); do $BW /usr/local/bin/node -e 0; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/30,1))")"
echo "== gvisor do echo x10 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 10); do /usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups --host-uds=none do /bin/true >/dev/null 2>&1; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/10,1))")"
echo "== gvisor do node x5 =="; S=$(python3 -c 'import time;print(time.time())'); for i in $(seq 5); do /usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do /usr/local/bin/node -e 0 >/dev/null 2>&1; done; echo "total_ms=$(t $S) per=$(python3 -c "print(round($(t $S)/5,1))")"
