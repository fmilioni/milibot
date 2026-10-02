#!/usr/bin/env bash
# Builds the QEMU the app ships for one target: one system emulator, qemu-img, the UEFI firmware and every
# library they load, relocatable. Runs on the target OS (Windows: cross-compiled with MinGW on Fedora) from
# .github/workflows/qemu.yml; the dependencies are installed by the workflow.
#
#   vm/qemu/build.sh <darwin|linux|win32> <arm64|x64> <out-dir>
#
# Writes <out-dir>/qemu-<version>-<build>-<platform>-<arch>.tar.gz with bin/ (lib/ on macOS and Linux) and
# share/qemu/. QEMU_WORK_DIR moves the scratch folder (default: a temp dir).
set -euo pipefail

platform=${1:?platform}
arch=${2:?arch}
out=${3:?out dir}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=version.env
. "$here/version.env"

case "$arch" in
  arm64) target=aarch64 ;;
  x64) target=x86_64 ;;
  *) echo "unknown arch $arch" >&2; exit 2 ;;
esac
emulator=qemu-system-$target
case "$platform" in
  darwin) accel=(--enable-hvf) ;;
  linux) accel=(--enable-kvm) ;;
  win32) accel=(--enable-whpx --cross-prefix=x86_64-w64-mingw32-) ;;
  *) echo "unknown platform $platform" >&2; exit 2 ;;
esac

work=${QEMU_WORK_DIR:-$(mktemp -d)}
mkdir -p "$work" "$out"
out=$(cd "$out" && pwd)
src=$work/qemu-$QEMU_VERSION
stage=$work/stage
tarball=$work/qemu-$QEMU_VERSION.tar.xz

if [ ! -f "$tarball" ]; then
  curl -fsSL --retry 3 -o "$tarball.part" "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz"
  mv "$tarball.part" "$tarball"
fi
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$tarball"); else sum=$(shasum -a 256 "$tarball"); fi
[ "${sum%% *}" = "$QEMU_SHA256" ] || { echo "checksum mismatch for $tarball" >&2; exit 1; }
rm -rf "$src" "$stage"
tar -xJf "$tarball" -C "$work"

# Only what a headless VM with virtio disks, a stream netdev, QMP and UEFI needs: no slirp (gvproxy is
# the network), no UI, no audio, no USB.
cd "$src"
./configure \
  --prefix=/ \
  --target-list="$target-softmmu" \
  --without-default-features \
  --enable-system \
  --enable-tools \
  --enable-pixman \
  --enable-fdt=internal \
  --disable-docs \
  --disable-user \
  --disable-debug-info \
  ${QEMU_PYTHON:+--python="$QEMU_PYTHON"} \
  "${accel[@]}"
make -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)"
make install DESTDIR="$stage"

# Windows installs everything at the prefix's root; the other hosts in bin/ and share/qemu/.
cd "$stage"
if [ "$platform" = win32 ]; then
  mkdir -p bin share/qemu
  find . -maxdepth 1 -type f -name '*.exe' -exec mv {} bin/ \;
  find . -maxdepth 1 -type f ! -name '*.exe' -exec mv {} share/qemu/ \;
  for dir in */; do
    case "$dir" in bin/ | share/) ;; *) mv "$dir" share/qemu/ ;; esac
  done
  exe=.exe
else
  exe=
fi
find bin -type f ! -name "$emulator$exe" ! -name "qemu-img$exe" -delete
rm -rf include lib libexec var share/applications share/icons share/man share/doc share/locale
# The firmware and option ROMs this machine type can load; QEMU installs every target's.
case "$target" in
  aarch64) keep=(edk2-aarch64-code.fd edk2-arm-vars.fd) ;;
  x86_64) keep=(edk2-x86_64-code.fd edk2-i386-vars.fd 'bios*.bin' 'vgabios*.bin' kvmvapic.bin 'linuxboot*.bin'
    'multiboot*.bin' pvh.bin) ;;
esac
keep+=(edk2-licenses.txt 'efi-*.rom')
for file in share/qemu/*; do
  name=$(basename "$file")
  wanted=
  for pattern in "${keep[@]}"; do
    # shellcheck disable=SC2053
    [[ "$name" == $pattern ]] && wanted=1
  done
  [ -n "$wanted" ] || rm -rf "$file"
done
cp "$src/COPYING" "$src/LICENSE" share/qemu/

# Every library outside the OS goes along, found relative to the binaries.
case "$platform" in
  darwin)
    mkdir -p lib
    system_lib() { case "$1" in /usr/lib/* | /System/*) return 0 ;; *) return 1 ;; esac }
    deps() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }
    queue=(bin/*)
    while [ ${#queue[@]} -gt 0 ]; do
      file=${queue[0]}
      queue=("${queue[@]:1}")
      for dep in $(deps "$file"); do
        system_lib "$dep" && continue
        name=$(basename "$dep")
        case "$dep" in @*) real=$(find /opt/homebrew/lib /usr/local/lib -name "$name" 2>/dev/null | head -1) ;; *) real=$dep ;; esac
        [ -n "$real" ] || { echo "cannot find $dep (from $file)" >&2; exit 1; }
        if [ ! -f "lib/$name" ]; then
          cp -L "$real" "lib/$name"
          chmod u+w "lib/$name"
          install_name_tool -id "@rpath/$name" "lib/$name"
          queue+=("lib/$name")
        fi
        install_name_tool -change "$dep" "@rpath/$name" "$file"
      done
    done
    for bin in bin/*; do install_name_tool -add_rpath @executable_path/../lib "$bin"; done
    for lib in lib/*; do install_name_tool -add_rpath @loader_path "$lib" 2>/dev/null || true; done
    for lib in lib/*; do codesign --force --sign - "$lib"; done
    codesign --force --sign - bin/qemu-img
    codesign --force --sign - --entitlements "$here/hypervisor.entitlements" "bin/$emulator"
    ;;
  linux)
    mkdir -p lib
    glibc='^(linux-vdso|ld-linux[^ ]*|libc|libm|libdl|libpthread|librt|libresolv|libutil)\.so'
    for bin in bin/*; do
      ldd "$bin" | awk '$3 ~ /^\// {print $1, $3}' | while read -r name path; do
        [[ "$name" =~ $glibc ]] && continue
        [ -f "lib/$name" ] || cp -L "$path" "lib/$name"
      done
    done
    # shellcheck disable=SC2016 # $ORIGIN is for the dynamic loader
    for file in bin/* lib/*; do patchelf --force-rpath --set-rpath '$ORIGIN/../lib' "$file"; done
    ;;
  win32)
    sysroot=$(x86_64-w64-mingw32-gcc -print-sysroot)/mingw/bin
    [ -d "$sysroot" ] || sysroot=/usr/x86_64-w64-mingw32/sys-root/mingw/bin
    queue=(bin/*.exe)
    while [ ${#queue[@]} -gt 0 ]; do
      file=${queue[0]}
      queue=("${queue[@]:1}")
      for dll in $(x86_64-w64-mingw32-objdump -p "$file" | awk '/DLL Name:/ {print $3}'); do
        [ -f "$sysroot/$dll" ] || continue
        if [ ! -f "bin/$dll" ]; then
          cp "$sysroot/$dll" "bin/$dll"
          queue+=("bin/$dll")
        fi
      done
    done
    x86_64-w64-mingw32-strip bin/*.exe bin/*.dll
    ;;
esac

name=qemu-$QEMU_VERSION-$QEMU_BUILD-$platform-$arch.tar.gz
tar -czf "$out/$name" -C "$stage" .
echo "$out/$name"
