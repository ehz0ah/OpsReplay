#!/bin/sh
set -eu

# Build the fixed upstream source for Bookworm with Debian's Tiny configuration.
original_version=$(dpkg-query -W -f='${Version}' vim-tiny)
if test "$original_version" != '2:9.0.1378-2+deb12u2'; then
    printf '%s\n' 'Vim package changed; review the recovery patch against the new Debian source.' >&2
    exit 1
fi
patched_version='2:9.2.0858-1+opsreplay1'
set -- /build/vim-*/debian/rules
test "$#" -eq 1 && test -f "$1"
source_directory=${1%/debian/rules}
cd "$source_directory"
# Preserve Debian's Small/Tiny feature set, hardening and vimrc handling.
make -f debian/rules configure-vim-tiny build-vim-tiny VARIANT=vim-tiny DEB_BUILD_OPTIONS=parallel=2 \
    BUILDER='OpsReplay Bookworm rebuild of Debian Vim 9.2.0858-1'

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
install -m 644 /build/vim_9.2.0858-1.dsc usr/share/doc/vim-tiny/source.dsc
install -m 644 /build/security/build-vim-security.sh usr/share/doc/vim-tiny/build-vim-security.sh
printf 'Upstream source: Vim 9.2.0858\nOriginal Debian binary version: %s\nBookworm rebuild: %s\n' \
    "$original_version" "$patched_version" > usr/share/doc/vim-tiny/opsreplay-backport.txt
sha256sum usr/bin/vim.tiny > usr/share/doc/vim-tiny/opsreplay-binary.sha256
sed -i \
    -e "s/^Version: .*/Version: $patched_version/" \
    -e "s/^Source: .*/Source: vim ($patched_version)/" \
    -e '/^Origin: /d' \
    -e "s/vim-common (= $original_version)/vim-common (= $patched_version)/" \
    DEBIAN/control
printf 'Origin: OpsReplay local rebuild\n' >> DEBIAN/control
size=$(du -sk --exclude=DEBIAN . | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $size/" DEBIAN/control
find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums
dpkg-deb --root-owner-group --build /build/patched-package /build/vim-tiny-security.deb

# vim-common contains the shared configuration and documentation for this source
# version. Rebuild its payload as well so Tiny does not depend on old Vim files.
mkdir /build/original-common /build/patched-common
common_version=$(dpkg-query -W -f='${Version}' vim-common)
test "$common_version" = "$original_version"
cd /build/original-common
apt-get download "vim-common=$common_version"
set -- ./*.deb
test "$#" -eq 1 && test -f "$1"
dpkg-deb --extract "$1" /build/patched-common
dpkg-deb --control "$1" /build/patched-common/DEBIAN
cd /build/patched-common
rm -r usr/share/vim/vim90
install -d usr/share/vim/vim92/doc
install -m 644 "$source_directory/debian/runtime/debian.vim" usr/share/vim/vim92/debian.vim
for file in sponsor.txt uganda.txt version9.txt; do
    install -m 644 "$source_directory/runtime/doc/$file" "usr/share/vim/vim92/doc/$file"
done
install -m 755 "$source_directory/debian/helpztags" usr/bin/helpztags
install -m 644 "$source_directory/runtime/doc/vim.1" usr/share/man/man1/vim.1
gzip -n -f usr/share/man/man1/vim.1
install -d usr/share/doc/vim-common
install -m 644 "$source_directory/LICENSE" usr/share/doc/vim-common/LICENSE.Vim
install -m 644 /build/vim_9.2.0858-1.dsc usr/share/doc/vim-common/source.dsc
printf 'Upstream shared files: Vim 9.2.0858\nBookworm rebuild: %s\n' "$patched_version" > usr/share/doc/vim-common/opsreplay-rebuild.txt
sed -i -e "s/^Version: .*/Version: $patched_version/" -e "s/^Source: .*/Source: vim ($patched_version)/" -e '/^Origin: /d' DEBIAN/control
printf 'Origin: OpsReplay local rebuild\n' >> DEBIAN/control
size=$(du -sk --exclude=DEBIAN . | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $size/" DEBIAN/control
find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums
dpkg-deb --root-owner-group --build /build/patched-common /build/vim-common-security.deb

# Debian slim filters documentation during dpkg installation. Retain each file
# recorded by these two rebuilt packages, including its parent directories.
python3 - <<'PY'
from pathlib import Path
paths = set()
for package in ("patched-package", "patched-common"):
    root = Path("/build") / package
    for line in (root / "DEBIAN/md5sums").read_text().splitlines():
        relative = line.split("  ", 1)[1]
        path = Path("/") / relative
        paths.add(str(path))
        paths.update(str(parent) for parent in path.parents if str(parent) != "/")
Path("/build/vim-retain-files.conf").write_text("".join("path-include " + path + "\n" for path in sorted(paths)))
PY
