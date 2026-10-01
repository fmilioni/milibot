# shellcheck shell=bash
retry apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh nodejs
install -d /etc/docker
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "3" },
  "features": { "buildkit": true }
}
JSON
systemctl enable docker.service containerd.service >/dev/null 2>&1

if command -v corepack >/dev/null 2>&1; then
  corepack enable
else
  npm install -g corepack && corepack enable
fi
