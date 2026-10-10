"""Exercise the private terminal protocol from inside a Challenge container."""

import base64
import errno
import importlib.machinery
import importlib.util
import json
import select
import socket
import sys
import time
from unittest import mock


PORT = 7681
MAX_LINE_BYTES = 24 * 1024
MAX_REPLAY_BYTES = 64 * 1024
SERVER_PATH = "/usr/local/bin/opsreplay-terminal-server"


def verify_nonblocking_read():
    loader = importlib.machinery.SourceFileLoader("opsreplay_terminal_server", SERVER_PATH)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    with mock.patch.object(module.os, "read", side_effect=BlockingIOError(errno.EAGAIN, "try again")):
        assert module.read_master(0) is None


class TerminalClient:
    def __init__(self):
        self.socket = socket.create_connection(("127.0.0.1", PORT), timeout=2)
        self.socket.setblocking(False)
        self.buffer = bytearray()

    def close(self):
        self.socket.close()

    def send(self, frame):
        self.send_raw(json.dumps(frame, separators=(",", ":")).encode("utf-8") + b"\n")

    def send_raw(self, payload):
        self.socket.setblocking(True)
        try:
            self.socket.sendall(payload)
        finally:
            self.socket.setblocking(False)

    def receive(self, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            newline = self.buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self.buffer[:newline])
                del self.buffer[: newline + 1]
                return json.loads(line)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("timed out waiting for a terminal frame")
            readable, _, _ = select.select([self.socket], [], [], remaining)
            if not readable:
                raise AssertionError("timed out waiting for a terminal frame")
            chunk = self.socket.recv(4096)
            if not chunk:
                raise AssertionError("terminal connection closed before the expected frame")
            self.buffer.extend(chunk)


def attach(generation, columns=80, rows=24):
    client = TerminalClient()
    client.send(
        {
            "type": "attach",
            "version": 1,
            "mode": "interactive",
            "generation": generation,
            "columns": columns,
            "rows": rows,
        }
    )
    ready = client.receive()
    assert ready["type"] == "ready", ready
    assert ready["generation"] == generation, ready
    return client, ready


def receive_error(client, code):
    frame = receive_matching(client, lambda candidate: candidate["type"] == "error")
    assert frame == {"type": "error", "code": code}, frame


