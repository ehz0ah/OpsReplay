#!/bin/sh
set -eu

# This is a local Debian rebuild, not a claim of an official Debian security fix.
original_version=$(dpkg-query -W -f='${Version}' vim-tiny)
if test "$original_version" != '2:9.0.1378-2+deb12u2'; then
    printf '%s\n' 'Vim package changed; review the recovery patch against the new Debian source.' >&2
    exit 1
fi
patched_version="${original_version}+opsreplay1"
set -- /build/vim-*/debian/rules
test "$#" -eq 1 && test -f "$1"
source_directory=${1%/debian/rules}
cd "$source_directory"
patch --batch --forward --fuzz=0 -p1 < /build/security/CVE-2026-28421.patch
# Preserve Debian's Small/Tiny feature set, hardening and vimrc handling.
make -f debian/rules configure-vim-tiny build-vim-tiny VARIANT=vim-tiny DEB_BUILD_OPTIONS=parallel=2 \
    BUILDER='team+vim@tracker.debian.org + OpsReplay CVE-2026-28421 backport'

mkdir /build/original-package /build/patched-package
cd /build/original-package
apt-get download "vim-tiny=$original_version"
set -- ./*.deb
test "$#" -eq 1 && test -f "$1"
dpkg-deb --extract "$1" /build/patched-package
dpkg-deb --control "$1" /build/patched-package/DEBIAN
install -m 755 "$source_directory/src/vim-tiny/vim" /build/patched-package/usr/bin/vim.tiny

cd /build/patched-package
install -m 644 "$source_directory/LICENSE" usr/share/doc/vim-tiny/LICENSE.Vim
install -m 644 /build/security/CVE-2026-28421.patch usr/share/doc/vim-tiny/CVE-2026-28421.patch
printf 'Local security backport: CVE-2026-28421\nOriginal Debian version: %s\nLocal version: %s\n' \
    "$original_version" "$patched_version" > usr/share/doc/vim-tiny/opsreplay-backport.txt
sha256sum usr/bin/vim.tiny > usr/share/doc/vim-tiny/opsreplay-binary.sha256
sed -i \
    -e "s/^Version: .*/Version: $patched_version/" \
    -e "s/^Source: .*/Source: vim ($patched_version)/" \
    -e '/^Origin: /d' \
    DEBIAN/control
printf 'Origin: OpsReplay local rebuild\n' >> DEBIAN/control
size=$(du -sk --exclude=DEBIAN . | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $size/" DEBIAN/control
find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums
dpkg-deb --root-owner-group --build /build/patched-package /build/vim-tiny-security.deb
