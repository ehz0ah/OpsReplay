#!/bin/sh
set -eu

original_version=$(dpkg-query -W -f='${Version}' libc6)
test "$original_version" = '2.36-9+deb12u14'
version='2.36-9+deb12u14+opsreplay1'
cd /build/glibc-2.36
make -f debian/rules patch DEB_BUILD_PROFILES=nobiarch
patch --batch --fuzz=0 -p1 < /build/security/gettext-path-restriction.patch
make -f debian/rules build_libc DEB_BUILD_PROFILES=nobiarch DEB_BUILD_OPTIONS=parallel=2
library=/build/glibc-2.36/build-tree/amd64-libc/libc.so
loader=/build/glibc-2.36/build-tree/amd64-libc/elf/ld.so
test -f "$library" && test -f "$loader"

# Use a normal valid catalog, never malformed translations or format directives.
mkdir -p /build/catalogs/de_DE/LC_MESSAGES /build/test-locales
printf '%s\n' 'msgid ""' 'msgstr "Content-Type: text/plain; charset=UTF-8\n"' \
    '' 'msgid "cheese"' 'msgstr "Kaese"' > /build/ordinary.po
msgfmt --check -o /build/catalogs/de_DE/LC_MESSAGES/ordinary.mo /build/ordinary.po
I18NPATH=/build/glibc-2.36/localedata GCONV_PATH=/build/glibc-2.36/build-tree/amd64-libc/iconvdata \
    LC_ALL=C "$loader" --library-path /build/glibc-2.36/build-tree/amd64-libc \
    /build/glibc-2.36/build-tree/amd64-libc/locale/localedef \
    --no-archive -i de_DE -f UTF-8 /build/test-locales/de_DE.UTF-8
gcc -o /build/gettext-compatibility /build/security/gettext-compatibility.c
LOCPATH=/build/test-locales "$loader" --library-path /build/glibc-2.36/build-tree/amd64-libc \
    /build/gettext-compatibility /build/catalogs /build/catalogs/de_DE /build/catalogs/de_DE/LC_MESSAGES

mkdir /build/glibc-original /build/glibc-package
cd /build/glibc-original
apt-get download "libc6=$original_version"
set -- ./*.deb
test "$#" -eq 1 && test -f "$1"
dpkg-deb --extract "$1" /build/glibc-package
dpkg-deb --control "$1" /build/glibc-package/DEBIAN
cd /build/glibc-package
python3 - "$library" <<'PY'
import subprocess
import sys
from pathlib import Path

def symbols(path):
    result = subprocess.check_output(["nm", "-D", "--defined-only", str(path)], text=True)
    return {line.split()[-1].replace("@@", "@") for line in result.splitlines() if line.split()}
for relative, replacement in (
    ("lib/x86_64-linux-gnu/libc.so.6", Path(sys.argv[1])),
    ("lib/x86_64-linux-gnu/ld-linux-x86-64.so.2", Path("/build/glibc-2.36/build-tree/amd64-libc/elf/ld.so")),
):
    original = Path(relative)
    if not original.is_file() or original.is_symlink():
        raise ValueError("Original libc package layout changed: " + relative)
    if not symbols(original).issubset(symbols(replacement)):
        raise ValueError("Rebuilt glibc lost ABI symbols: " + relative)
PY
install -m 755 "$library" lib/x86_64-linux-gnu/libc.so.6
install -m 755 "$loader" lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
strip --strip-unneeded lib/x86_64-linux-gnu/libc.so.6 lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
doc=usr/share/doc/libc6
install -d "$doc"
install -m 644 /build/glibc-2.36/COPYING.LIB "$doc/COPYING.LIB"
install -m 644 /build/glibc_2.36-9+deb12u14.dsc "$doc/source.dsc"
install -m 644 /build/security/build-glibc-security.sh /build/security/gettext-path-restriction.patch "$doc/"
printf 'Debian source: 2.36-9+deb12u14\nBookworm local backport: %s\nUpstream proposal: v7, under review\nChanged payloads: libc.so.6 and matching native loader\n' \
    "$version" > "$doc/opsreplay-rebuild.txt"
sed -i -e "s/^Version: .*/Version: $version/" -e "s/^Source: .*/Source: glibc ($version)/" \
    -e '/^Origin: /d' DEBIAN/control
printf 'Origin: OpsReplay local backport\n' >> DEBIAN/control
size=$(du -sk --exclude=DEBIAN . | cut -f1)
sed -i "s/^Installed-Size: .*/Installed-Size: $size/" DEBIAN/control
find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums
dpkg-deb --root-owner-group --build /build/glibc-package /build/libc6-security.deb
python3 - <<'PY'
from pathlib import Path
root = Path("/build/glibc-package")
paths = set()
for line in (root / "DEBIAN/md5sums").read_text().splitlines():
    path = Path("/") / line.split("  ", 1)[1]
    paths.add(str(path))
    paths.update(str(parent) for parent in path.parents if str(parent) != "/")
Path("/build/glibc-retain-files.conf").write_text("".join("path-include " + path + "\n" for path in sorted(paths)))
PY