def receive_matching(client, predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while True:
        frame = client.receive(max(0.01, deadline - time.monotonic()))
        if predicate(frame):
            return frame


def receive_output(client, expected, timeout=5):
    deadline = time.monotonic() + timeout
    output = bytearray()
    frames = []
    while expected not in output:
        frame = client.receive(max(0.01, deadline - time.monotonic()))
        frames.append(frame)
        if frame["type"] == "output":
            output.extend(base64.b64decode(frame["data"], validate=True))
        if time.monotonic() >= deadline and expected not in output:
            raise AssertionError(f"terminal output did not contain {expected!r}")
    return bytes(output), frames


def send_input(client, generation, command, expected):
    client.send(
        {
            "type": "input",
            "generation": generation,
            "data": base64.b64encode(command).decode("ascii"),
        }
    )
    deadline = time.monotonic() + 5
    output = bytearray()
    accepted = False
    while expected not in output or not accepted:
        frame = client.receive(max(0.01, deadline - time.monotonic()))
        if frame["type"] == "output":
            output.extend(base64.b64decode(frame["data"], validate=True))
        elif frame == {"type": "input_accepted", "generation": generation}:
            accepted = True
    return bytes(output)


def rejected_attach(payload, code="INVALID_FRAME"):
    client = TerminalClient()
    if isinstance(payload, bytes):
        client.send_raw(payload)
    else:
        client.send(payload)
    receive_error(client, code)
    client.close()


def shell_exit():
    client, _ = attach(1)
    client.send(
        {
            "type": "input",
            "generation": 1,
            "data": base64.b64encode(b"sleep 300 & exit\n").decode("ascii"),
        }
    )
    exited = False
    while not exited:
        frame = client.receive()
        exited = exited or (frame["type"] == "exit" and frame["code"] == 0)
    client.close()
    print("terminal shell-exit check passed")


def main():
    verify_nonblocking_read()
    if sys.argv[1] == "shell-exit":
        shell_exit()
        return

    secret = sys.argv[1].encode("ascii")
    encoded_secret = base64.b64encode(secret).decode("ascii")

    first, ready = attach(1)
    assert ready["resumed"] is False, ready
    assert ready["replayTruncated"] is False, ready

    delayed_command = (
        "export OPSREPLAY_RECONNECT_VALUE=$(printf '%s' '"
        + encoded_secret
        + "' | base64 -d); sleep 0.4; printf '%s\\n' \"$OPSREPLAY_RECONNECT_VALUE\"\n"
    ).encode("ascii")
    first.send(
        {
            "type": "input",
            "generation": 1,
            "data": base64.b64encode(delayed_command).decode("ascii"),
        }
    )
    while first.receive()["type"] != "input_accepted":
        pass
    first.close()
    time.sleep(0.7)

    second, ready = attach(2, columns=90, rows=30)
    assert ready["resumed"] is True, ready
    assert ready["replayTruncated"] is False, ready
    receive_output(second, secret)
    send_input(second, 2, b"printf '%s\\n' \"$OPSREPLAY_RECONNECT_VALUE\"\n", secret)

    second.send({"type": "resize", "generation": 2, "columns": 91, "rows": 37})
    resize = receive_matching(second, lambda frame: frame["type"] == "resize_accepted")
    assert resize == {"type": "resize_accepted", "generation": 2}
    send_input(second, 2, b"stty size\n", b"37 91")

    replay_end = b"replay-" + secret
    encoded_end = base64.b64encode(replay_end).decode("ascii")
    large_command = (
        "sleep 0.3; head -c 70000 /dev/zero | tr '\\0' x; printf '%s' '"
        + encoded_end
        + "' | base64 -d; printf '\\n'\n"
    ).encode("ascii")
    second.send(
        {
            "type": "input",
            "generation": 2,
            "data": base64.b64encode(large_command).decode("ascii"),
        }
    )
    while second.receive()["type"] != "input_accepted":
        pass
    second.close()
    time.sleep(0.8)

    third, ready = attach(3)
    assert ready["replayTruncated"] is True, ready
    replay, _ = receive_output(third, replay_end)
    assert len(replay) <= MAX_REPLAY_BYTES, len(replay)

    fourth, ready = attach(4)
    assert ready["resumed"] is True, ready
    receive_error(third, "REPLACED")
    third.close()

    stale = TerminalClient()
    stale.send(
        {
            "type": "attach",
            "version": 1,
            "mode": "interactive",
            "generation": 3,
            "columns": 80,
            "rows": 24,
        }
    )
    receive_error(stale, "STALE_GENERATION")
    stale.close()

    rejected_attach(
        {
            "type": "attach",
            "version": True,
            "mode": "interactive",
            "generation": 5,
            "columns": 80,
            "rows": 24,
        }
    )
    rejected_attach(
        b'{"type":"attach","type":"attach","version":1,"mode":"interactive",'
        b'"generation":5,"columns":80,"rows":24}\n'
    )
    rejected_attach(b"x" * MAX_LINE_BYTES + b"\n", "FRAME_TOO_LARGE")

    fourth.send({"type": "input", "generation": 3, "data": "YQ=="})
    receive_error(fourth, "STALE_GENERATION")
    fourth.close()

    fifth, _ = attach(5)
    fifth.send(
        {
            "type": "input",
            "generation": 5,
            "data": base64.b64encode(b"x" * (16 * 1024 + 1)).decode("ascii"),
        }
    )
    receive_error(fifth, "INVALID_FRAME")
    fifth.close()

    sixth, _ = attach(6)
    send_input(sixth, 6, b"\x04", b'Use "exit" to leave the shell')
    sixth.send({"type": "heartbeat", "generation": 6})
    heartbeat = receive_matching(sixth, lambda frame: frame["type"] == "heartbeat")
    assert heartbeat == {"type": "heartbeat", "generation": 6}
    sixth.close()

    print("terminal protocol checks passed")


if __name__ == "__main__":
    main()
