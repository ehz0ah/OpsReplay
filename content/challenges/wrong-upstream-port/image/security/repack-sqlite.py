"""Replace the shared library only, retaining Bookworm layout and honest metadata."""

import hashlib
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

BUILD = Path('/build')
SOURCE = BUILD / 'sqlite3-3.54.1'
INSTALLED = BUILD / 'sqlite-installed/usr/lib/x86_64-linux-gnu'
VERSION = '3.54.1-1+opsreplay1'
ORIGINAL = '3.40.1-2+deb12u2'
PACKAGE = 'libsqlite3-0'


def run(*args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=60, **kwargs)
    if result.returncode:
        raise RuntimeError('SQLite packaging failed: ' + args[0] + '\n' + result.stderr[-8192:])
    return result.stdout.strip()


def symbols(path):
    return {line.split()[-1] for line in run('nm', '-D', '--defined-only', str(path)).splitlines() if line.split()}


if run('dpkg-query', '-W', '-f=${Version}', PACKAGE) != ORIGINAL:
    raise ValueError('Unexpected original SQLite package')
archive = BUILD / 'sqlite-original'
archive.mkdir()
run('apt-get', 'download', PACKAGE + '=' + ORIGINAL, cwd=archive)
packages = list(archive.glob('*.deb'))
if len(packages) != 1:
    raise ValueError('Expected one original SQLite archive')
target = BUILD / 'sqlite-package'
run('dpkg-deb', '--extract', str(packages[0]), str(target))
run('dpkg-deb', '--control', str(packages[0]), str(target / 'DEBIAN'))
originals = [path for path in target.rglob('libsqlite3.so.0.*') if path.is_file() and not path.is_symlink()]
replacement = (INSTALLED / 'libsqlite3.so.0').resolve(strict=True)
if len(originals) != 1 or replacement.parent != INSTALLED or not replacement.is_file():
    raise ValueError('Expected one original and one replacement shared object')
original = originals[0]
original_symbols, replacement_symbols = symbols(original), symbols(replacement)
public = re.compile(r'^sqlite3(?:_|session_|changeset_|changegroup_|rebaser_)')
public_symbols = {name for name in original_symbols if public.match(name)}
if not {'sqlite3_open', 'sqlite3_close', 'sqlite3session_create'}.issubset(public_symbols):
    raise ValueError('Original SQLite API inventory is incomplete')
if not public_symbols.issubset(replacement_symbols):
    raise ValueError('SQLite replacement lost documented ABI symbols')
if not re.search(r'SONAME.*\[libsqlite3\.so\.0\]', run('readelf', '-d', str(replacement))):
    raise ValueError('SQLite SONAME changed')
mode = stat.S_IMODE(original.stat().st_mode)
shutil.copyfile(replacement, original)
os.chmod(original, mode)
doc = target / 'usr/share/doc' / PACKAGE
doc.mkdir(parents=True, exist_ok=True)
shutil.copyfile(SOURCE / 'debian/copyright', doc / 'copyright.sqlite3-fixed-source')
shutil.copyfile(BUILD / 'sqlite3_3.54.1-1.dsc', doc / 'source.dsc')
for name in ('build-sqlite-security.sh', 'repack-sqlite.py'):
    shutil.copyfile(BUILD / 'security' / name, doc / name)
(doc / 'opsreplay-rebuild.txt').write_text(
    f'Debian source: 3.54.1-1\nBookworm rebuild: {VERSION}\nOriginal package: {ORIGINAL}\n'
)
(doc / 'removed-private-symbols.txt').write_text('\n'.join(sorted(original_symbols - replacement_symbols)) + '\n')
control = target / 'DEBIAN/control'
text = re.sub(r'^Version: .*', 'Version: ' + VERSION, control.read_text(), flags=re.M)
text = re.sub(r'^(?:Source|Origin): .*\n', '', text, flags=re.M)
text += f'Source: sqlite3 ({VERSION})\nOrigin: OpsReplay local rebuild\n'
dependencies = run('dpkg-shlibdeps', '-O', '-x' + PACKAGE, '-e' + str(original), cwd=SOURCE)
generated = dict(line.split('=', 1) for line in dependencies.splitlines() if '=' in line).get('shlibs:Depends', '')
if not generated:
    raise ValueError('SQLite runtime dependencies were not derived')
existing = re.search(r'^Depends: (.*)$', text, flags=re.M)
if not existing:
    raise ValueError('Original SQLite dependencies are missing')
combined = ', '.join(dict.fromkeys((existing.group(1) + ', ' + generated).split(', ')))
text = re.sub(r'^Depends: .*', 'Depends: ' + combined, text, flags=re.M)
size = sum(path.stat().st_size for path in target.rglob('*')
           if path.is_file() and 'DEBIAN' not in path.relative_to(target).parts)
text = re.sub(r'^Installed-Size: .*', 'Installed-Size: ' + str((size + 1023) // 1024), text, flags=re.M)
control.write_text(text)
shlibs = target / 'DEBIAN/shlibs'
shlibs.write_text(re.sub(r'\(>= [^)]+\)', '(>= ' + VERSION + ')', shlibs.read_text()))
# Debian's non-amalgamated builds expose implementation symbols. Retain every
# documented API, but regenerate removed internal entries as Debian 3.54.1 does.
inventory = target / 'DEBIAN/symbols'
inventory.write_text(''.join(line for line in inventory.read_text().splitlines(keepends=True)
                             if not line.startswith(' ') or line.split()[0].split('@')[0] in replacement_symbols))
run('dpkg-gensymbols', '-p' + PACKAGE, '-v' + VERSION, '-P' + str(target), '-c1',
    '-I' + str(target / 'DEBIAN/symbols'), '-e' + str(original), cwd=SOURCE)
hashes, retain = [], set()
for path in sorted(target.rglob('*')):
    relative = path.relative_to(target)
    if path.is_symlink() or not path.is_file() or 'DEBIAN' in relative.parts:
        continue
    hashes.append(hashlib.md5(path.read_bytes()).hexdigest() + '  ' + str(relative))
    absolute = Path('/') / relative
    retain.add(str(absolute))
    retain.update(str(parent) for parent in absolute.parents if str(parent) != '/')
(target / 'DEBIAN/md5sums').write_text('\n'.join(hashes) + '\n')
(BUILD / 'sqlite-retain-files.conf').write_text(''.join('path-include ' + path + '\n' for path in sorted(retain)))
run('dpkg-deb', '--root-owner-group', '--build', str(target), str(BUILD / 'libsqlite3-0-security.deb'))
