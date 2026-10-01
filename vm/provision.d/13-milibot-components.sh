# shellcheck shell=bash
install -d /opt/milibot/bin /opt/milibot/guest-agent /opt/milibot/desktop /etc/milibot /etc/milibot/bots /usr/share/milibot
install -m 0755 "$SRC_DIR"/guest/bin/milibot-data-setup "$SRC_DIR"/guest/bin/milibot-bot \
  "$SRC_DIR"/guest/bin/milibot-desktop-session /opt/milibot/bin/
install -m 0755 "$SRC_DIR"/guest/bin/milibot-browser /usr/local/bin/milibot-browser
install -m 0755 "$SRC_DIR"/guest/bin/gh /usr/local/bin/gh
rm -rf /opt/milibot/desktop
cp -r "$SRC_DIR"/guest/desktop /opt/milibot/desktop
install -m 0644 "$SRC_DIR"/guest-agent.mjs /opt/milibot/guest-agent/guest-agent.mjs
install -m 0644 "$SRC_DIR"/guest/systemd/*.service /etc/systemd/system/
ln -sf /opt/milibot/bin/milibot-bot /usr/local/sbin/milibot-bot
chmod 755 /etc/milibot
chmod 755 /etc/milibot/bots
systemctl daemon-reload
systemctl enable milibot-data.service milibot-guest-agent.service >/dev/null 2>&1

IM=$(command -v magick || command -v convert)
"$IM" -size 1280x800 radial-gradient:'#252b38'-'#0c0e13' -depth 8 /usr/share/milibot/wallpaper.png
