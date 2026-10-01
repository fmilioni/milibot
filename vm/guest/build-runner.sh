#!/bin/bash
# Golden build entry point, launched by cloud-init runcmd. Output is mirrored to the serial console so the host
# can follow progress and read the result markers.
set -uo pipefail
trap '' PIPE

# First serial port: ttyAMA0 on arm64 (virt), ttyS0 on amd64 (q35).
CONSOLE=ttyAMA0
[ -e /dev/ttyAMA0 ] || CONSOLE=ttyS0
# serial-getty hangs up the console when it starts, which breaks long-lived writers; reopen the device per line instead.
systemctl stop "serial-getty@$CONSOLE.service" 2>/dev/null || true
to_console() {
  local line
  while IFS= read -r line; do
    printf '%s\n' "$line" >> /var/log/milibot-build.log
    printf '%s\r\n' "$line" 2>/dev/null > "/dev/$CONSOLE" || true
  done
}
exec > >(to_console) 2>&1

mkdir -p /mnt/seed
mount -o ro LABEL=CIDATA /mnt/seed 2>/dev/null || mount -o ro LABEL=cidata /mnt/seed
rm -rf /opt/milibot-src
mkdir -p /opt/milibot-src
tar -xzf /mnt/seed/payload.tgz -C /opt/milibot-src
umount /mnt/seed || true

rc=0
bash /opt/milibot-src/provision.sh || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "MILIBOT_MANIFEST_BEGIN"
  base64 -w0 /etc/milibot/manifest.json
  echo
  echo "MILIBOT_MANIFEST_END"

  apt-get clean
  rm -rf /var/lib/apt/lists/* /opt/milibot-src /tmp/* /var/tmp/* /root/.cache /home/agent/.cache
  cloud-init clean --logs --machine-id --seed || cloud-init clean --logs --seed
  rm -f /etc/ssh/ssh_host_*
  journalctl --rotate >/dev/null 2>&1 || true
  journalctl --vacuum-time=1s >/dev/null 2>&1 || true
  find /var/log -type f \( -name '*.gz' -o -name '*.1' \) -delete
  find /var/log -type f -exec truncate -s 0 {} +
  sync
  fstrim -av || true
fi

echo "MILIBOT_BUILD_RC=$rc"
sync
poweroff
