"""Ordinary SQLite operations in the hosted Challenge image. No exploit fixtures."""

import ctypes
import json
import sqlite3
import subprocess
import tempfile
from pathlib import Path

assert sqlite3.sqlite_version == '3.54.1'
assert sqlite3.threadsafety == 3
connection = sqlite3.connect(':memory:')
options = {row[0] for row in connection.execute('PRAGMA compile_options')}
assert {
    'ENABLE_COLUMN_METADATA', 'ENABLE_FTS3', 'ENABLE_FTS3_PARENTHESIS',
    'ENABLE_FTS4', 'ENABLE_FTS5', 'ENABLE_RTREE', 'ENABLE_UNLOCK_NOTIFY',
    'ENABLE_DBSTAT_VTAB', 'ENABLE_PREUPDATE_HOOK', 'ENABLE_SESSION',
    'ENABLE_STMTVTAB', 'ENABLE_UPDATE_DELETE_LIMIT', 'THREADSAFE=1',
    'MAX_VARIABLE_NUMBER=250000',
}.issubset(options)
source_id = connection.execute('SELECT sqlite_source_id()').fetchone()[0]
assert isinstance(source_id, str) and len(source_id) >= 40
connection.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, value BLOB)')
connection.execute('INSERT INTO notes VALUES (?, ?, ?)', (1, 'normal café', b'\x00\x01'))
connection.commit()
connection.execute('UPDATE notes SET body = ? WHERE id = ?', ('temporary', 1))
connection.rollback()
assert connection.execute('SELECT body, value FROM notes').fetchone() == ('normal café', b'\x00\x01')
assert connection.execute('SELECT json_extract(?, ?)', ('{"count":2}', '$.count')).fetchone()[0] == 2
connection.execute('CREATE VIRTUAL TABLE search USING fts5(body, detail=none, prefix=2)')
connection.execute('INSERT INTO search(body) VALUES (?)', ('ordinary investigation',))
assert connection.execute('SELECT count(*) FROM search WHERE search MATCH ?', ('ordinary*',)).fetchone()[0] == 1
connection.execute('CREATE VIRTUAL TABLE positions USING rtree(id, min_x, max_x)')
connection.execute('INSERT INTO positions VALUES (1, 0, 10)')
assert connection.execute('SELECT id FROM positions WHERE min_x <= 5 AND max_x >= 5').fetchone() == (1,)
connection.commit()
with tempfile.TemporaryDirectory(prefix='opsreplay-sqlite-') as directory:
    path = Path(directory) / 'ordinary.db'
    disk = sqlite3.connect(path)
    connection.backup(disk)
    assert disk.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    disk.close()
    disk = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    assert disk.execute('SELECT body FROM notes').fetchone()[0] == 'normal café'
    disk.close()
connection.close()

# Exercise the retained session extension with a normal changeset.
library = ctypes.CDLL('libsqlite3.so.0')
pointer = ctypes.c_void_p
library.sqlite3_open.argtypes = [ctypes.c_char_p, ctypes.POINTER(pointer)]
library.sqlite3_open.restype = ctypes.c_int
library.sqlite3_exec.argtypes = [pointer, ctypes.c_char_p, pointer, pointer, pointer]
library.sqlite3_exec.restype = ctypes.c_int
library.sqlite3_close.argtypes = [pointer]
library.sqlite3_close.restype = ctypes.c_int
library.sqlite3session_create.argtypes = [pointer, ctypes.c_char_p, ctypes.POINTER(pointer)]
library.sqlite3session_create.restype = ctypes.c_int
library.sqlite3session_attach.argtypes = [pointer, ctypes.c_char_p]
library.sqlite3session_attach.restype = ctypes.c_int
library.sqlite3session_changeset.argtypes = [pointer, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(pointer)]
library.sqlite3session_changeset.restype = ctypes.c_int
library.sqlite3session_delete.argtypes = [pointer]
library.sqlite3session_delete.restype = None
library.sqlite3changeset_apply.argtypes = [pointer, ctypes.c_int, pointer, pointer, pointer, pointer]
library.sqlite3changeset_apply.restype = ctypes.c_int
library.sqlite3_prepare_v2.argtypes = [pointer, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(pointer), pointer]
library.sqlite3_prepare_v2.restype = ctypes.c_int
library.sqlite3_step.argtypes = [pointer]
library.sqlite3_step.restype = ctypes.c_int
library.sqlite3_column_text.argtypes = [pointer, ctypes.c_int]
library.sqlite3_column_text.restype = ctypes.c_char_p
library.sqlite3_finalize.argtypes = [pointer]
library.sqlite3_finalize.restype = ctypes.c_int
library.sqlite3_free.argtypes = [pointer]
library.sqlite3_free.restype = None
database, destination, statement, session, changeset = pointer(), pointer(), pointer(), pointer(), pointer()
try:
    assert library.sqlite3_open(b':memory:', ctypes.byref(database)) == 0
    assert library.sqlite3_exec(database, b'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)', None, None, None) == 0
    assert library.sqlite3session_create(database, b'main', ctypes.byref(session)) == 0
    assert library.sqlite3session_attach(session, b'items') == 0
    assert library.sqlite3_exec(database, b"INSERT INTO items VALUES (1, 'normal')", None, None, None) == 0
    size = ctypes.c_int()
    assert library.sqlite3session_changeset(session, ctypes.byref(size), ctypes.byref(changeset)) == 0
    assert size.value > 0 and changeset.value
    assert library.sqlite3_open(b':memory:', ctypes.byref(destination)) == 0
    assert library.sqlite3_exec(destination, b'CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)', None, None, None) == 0
    assert library.sqlite3changeset_apply(destination, size.value, changeset, None, None, None) == 0
    assert library.sqlite3_prepare_v2(destination, b'SELECT value FROM items WHERE id = 1', -1, ctypes.byref(statement), None) == 0
    assert library.sqlite3_step(statement) == 100
    assert library.sqlite3_column_text(statement, 0) == b'normal'
finally:
    if statement.value:
        assert library.sqlite3_finalize(statement) == 0
    if destination.value:
        assert library.sqlite3_close(destination) == 0
    if changeset.value:
        library.sqlite3_free(changeset)
    if session.value:
        library.sqlite3session_delete(session)
    if database.value:
        assert library.sqlite3_close(database) == 0

version = subprocess.check_output(['dpkg-query', '-W', '-f=${Version}', 'libsqlite3-0'], text=True)
assert version == '3.54.1-1+opsreplay1'
subprocess.run(['md5sum', '-c', '/var/lib/dpkg/info/libsqlite3-0:amd64.md5sums'],
               cwd='/', check=True, capture_output=True, timeout=30)
assert Path('/usr/share/doc/libsqlite3-0/source.dsc').is_file()
print(json.dumps({'runtimeVersion': sqlite3.sqlite_version, 'sourceId': source_id, 'packageVersion': version,
                  'ordinaryQueries': True, 'sessionChangeset': True, 'packageHashes': True}))
