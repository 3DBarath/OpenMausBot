set +e
cd /root
python3 -c "import tarfile; tarfile.open('gvisor.tar.bz2','r:bz2').extractall('/root/gv')" && echo "extracted: $(ls /root/gv)"
install -m0755 /root/gv/runsc /usr/local/bin/runsc && echo "installed"
echo "version: $(/usr/local/bin/runsc --version 2>&1 | head -1)"
echo "== runsc do systrap echo =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups --host-uds=none do echo hello-from-gvisor 2>&1 | tail -8
echo "exit=${PIPESTATUS:-$?}"
echo "== runsc do systrap node =="
/usr/local/bin/runsc --platform=systrap --network=none --ignore-cgroups do /usr/local/bin/node -e 'console.log("node-in-gvisor",process.version)' 2>&1 | tail -8
