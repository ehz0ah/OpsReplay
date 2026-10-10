"""Exercise the private terminal protocol from inside a Challenge container."""

import base64
import errno
import importlib.machinery
import importlib.util
import json
import os
import select
import socket
import sys
import time
from unittest import mock


PORT = 7681
MAX_LINE_BYTES = 24 * 1024
MAX_REPLAY_BYTES = 64 * 1024
SERVER_PATH = "/usr/local/bin/opsreplay-terminal-server"


def verify_terminal_helpers():
    loader = importlib.machinery.SourceFileLoader("opsreplay_terminal_server", SERVER_PATH)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    with mock.patch.object(module.os, "read", side_effect=BlockingIOError(errno.EAGAIN, "try again")):
        assert module.read_master(0) is None

    state = module.TerminalState.__new__(module.TerminalState)
    state.lock = module.threading.RLock()
    state.output_condition = module.threading.Condition(state.lock)
    state.stopping = module.threading.Event()
    state.pending_output = module.collections.deque()
    state.pending_output_bytes = 0
    chunk = b"x" * module.MAX_OUTPUT_BYTES
    for _ in range(module.MAX_PENDING_OUTPUT_FRAMES):
        assert state._queue_output(("output", chunk), len(chunk))
    queued = module.threading.Event()

    def queue_one_more():
        state._queue_output(("output", b"x"), 1)
        queued.set()

    producer = module.threading.Thread(target=queue_one_more)
    producer.start()
    assert not queued.wait(0.1), "output queue exceeded its frame or byte bound"
    with state.output_condition:
        _, byte_count = state.pending_output.popleft()
        state.pending_output_bytes -= byte_count
        state.output_condition.notify_all()
    assert queued.wait(1), "output producer did not resume after queue capacity became available"
    producer.join(timeout=1)

    class FailedConnection:
        def __init__(self):
            self.closed = False

        def send(self, _frame):
            return False

        def close(self):
            self.closed = True

    failed = FailedConnection()
    state.active = failed
    state.active_ready = True
    state.generation = 1
    state.replay = bytearray()
    state.replay_truncated = False
    state._deliver_output(b"uncertain-output")
    assert failed.closed
    assert state.active is None
    assert state.replay == b"uncertain-output"
    assert state.replay_truncated is True

    class RecordingConnection:
        def __init__(self):
            self.frames = []
            self.closed = False

        def send(self, frame):
            self.frames.append(frame)
            return True

        def close(self):
            self.closed = True

    exit_state = module.TerminalState.__new__(module.TerminalState)
    exit_state.lock = module.threading.RLock()
    exit_state.output_condition = module.threading.Condition(exit_state.lock)
    exit_state.stopping = module.threading.Event()
    exit_state.pending_output = module.collections.deque()
    exit_state.pending_output_bytes = 0
    exit_state.replay = bytearray()
    exit_state.replay_truncated = False
    exit_state.generation = 2
    exit_state.shell_exit_code = 7
    exit_state.shell_exited = module.threading.Event()
    active = RecordingConnection()
    exit_state.active = active
    exit_state.active_ready = True
    tail = b"tail-before-exit"
    exit_state.pending_output.extend([(("output", tail), len(tail)), (("exit", 7), 0)])
    exit_state.pending_output_bytes = len(tail)

    assert exit_state.heartbeat(active, 2) is module.SHELL_EXIT_PENDING
    exit_waited = module.threading.Event()

    def wait_for_exit():
        exit_state.wait_for_exit_delivery()
        exit_waited.set()

    exit_waiter = module.threading.Thread(target=wait_for_exit)
    exit_waiter.start()
    assert not exit_waited.wait(0.1), "operation did not wait for queued terminal exit"
    exit_sender = module.threading.Thread(target=exit_state._send_output)
    exit_sender.start()
    assert exit_waited.wait(1), "operation did not resume after terminal exit delivery"
    exit_waiter.join(timeout=1)
    exit_sender.join(timeout=1)
    assert not exit_waiter.is_alive()
    assert not exit_sender.is_alive()
    assert [frame["type"] for frame in active.frames] == ["output", "exit"], active.frames
    assert base64.b64decode(active.frames[0]["data"], validate=True) == tail
    assert active.frames[1] == {"type": "exit", "code": 7}
    assert active.closed


class TerminalClient:
    def __init__(self, receive_buffer_bytes=None):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if receive_buffer_bytes is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, receive_buffer_bytes)
        self.socket.settimeout(2)
        self.socket.connect(("127.0.0.1", PORT))
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


def attach(generation, columns=80, rows=24, receive_buffer_bytes=None):
    client = TerminalClient(receive_buffer_bytes)
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


