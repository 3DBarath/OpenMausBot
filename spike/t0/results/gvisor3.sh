set +e
cp -r /root/gv/gvisor-bin /usr/local/bin/gvisor-bin && echo "sidecar placed: $(ls /usr/local/bin/gvisor-bin | tr '\n' ' ')"
echo "== runsc do systrap echo =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups --host-uds=none do echo hello-from-gvisor 2>&1 | tail -8
echo "== runsc do systrap node =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do /usr/local/bin/node -e 'console.log("node-in-gvisor",process.version)' 2>&1 | tail -8
echo "== runsc do systrap python =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do /usr/bin/python3 -c 'print("py-in-gvisor")' 2>&1 | tail -5
echo "== ptrace platform fallback echo =="
/usr/local/bin/runsc --platform=ptrace --network=none --ignore-cgroups do echo hello-ptrace 2>&1 | tail -5
