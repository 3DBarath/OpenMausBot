set +e
cd /root
curl -fsSL -o gvisor.tar.bz2 https://storage.googleapis.com/gvisor/releases/release/latest/x86_64/gvisor.tar.bz2 && echo "downloaded $(ls -la gvisor.tar.bz2 | awk '{print $5}') bytes"
tar xjf gvisor.tar.bz2 && echo "extracted: $(ls)"
install -m0755 runsc /usr/local/bin/runsc 2>/dev/null || cp runsc /usr/local/bin/runsc
chmod +x /usr/local/bin/runsc
echo "version: $(/usr/local/bin/runsc --version 2>&1 | head -1)"
echo "== runsc do, systrap, no network =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do echo "hello-from-gvisor" 2>&1 | head -20
echo "exit=$?"
echo "== runsc do, systrap, node =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do /usr/local/bin/node -e 'console.log("node-in-gvisor", process.version)' 2>&1 | head -20
echo "exit=$?"
