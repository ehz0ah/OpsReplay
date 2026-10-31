#!/bin/sh
set -eu

version='8.23.0-1+opsreplay1'
original_version=$(dpkg-query -W -f='${Version}' curl)
test "$original_version" = '7.88.1-10+deb12u15'
test "$(dpkg-query -W -f='${Version}' libcurl4)" = "$original_version"
cd /build/curl-8.23.0
export DEB_BUILD_MAINT_OPTIONS=hardening=+all
export CFLAGS="$(dpkg-buildflags --get CFLAGS)"
export CPPFLAGS="$(dpkg-buildflags --get CPPFLAGS)"
export LDFLAGS="$(dpkg-buildflags --get LDFLAGS)"
./configure --enable-option-checking=fatal --prefix=/usr --libdir=/usr/lib/x86_64-linux-gnu \
    --disable-static --enable-versioned-symbols --enable-symbol-hiding \
    --enable-threaded-resolver --with-openssl --with-gssapi=/usr \
    --with-libssh2 --without-libssh --with-libidn2 --with-libpsl \
    --with-nghttp2 --with-brotli --with-zstd --with-zlib --with-lber-lib=lber \
    --with-ca-path=/etc/ssl/certs --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt
make -j2
make install DESTDIR=/build/curl-installed
cd /build
mkdir curl-original libcurl4-original curl-package libcurl4-package
(cd curl-original && apt-get download "curl=$original_version")
(cd libcurl4-original && apt-get download "libcurl4=$original_version")

for package in curl libcurl4; do
    set -- "/build/$package-original/"*.deb
    test "$#" -eq 1 && test -f "$1"
    target="/build/$package-package"
    dpkg-deb --extract "$1" "$target"
    dpkg-deb --control "$1" "$target/DEBIAN"
    if test "$package" = curl; then
        install -m 755 /build/curl-installed/usr/bin/curl "$target/usr/bin/curl"
        install -m 644 /build/curl-installed/usr/share/man/man1/curl.1 "$target/usr/share/man/man1/curl.1"
        gzip -n -f "$target/usr/share/man/man1/curl.1"
        sed -i "s/libcurl4 (= $original_version)/libcurl4 (= $version)/" "$target/DEBIAN/control"
    else
        library_dir="$target/usr/lib/x86_64-linux-gnu"
        rm "$library_dir"/libcurl.so.4*
        cp -a /build/curl-installed/usr/lib/x86_64-linux-gnu/libcurl.so.4* "$library_dir/"
    fi
    doc="$target/usr/share/doc/$package"
    install -d "$doc"
    install -m 644 /build/curl-8.23.0/COPYING "$doc/LICENSE.curl"
    install -m 644 /build/curl_8.23.0-1.dsc "$doc/source.dsc"
    install -m 644 /build/security/build-curl-security.sh "$doc/build-curl-security.sh"
    printf 'Upstream curl: 8.23.0\nDebian source: 8.23.0-1\nBookworm rebuild: %s\nOriginal binary package: %s\n' \
        "$version" "$original_version" > "$doc/opsreplay-rebuild.txt"
    sed -i -e "s/^Version: .*/Version: $version/" -e "s/^Source: .*/Source: curl ($version)/" \
        -e '/^Origin: /d' "$target/DEBIAN/control"
    if ! grep -q '^Source:' "$target/DEBIAN/control"; then
        printf 'Source: curl (%s)\n' "$version" >> "$target/DEBIAN/control"
    fi
    printf 'Origin: OpsReplay local rebuild\n' >> "$target/DEBIAN/control"
    size=$(du -sk --exclude=DEBIAN "$target" | cut -f1)
    sed -i "s/^Installed-Size: .*/Installed-Size: $size/" "$target/DEBIAN/control"
    (cd "$target" && find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
    dpkg-deb --root-owner-group --build "$target" "/build/$package-security.deb"
done
