#!/bin/sh
set -eu

version='1:1.3.dfsg+really1.3.2-4+opsreplay1'
original_version=$(dpkg-query -W -f='${Version}' zlib1g)
test "$original_version" = '1:1.2.13.dfsg-1'
set -- /build/zlib-*/configure
test "$#" -eq 1 && test -f "$1"
source_directory=${1%/configure}
cd "$source_directory"
test -f debian/patches/Fix-buffer-overflow-bug-in-non-blocking-gzwrite.patch
grep -qx 'Fix-buffer-overflow-bug-in-non-blocking-gzwrite.patch' .pc/applied-patches
export DEB_BUILD_MAINT_OPTIONS=hardening=+all
export CFLAGS="$(dpkg-buildflags --get CFLAGS) $(dpkg-buildflags --get CPPFLAGS) -D_REENTRANT"
export LDFLAGS="$(dpkg-buildflags --get LDFLAGS)"
./configure --shared --prefix=/usr --libdir=/usr/lib/x86_64-linux-gnu --disable-crcvx
make -j2
make test
make install DESTDIR=/build/zlib-installed

mkdir /build/zlib-original /build/zlib-package
cd /build/zlib-original
apt-get download "zlib1g=$original_version"
set -- ./*.deb
test "$#" -eq 1 && test -f "$1"
dpkg-deb --extract "$1" /build/zlib-package
dpkg-deb --control "$1" /build/zlib-package/DEBIAN
cd /build/zlib-package
# Keep the existing package path on Debian's merged /usr filesystem.
set -- lib/x86_64-linux-gnu/libz.so.1 usr/lib/x86_64-linux-gnu/libz.so.1
if test -L "$1"; then
    library_directory=${1%/libz.so.1}
    test ! -L "$2"
else
    test -L "$2"
    library_directory=${2%/libz.so.1}
fi
rm "$library_directory"/libz.so.1*
cp -a /build/zlib-installed/usr/lib/x86_64-linux-gnu/libz.so.1* "$library_directory/"
doc=usr/share/doc/zlib1g
install -d "$doc"
install -m 644 "$source_directory/LICENSE" "$doc/LICENSE.zlib"
install -m 644 /build/zlib_1.3.dfsg+really1.3.2-4.dsc "$doc/source.dsc"
install -m 644 /build/security/build-zlib-security.sh "$doc/build-zlib-security.sh"
install -m 644 "$source_directory/debian/patches/Fix-buffer-overflow-bug-in-non-blocking-gzwrite.patch" "$doc/"
printf 'Upstream zlib: 1.3.2\nDebian fixed source: 1:1.3.dfsg+really1.3.2-4\nBookworm rebuild: %s\nOriginal binary package: %s\n' \
    "$version" "$original_version" > "$doc/opsreplay-rebuild.txt"
sed -i -e "s/^Version: .*/Version: $version/" -e "s/^Source: .*/Source: zlib ($version)/" \
    -e '/^Origin: /d' DEBIAN/control
if ! grep -q '^Source:' DEBIAN/control; then
    printf 'Source: zlib (%s)\n' "$version" >> DEBIAN/control
fi
printf 'Origin: OpsReplay local rebuild\n' >> DEBIAN/control
size=$(du -sk --exclude=DEBIAN . | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $size/" DEBIAN/control
find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums
dpkg-deb --root-owner-group --build /build/zlib-package /build/zlib1g-security.deb
