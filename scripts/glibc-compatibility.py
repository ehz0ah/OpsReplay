"""Ordinary runtime checks for the hosted Bookworm libc backport."""

import ctypes
import json
import locale
import subprocess

VERSION = "2.36-9+deb12u14+opsreplay2"
actual = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", "libc6"], text=True)
assert actual == VERSION, actual
subprocess.run(
    ["md5sum", "-c", "/var/lib/dpkg/info/libc6:amd64.md5sums"],
    cwd="/", check=True, stdout=subprocess.DEVNULL,
)
runtime = subprocess.check_output(["getconf", "GNU_LIBC_VERSION"], text=True).strip()
assert runtime == "glibc 2.36", runtime
library = ctypes.CDLL("libc.so.6")
library.gnu_get_libc_version.restype = ctypes.c_char_p
assert library.gnu_get_libc_version() == b"2.36"
assert locale.setlocale(locale.LC_ALL, "C.UTF-8") == "C.UTF-8"
assert subprocess.check_output(["sh", "-c", "printf ordinary"], text=True) == "ordinary"
print(json.dumps({"packageVersion": VERSION, "runtimeVersion": "2.36", "packageHashesVerified": True}))
