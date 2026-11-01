#!/bin/sh
set -eu

cd /build/util-linux-2.42.4
# Regenerate release files with the Bookworm Automake version, as Debian does.
AM_OPTS=--copy LT_OPTS=--copy sh ./autogen.sh
export DEB_BUILD_MAINT_OPTIONS=hardening=+all
export CFLAGS="$(dpkg-buildflags --get CFLAGS)"
export CPPFLAGS="$(dpkg-buildflags --get CPPFLAGS)"
export LDFLAGS="$(dpkg-buildflags --get LDFLAGS)"
./configure --enable-option-checking=fatal --prefix=/usr \
    --bindir=/usr/bin --sbindir=/usr/sbin --libdir=/usr/lib/x86_64-linux-gnu \
    --disable-static --disable-asciidoc --disable-makeinstall-chown \
    --with-selinux --with-smack --with-systemd --with-udev --with-audit \
    --with-cryptsetup=dlopen --enable-write --disable-hwclock-gplv3 \
    --disable-makeinstall-tty-setgid \
    --without-python --disable-login --disable-chfn-chsh --disable-nologin \
    --disable-kill --disable-cal --disable-pam-lastlog2 --disable-liblastlog2
make -j2
make install DESTDIR=/build/util-linux-installed
python3 /build/security/repack-util-linux.py
