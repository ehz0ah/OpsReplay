#!/bin/sh
set -eu

cd /build/sqlite3-3.54.1
test "$(cat VERSION)" = '3.54.1'
export DEB_BUILD_MAINT_OPTIONS=hardening=+all
export CFLAGS="$(dpkg-buildflags --get CFLAGS) -O2 -fno-strict-aliasing \
 -DSQLITE_SECURE_DELETE -DSQLITE_ENABLE_COLUMN_METADATA \
 -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS \
 -DSQLITE_ENABLE_RTREE=1 -DSQLITE_SOUNDEX=1 -DSQLITE_ENABLE_UNLOCK_NOTIFY \
 -DSQLITE_OMIT_LOOKASIDE=1 -DSQLITE_ENABLE_DBSTAT_VTAB -DSQLITE_ALLOW_ROWID_IN_VIEW \
 -DSQLITE_ENABLE_UPDATE_DELETE_LIMIT=1 -DSQLITE_ENABLE_LOAD_EXTENSION \
 -DSQLITE_ENABLE_JSON1 -DSQLITE_LIKE_DOESNT_MATCH_BLOBS -DSQLITE_THREADSAFE=1 \
 -DSQLITE_ENABLE_FTS3_TOKENIZER=1 -DSQLITE_USE_URI=1 -DSQLITE_MAX_SCHEMA_RETRY=25 \
 -DSQLITE_ENABLE_PREUPDATE_HOOK -DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_STMTVTAB \
 -DSQLITE_MAX_VARIABLE_NUMBER=250000"
export CPPFLAGS="$(dpkg-buildflags --get CPPFLAGS)"
export LDFLAGS="$(dpkg-buildflags --get LDFLAGS) -Wl,--as-needed"
# Keep Bookworm's features and legacy SONAME. No sid binary is installed.
./configure --prefix=/usr --libdir=/usr/lib/x86_64-linux-gnu \
    --enable-threadsafe --enable-load-extension --enable-json \
    --enable-fts4 --enable-fts5 --enable-session --enable-update-limit \
    --enable-column-metadata --disable-amalgamation --disable-static \
    --disable-tcl --disable-readline --disable-rpath --soname=legacy
make -j2 libsqlite3.so
make install-dll DESTDIR=/build/sqlite-installed
python3 /build/security/repack-sqlite.py
