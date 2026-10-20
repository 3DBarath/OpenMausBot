set +e
exec >/root/setup.log 2>&1
echo "SETUP START $(date -u)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && echo "apt update ok"
apt-get install -y -qq bubblewrap uidmap strace >/dev/null 2>&1 && echo "bwrap installed: $(bwrap --version)"
# gVisor runsc
ARCH=$(uname -m)
curl -fsSL "https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}/runsc" -o /usr/local/bin/runsc && chmod 0755 /usr/local/bin/runsc && echo "runsc: $(/usr/local/bin/runsc --version | head -1)"
# create two bot users for separate-user approach
useradd -m -s /bin/bash bot1 2>/dev/null; useradd -m -s /bin/bash bot2 2>/dev/null
echo "users: $(id bot1); $(id bot2)"
echo "SETUP DONE $(date -u)"
