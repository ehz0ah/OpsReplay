"""Ordinary compression and shared-library checks in the hosted Challenge image."""

import ctypes
import gzip
import json
import subprocess
import tempfile
from pathlib import Path

import zlib

assert zlib.ZLIB_RUNTIME_VERSION == "1.3.2"
data = ("OpsReplay compression check: café\n" * 1000).encode()
for level in range(10):
    assert zlib.decompress(zlib.compress(data, level)) == data
assert gzip.decompress(gzip.compress(data)) == data

library = ctypes.CDLL("libz.so.1")
library.zlibVersion.restype = ctypes.c_char_p
assert library.zlibVersion() == b"1.3.2"
library.gzopen.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
library.gzopen.restype = ctypes.c_void_p
library.gzwrite.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
library.gzwrite.restype = ctypes.c_int
library.gzclose.argtypes = [ctypes.c_void_p]
library.gzclose.restype = ctypes.c_int
with tempfile.TemporaryDirectory(prefix="opsreplay-zlib-") as directory:
    path = Path(directory) / "ordinary.gz"
    handle = library.gzopen(str(path).encode(), b"wb")
    assert handle
    try:
        buffer = ctypes.create_string_buffer(data)
        assert library.gzwrite(handle, buffer, len(data)) == len(data)
    finally:
        assert library.gzclose(handle) == 0
    assert gzip.decompress(path.read_bytes()) == data

version = subprocess.check_output(
    ["dpkg-query", "-W", "-f=${Version}", "zlib1g"], text=True
)
assert version == "1:1.3.dfsg+really1.3.2-4+opsreplay1"
subprocess.run(
    ["md5sum", "-c", "/var/lib/dpkg/info/zlib1g:amd64.md5sums"],
    cwd="/",
    check=True,
    stdout=subprocess.DEVNULL,
)
print(json.dumps({"runtimeVersion": "1.3.2", "packageVersion": version, "roundTrip": True}))
