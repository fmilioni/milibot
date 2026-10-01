# shellcheck shell=bash
# shellcheck source=/dev/null
CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
add_repo docker https://download.docker.com/linux/debian/gpg \
  "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $CODENAME stable"
add_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  "deb [arch=$ARCH signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main"
add_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  "deb [arch=$ARCH signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main"
CHROME_PACKAGES=$(curl -fsSL "https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-$ARCH/Packages" 2>/dev/null || true)
if grep -q '^Package: google-chrome-stable$' <<<"$CHROME_PACKAGES"; then
  add_repo google-chrome https://dl.google.com/linux/linux_signing_key.pub \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main"
fi
cat > /etc/apt/preferences.d/nodesource <<'PREF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
PREF
retry apt_get update
