# shellcheck shell=bash
cat > /etc/profile.d/milibot.sh <<'PROFILE'
umask 002
export RUSTUP_HOME=/opt/rust/rustup
export CARGO_HOME=/opt/rust/cargo
export DISABLE_AUTOUPDATER=1
case ":$PATH:" in *":/usr/local/go/bin:"*) ;; *) PATH="$PATH:/usr/local/go/bin:/opt/rust/cargo/bin" ;; esac
[ -d "$HOME/go/bin" ] && case ":$PATH:" in *":$HOME/go/bin:"*) ;; *) PATH="$PATH:$HOME/go/bin" ;; esac
export PATH
PROFILE
cat > /etc/environment <<'ENVIRONMENT'
LANG=C.UTF-8
RUSTUP_HOME=/opt/rust/rustup
CARGO_HOME=/opt/rust/cargo
DISABLE_AUTOUPDATER=1
ENVIRONMENT
# Non-login bash shells (xfce4-terminal) also need the toolchain paths.
grep -q '/etc/profile.d/milibot.sh' /etc/bash.bashrc || echo '[ -r /etc/profile.d/milibot.sh ] && . /etc/profile.d/milibot.sh' >> /etc/bash.bashrc
sed -i 's/^UMASK.*/UMASK\t\t002/' /etc/login.defs
ln -sf /usr/bin/fdfind /usr/local/bin/fd
echo '%workspace ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/milibot
chmod 0440 /etc/sudoers.d/milibot
cat > /etc/sysctl.d/90-milibot.conf <<'SYSCTL'
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=1024
SYSCTL
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true
rm -f /etc/xdg/autostart/{xscreensaver,light-locker,xfce4-screensaver,xfce4-power-manager,blueman,nm-applet,print-applet,xiccd}.desktop
install -d -m 2775 -o root -g workspace /workspace
install -d -m 1777 /tmp/.X11-unix
