"""Verify markers from the actual private terminal and its root Bash PTY."""

import base64
import json
import re
import socket
import time

socket.setdefaulttimeout(5)
connection = socket.create_connection(("127.0.0.1", 7681))
stream = connection.makefile("rb")


def send(frame):
    connection.sendall(json.dumps(frame).encode() + b"\n")


def receive():
    return json.loads(stream.readline(24 * 1024))


def until_prompt():
    output = bytearray()
    deadline = time.monotonic() + 5
    while b"\x1b]133;B\x07" not in output:
        assert time.monotonic() < deadline, "missing prompt marker"
        frame = receive()
        if frame["type"] == "output":
            output.extend(base64.b64decode(frame["data"], validate=True))
        else:
            assert frame["type"] == "input_accepted", frame
    return bytes(output)


def submit(command):
    send({"type": "input", "generation": 1, "data": base64.b64encode(command.encode()).decode()})
    return until_prompt()


def markers(output):
    starts = re.findall(rb"\x1b\]133;C;([A-Za-z0-9+/=]*)\x07", output)
    ends = re.findall(rb"\x1b\]133;D;([0-9]+)\x07", output)
    return [base64.b64decode(value, validate=True).decode() for value in starts], [int(value) for value in ends]


send({"type": "attach", "version": 1, "mode": "interactive", "generation": 1, "columns": 80, "rows": 24})
assert receive()["type"] == "ready"
until_prompt()

for command, status in [("false", 1), ("true", 0), ("printf 'one\\n'; printf 'two\\n'", 0)]:
    output = submit(command + "\n")
    assert markers(output) == ([command], [status]), repr(output)

output = submit("printf 'previous=%s\\n' \"$?\"\n")
assert b"previous=0\r\n" in output
submit("false\n")
output = submit("printf 'previous=%s\\n' \"$?\"\n")
assert b"previous=1\r\n" in output, repr(output)

output = submit("for word in alpha beta; do\nprintf '%s\\n' \"$word\"\ndone\n")
starts, ends = markers(output)
assert len(starts) == 1 and ends == [0], repr(output)
assert "for word in alpha beta" in starts[0] and "done" in starts[0]
assert b"alpha\r\nbeta\r\n" in output

# Input consumed by a program must not create a second top-level command.
send({"type": "input", "generation": 1, "data": base64.b64encode(b"read -r answer; printf 'answer=%s\\n' \"$answer\"\n").decode()})
output = bytearray()
while b"\x1b]133;C;" not in output:
    frame = receive()
    if frame["type"] == "output":
        output.extend(base64.b64decode(frame["data"], validate=True))
send({"type": "input", "generation": 1, "data": base64.b64encode(b"inside-program\n").decode()})
output.extend(until_prompt())
assert len(markers(output)[0]) == 1 and markers(output)[1] == [0]
assert b"answer=inside-program\r\n" in output

# Marker text is bounded before UTF-8/base64 expansion, not by shell input size.
command = ": " + "x" * 5000
output = submit(command + "\n")
assert markers(output) == ([command[:4000]], [0])
assert b"\x1b]133;T\x07" in output
command = ": " + "é" * 4100
output = submit(command + "\n")
assert markers(output) == ([command[:4000]], [0])
assert b"\x1b]133;T\x07" in output

# History prefixes must not remove learner whitespace or reuse the previous command.
command = "  printf 'unicode=é\\n'"
output = submit(command + "\n")
assert markers(output) == ([command], [0]), repr(output)
assert b"unicode=\xc3\xa9\r\n" in output

stream.close()
connection.close()
print("Real-PTY command markers passed.")
