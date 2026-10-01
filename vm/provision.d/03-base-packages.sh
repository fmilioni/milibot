# shellcheck shell=bash
retry apt_get update
retry apt_get full-upgrade
retry apt_install \
  ca-certificates curl wget gnupg lsb-release apt-transport-https \
  build-essential cmake pkg-config libssl-dev \
  git git-lfs \
  python3 python3-pip python3-venv python3-dev \
  sqlite3 postgresql-client jq ripgrep fd-find tmux vim nano htop \
  zip unzip xz-utils bzip2 file less procps psmisc iproute2 iputils-ping dnsutils rsync \
  openssh-client sudo acl locales tzdata cloud-guest-utils e2fsprogs util-linux \
  xfce4 xfce4-terminal thunar xfwm4 xfdesktop4 xfce4-panel xfce4-session xfce4-settings xfconf xfce4-notifyd \
  tigervnc-standalone-server tigervnc-tools xdotool imagemagick scrot \
  dbus-x11 dbus-user-session x11-xserver-utils x11-utils xauth xfonts-base \
  adwaita-icon-theme elementary-xfce-icon-theme hicolor-icon-theme gnome-themes-extra \
  fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-noto-mono \
  at-spi2-core libnss3 xdg-utils \
  poppler-utils pandoc tesseract-ocr tesseract-ocr-por tesseract-ocr-eng