def receive_slow_command(client, generation, command, expected, expected_zero_bytes):
    client.send(
        {
            "type": "input",
            "generation": generation,
            "data": base64.b64encode(command).decode("ascii"),
        }
    )
    deadline = time.monotonic() + 20
    accepted = False
    zero_bytes = 0
    output_tail = bytearray()
    while not accepted or expected not in output_tail:
        frame = client.receive(max(0.01, deadline - time.monotonic()))
        if frame["type"] == "output":
            data = base64.b64decode(frame["data"], validate=True)
            zero_bytes += data.count(b"\0")
            output_tail.extend(data)
            del output_tail[: max(0, len(output_tail) - 4096)]
            time.sleep(0.005)
        elif frame == {"type": "input_accepted", "generation": generation}:
            accepted = True
    assert zero_bytes == expected_zero_bytes, zero_bytes


def wait_for_path(path, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {path}")


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
    tail = b"tail-before-shell-exit"
    encoded_tail = base64.b64encode(tail).decode("ascii")
    exit_command = (
        "sleep 300 & printf '%s' '"
        + encoded_tail
        + "' | base64 -d; printf '\\n'; exit 7\n"
    ).encode("ascii")
    client.send(
        {
            "type": "input",
            "generation": 1,
            "data": base64.b64encode(exit_command).decode("ascii"),
        }
    )
    client.send({"type": "heartbeat", "generation": 1})
    exited = False
    output = bytearray()
    while not exited:
        frame = client.receive()
        assert frame["type"] != "error", frame
        if frame["type"] == "output":
            output.extend(base64.b64decode(frame["data"], validate=True))
        exited = exited or (frame["type"] == "exit" and frame["code"] == 7)
    assert tail in output, output
    client.close()
    print("terminal shell-exit check passed")


def main():
    verify_terminal_helpers()
    if sys.argv[1] == "shell-exit":
        shell_exit()
        return

    secret = sys.argv[1].encode("ascii")
    encoded_secret = base64.b64encode(secret).decode("ascii")

    first, ready = attach(1)
    assert ready["resumed"] is False, ready
    assert ready["replayTruncated"] is False, ready

    delayed_start = b"delayed-start-" + secret + b"|"
    encoded_delayed_start = base64.b64encode(delayed_start).decode("ascii")
    delayed_command = (
        "export OPSREPLAY_RECONNECT_VALUE=$(printf '%s' '"
        + encoded_secret
        + "' | base64 -d); printf '%s' '"
        + encoded_delayed_start
        + "' | base64 -d; sleep 0.4; "
        + "printf '%s\\n' \"$OPSREPLAY_RECONNECT_VALUE\"\n"
    ).encode("ascii")
    send_input(first, 1, delayed_command, delayed_start)
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
    assert ready["replayTruncated"] is True, ready
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

    slow_bytes = 4 * 1024 * 1024
    slow_end = b"slow-output-complete-" + secret
    encoded_slow_end = base64.b64encode(slow_end).decode("ascii")
    seventh, _ = attach(7, receive_buffer_bytes=4096)
    slow_command = (
        f"head -c {slow_bytes} /dev/zero; "
        f"printf '%s' '{encoded_slow_end}' | base64 -d; printf '\\n'\n"
    ).encode("ascii")
    receive_slow_command(seventh, 7, slow_command, slow_end, slow_bytes)
    seventh.send({"type": "heartbeat", "generation": 7})
    heartbeat = receive_matching(seventh, lambda frame: frame["type"] == "heartbeat")
    assert heartbeat == {"type": "heartbeat", "generation": 7}
    seventh.close()

    stalled_end = b"stalled-output-complete-" + secret
    encoded_stalled_end = base64.b64encode(stalled_end).decode("ascii")
    stalled_marker = f"/tmp/opsreplay-terminal-stalled-{secret.decode('ascii')}"
    try:
        os.unlink(stalled_marker)
    except FileNotFoundError:
        pass
    eighth, _ = attach(8, receive_buffer_bytes=4096)
    stalled_command = (
        "head -c 16777216 /dev/zero; "
        f"printf '%s' '{encoded_stalled_end}' | base64 -d; "
        f"touch '{stalled_marker}'\n"
    ).encode("ascii")
    eighth.send(
        {
            "type": "input",
            "generation": 8,
            "data": base64.b64encode(stalled_command).decode("ascii"),
        }
    )
    while eighth.receive()["type"] != "input_accepted":
        pass
    time.sleep(0.2)
    assert not os.path.exists(stalled_marker), "PTY output did not backpressure the command"
    wait_for_path(stalled_marker)

    ninth, ready = attach(9)
    assert ready["replayTruncated"] is True, ready
    receive_output(ninth, stalled_end)
    ninth.send({"type": "heartbeat", "generation": 9})
    heartbeat = receive_matching(ninth, lambda frame: frame["type"] == "heartbeat")
    assert heartbeat == {"type": "heartbeat", "generation": 9}
    eighth.close()
    ninth.close()
    os.unlink(stalled_marker)

    print("terminal protocol checks passed")


if __name__ == "__main__":
    main()
