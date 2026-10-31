"""Preserve Bookworm package layout while replacing its utilities and libraries."""

import hashlib
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

BUILD = Path("/build")
SOURCE = BUILD / "util-linux-2.42.4"
INSTALLED = BUILD / "util-linux-installed"
VERSION = "2.42.4-1+opsreplay1"
ORIGINAL = "2.38.1-5+deb12u3"
PACKAGES = ("bsdutils", "util-linux", "util-linux-extra", "mount", "libblkid1", "libmount1", "libsmartcols1", "libuuid1")
LIBRARIES = ("libblkid", "libmount", "libsmartcols", "libuuid")


def run(*args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError("Build command failed: " + args[0] + "\n" + result.stdout[-8192:] + result.stderr[-8192:])
    return result.stdout.strip()


def elf(path):
    if path.is_symlink() or not path.is_file():
        return False
    with path.open("rb") as file:
        return file.read(4) == b"\x7fELF"


def symbols(path):
    output = run("nm", "-D", "--defined-only", str(path))
    return {line.split()[-1].replace("@@", "@") for line in output.splitlines() if line.split()}


retain = set()
output = BUILD / "util-linux-packages"
output.mkdir()
local_shlibs = BUILD / "util-linux-shlibs.local"
local_shlibs.write_text("".join(f"{library} 1 {library}1 (>= {VERSION})\n" for library in LIBRARIES))
prepared = []
for package in PACKAGES:
    original_version = "1:" + ORIGINAL if package == "bsdutils" else ORIGINAL
    package_version = "1:" + VERSION if package == "bsdutils" else VERSION
    installed_version = run("dpkg-query", "-W", "-f=${Version}", package)
    if installed_version != original_version:
        raise ValueError(f"Unexpected original package: {package} {installed_version}")
    archive = BUILD / (package + "-original")
    archive.mkdir()
    run("apt-get", "download", package + "=" + original_version, cwd=archive)
    packages = list(archive.glob("*.deb"))
    if len(packages) != 1:
        raise ValueError("Expected one original package")
    target = BUILD / (package + "-package")
    run("dpkg-deb", "--extract", str(packages[0]), str(target))
    run("dpkg-deb", "--control", str(packages[0]), str(target / "DEBIAN"))
    replaced = []
    for path in sorted(target.rglob("*")):
        if "DEBIAN" in path.relative_to(target).parts or not elf(path):
            continue
        relative = path.relative_to(target)
        canonical = relative if relative.parts[0] == "usr" else Path("usr") / relative
        replacement = INSTALLED / canonical
        # Debian names upstream rename as rename.ul.
        if canonical.name == "rename.ul":
            replacement = replacement.with_name("rename")
        if not elf(replacement) and canonical.parts[:2] in (("usr", "bin"), ("usr", "sbin")):
            directory = "sbin" if canonical.parts[1] == "bin" else "bin"
            replacement = INSTALLED / "usr" / directory / replacement.name
        if not elf(replacement):
            raise ValueError("Missing rebuilt ELF: " + str(relative))
        if ".so." in path.name and not symbols(path).issubset(symbols(replacement)):
            raise ValueError("Rebuilt library lost ABI symbols: " + str(relative))
        mode = stat.S_IMODE(path.stat().st_mode)
        shutil.copyfile(replacement, path)
        os.chmod(path, mode)
        replaced.append(str(relative))
    if not replaced:
        raise ValueError("Package had no rebuilt payload: " + package)
    doc = target / "usr/share/doc" / package
    doc.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / "COPYING", doc / "COPYING.util-linux")
    shutil.copyfile(BUILD / "util-linux_2.42.4-1.dsc", doc / "source.dsc")
    for name in ("build-util-linux-security.sh", "repack-util-linux.py"):
        shutil.copyfile(BUILD / "security" / name, doc / name)
    (doc / "opsreplay-rebuild.txt").write_text(
        f"Debian source: 2.42.4-1\nBookworm rebuild: {package_version}\nOriginal package: {original_version}\n"
    )
    (doc / "rebuilt-files.txt").write_text("\n".join(replaced) + "\n")
    control = target / "DEBIAN/control"
    text = control.read_text()
    text = re.sub(r"^Version: .*", "Version: " + package_version, text, flags=re.M)
    text = re.sub(r"^Source: .*\n", "", text, flags=re.M)
    text = re.sub(r"^Origin: .*\n", "", text, flags=re.M)
    text += f"Source: util-linux ({VERSION})\nOrigin: OpsReplay local rebuild\n"
    # Keep equality relationships between matching util-linux packages coherent.
    text = text.replace("(= " + ORIGINAL + ")", "(= " + VERSION + ")")
    arguments = ["dpkg-shlibdeps", "-O", "-x" + package,
                 "-l" + str(INSTALLED / "usr/lib/x86_64-linux-gnu"), "-L" + str(local_shlibs)]
    arguments.extend("-e" + str(target / relative) for relative in replaced)
    dependencies = run(*arguments, cwd=SOURCE)
    fields = dict(line.split("=", 1) for line in dependencies.splitlines() if "=" in line)
    generated = fields.get("shlibs:Depends", "")
    if generated:
        existing = re.search(r"^Depends: (.*)$", text, flags=re.M)
        combined = list(dict.fromkeys((existing.group(1) + ", " + generated).split(", ") if existing else generated.split(", ")))
        if existing:
            text = re.sub(r"^Depends: .*", "Depends: " + ", ".join(combined), text, flags=re.M)
        else:
            text += "Depends: " + ", ".join(combined) + "\n"
    size = sum(path.stat().st_size for path in target.rglob("*") if path.is_file() and "DEBIAN" not in path.relative_to(target).parts)
    text = re.sub(r"^Installed-Size: .*", "Installed-Size: " + str((size + 1023) // 1024), text, flags=re.M)
    control.write_text(text)
    for library in (target / "DEBIAN").glob("shlibs"):
        library.write_text(re.sub(r"\(>= [^)]+\)", "(>= " + VERSION + ")", library.read_text()))
    if package.startswith("lib"):
        run("dpkg-gensymbols", "-p" + package, "-v" + VERSION, "-P" + str(target), "-c1",
            "-I" + str(target / "DEBIAN/symbols"),
            *("-e" + str(target / relative) for relative in replaced), cwd=SOURCE)
    hashes = []
    for path in sorted(target.rglob("*")):
        relative = path.relative_to(target)
        if path.is_symlink() or not path.is_file() or "DEBIAN" in relative.parts:
            continue
        hashes.append(hashlib.md5(path.read_bytes()).hexdigest() + "  " + str(relative))
        absolute = Path("/") / relative
        retain.add(str(absolute))
        retain.update(str(parent) for parent in absolute.parents if str(parent) != "/")
    (target / "DEBIAN/md5sums").write_text("\n".join(hashes) + "\n")
    prepared.append((package, target))

for package, target in prepared:
    run("dpkg-deb", "--root-owner-group", "--build", str(target), str(output / (package + ".deb")))

(BUILD / "util-linux-retain-files.conf").write_text("".join("path-include " + path + "\n" for path in sorted(retain)))
