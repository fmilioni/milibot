# shellcheck shell=bash
BUILD_INFO="$SRC_DIR/build-info.json"
[ -f "$BUILD_INFO" ] || echo '{}' > "$BUILD_INFO"
ver() { "$@" 2>/dev/null | head -n1 || true; }
pkgver() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true; }
jq -n \
  --slurpfile build "$BUILD_INFO" \
  --arg debian "$(cat /etc/debian_version)" \
  --arg kernel "$(pkgver "linux-image-cloud-$ARCH")" \
  --arg browser "$BROWSER" \
  --arg browserVersion "$(ver "$BROWSER" --version)" \
  --arg node "$(ver node -v)" \
  --arg npm "$(ver npm -v)" \
  --arg corepack "$(ver corepack --version)" \
  --arg go "$(ver /usr/local/go/bin/go version)" \
  --arg rustc "$(ver runuser -u agent -- env RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo /opt/rust/cargo/bin/rustc --version)" \
  --arg python "$(ver python3 --version)" \
  --arg uv "$(ver uv --version)" \
  --arg docker "$(ver docker --version)" \
  --arg compose "$(ver docker compose version)" \
  --arg buildx "$(ver docker buildx version)" \
  --arg gh "$(ver gh --version)" \
  --arg git "$(ver git --version)" \
  --arg claude "$(ver runuser -u agent -- /usr/local/lib/milibot/claude-real --version)" \
  --arg xfce "$(pkgver xfce4-session)" \
  --arg tigervnc "$(pkgver tigervnc-standalone-server)" \
  --arg pandoc "$(pkgver pandoc)" \
  --arg poppler "$(pkgver poppler-utils)" \
  --arg tesseract "$(pkgver tesseract-ocr)" \
  --arg guestAgent "$(sha256sum /opt/milibot/guest-agent/guest-agent.mjs | cut -c1-16)" \
  '($build[0] // {}) + {
     debian: $debian,
     packages: {
       kernel: $kernel, browser: $browser, browserVersion: $browserVersion, node: $node, npm: $npm,
       corepack: $corepack, go: $go, rustc: $rustc, python: $python, uv: $uv, docker: $docker,
       compose: $compose, buildx: $buildx, gh: $gh, git: $git, claude: $claude, xfce: $xfce,
       tigervnc: $tigervnc, pandoc: $pandoc, poppler: $poppler, tesseract: $tesseract,
       guestAgentSha: $guestAgent
     }
   }' > /etc/milibot/manifest.json
chmod 644 /etc/milibot/manifest.json
cat /etc/milibot/manifest.json
