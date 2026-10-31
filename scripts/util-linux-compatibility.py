"""Normal utility and shared-library checks for the hosted Challenge image."""

import ctypes
import json
import subprocess
import tempfile
from pathlib import Path

VERSION = "2.42.4-1+opsreplay1"
packages = ("bsdutils", "util-linux", "util-linux-extra", "mount", "libblkid1", "libmount1", "libsmartcols1", "libuuid1")
for package in packages:
    actual = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", package], text=True)
    expected = "1:" + VERSION if package == "bsdutils" else VERSION
    assert actual == expected, (package, actual)
    prefix = package + (":amd64" if package.startswith("lib") else "")
    subprocess.run(
        ["md5sum", "-c", "/var/lib/dpkg/info/" + prefix + ".md5sums"],
        cwd="/", check=True, stdout=subprocess.DEVNULL,
    )
for tool in ("findmnt", "lsblk", "mount", "umount", "nsenter", "runuser", "su", "setpriv", "flock", "script", "lsfd", "hwclock"):
    result = subprocess.check_output([tool, "--version"], text=True)
    assert "2.42.4" in result, (tool, result)
for library in ("libblkid.so.1", "libmount.so.1", "libsmartcols.so.1", "libuuid.so.1"):
    ctypes.CDLL(library)
subprocess.run(["dpkg", "--audit"], check=True, capture_output=True, text=True)
for package in packages:
    paths = subprocess.check_output(["dpkg-query", "-L", package], text=True).splitlines()
    for name in paths:
        path = Path(name)
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as file:
            is_elf = file.read(4) == b"\x7fELF"
        if is_elf:
            result = subprocess.run(["ldd", name], capture_output=True, text=True, check=True)
            assert "not found" not in result.stdout + result.stderr, name
assert subprocess.check_output(["runuser", "-u", "shop", "--", "id", "-un"], text=True).strip() == "shop"
assert subprocess.check_output(["setpriv", "--no-new-privs", "id", "-u"], text=True).strip() == "0"
with tempfile.TemporaryDirectory(prefix="opsreplay-utilities-") as directory:
    output = subprocess.check_output(["flock", str(Path(directory) / "lock"), "printf", "locked"], text=True)
    assert output == "locked"
assert subprocess.check_output(["findmnt", "--noheadings", "--output", "TARGET", "/"], text=True).strip() == "/"
print(json.dumps({"packageVersion": VERSION, "packagesVerified": len(packages), "ordinaryUtilities": True}))
