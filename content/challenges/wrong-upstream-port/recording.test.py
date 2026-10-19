"""Real private TCP/PTY checks and fault injection. Run inside the built image."""

import base64
import importlib.machinery
import importlib.util
import json
import os
import pty
import socket
import subprocess
import sys
import threading
import time
from unittest import mock

sys.path.insert(0, "/usr/local/bin")
import opsreplay_terminal_recording as recording

loader = importlib.machinery.SourceFileLoader("terminal", "/usr/local/bin/opsreplay-terminal-server")
spec = importlib.util.spec_from_loader(loader.name, loader)
terminal = importlib.util.module_from_spec(spec)
loader.exec_module(terminal)


class Client:
    def __init__(self):
        self.socket = socket.create_connection(("127.0.0.1", 7681), timeout=2)
        self.reader = self.socket.makefile("rb")

    def send(self, value):
        self.socket.sendall(recording.encode(value) + b"\n")

    def receive(self):
        data = self.reader.readline(recording.MAX_FRAME_BYTES + 1)
        assert data.endswith(b"\n") and len(data) <= recording.MAX_FRAME_BYTES
        return json.loads(data)

    def close(self):
        self.reader.close()
        self.socket.close()


def recorder():
    client = Client()
    client.send({"type": "attach", "version": 1, "mode": "recording"})
    ready = client.receive()
    assert ready["type"] == "recording_ready", ready
    return client, ready


def page(client, source, after):
    client.send({"type": "read", "source": source, "after": after})
    result = client.receive()
    assert result["type"] == "recording_page", result
    assert result["source"] == source
    assert result["nextSequence"] == after + len(result["events"])
    assert [event["sequence"] for event in result["events"]] == list(range(after + 1, result["nextSequence"] + 1))
    return result


def history(client, source, after=0):
    events = []
    while True:
        result = page(client, source, after)
        events.extend(result["events"])
        after = result["nextSequence"]
        if after == result["latestSequence"]:
            return events, result
        time.sleep(0.11)


def input_frame(client, generation, data):
    client.send({"type": "input", "generation": generation, "data": base64.b64encode(data).decode("ascii")})


def output_until(client, expected):
    output = bytearray()
    while expected not in output:
        frame = client.receive()
        assert frame["type"] != "error", frame
        if frame["type"] == "output":
            output.extend(base64.b64decode(frame["data"]))
    return output


def real_pty_tail_bound():
    # Keep a real slave open with queued bytes, then prove the shared tail cap
    # truncates observed data and still leaves one final exit after permanent loss.
    master, slave = pty.openpty()
    try:
        os.set_blocking(master, False)
        state = terminal.TerminalState.__new__(terminal.TerminalState)
        state.proposals = terminal.ProposalLedger()
        state.lock = threading.RLock()
        state.output_condition = threading.Condition(state.lock)
        state.stopping = threading.Event()
        state.pending_output = terminal.collections.deque()
        state.pending_output_bytes = 0
        state.child_exit_at = time.monotonic()
        state.exit_tail_bytes = terminal.MAX_EXIT_TAIL_BYTES - 3
        state.child_exit_detected = threading.Event()
        state.child_exit_detected.set()
        state.recording_finalized = threading.Event()
        state.shell_exit_code = None
        state.master_fd = master
        state.recording = recording.RecordingJournal()
        state.recording.append("dimensions", columns=80, rows=24)
        assert os.write(slave, b"tail") == 4
        assert terminal.select.select([master], [], [], 1)[0], "real PTY tail did not become readable"
        state._drain_output()
        state._finish_shell(7)
        events = state.recording.page(state.recording.source, 0)["events"]
        assert [event["type"] for event in events] == ["dimensions", "output", "exit"]
        assert base64.b64decode(events[1]["data"]) == b"tai"
        assert events[-1]["code"] == 7 and state.recording.shell_state == "exited"
        assert state.recording.loss["reason"] == "data_gap"
        assert events[-1]["recordedAt"] >= state.recording.loss["occurredAt"]
        assert os.read(master, 1) == b"l", "tail loss must leave a real unobserved byte"
        assert state.recording_finalized.is_set()
        return state.recording
    finally:
        os.close(master)
        os.close(slave)


def helpers():
    real_pty_tail_bound()
    # The exit reserve is inside both lifetime limits, including an exact byte fit.
    journal = recording.RecordingJournal()
    with mock.patch.object(journal, "timestamp", return_value=journal.started_at):
        boundary = len(recording.encode({"sequence": 1, "recordedAt": journal.started_at, "type": "dimensions", "columns": 80, "rows": 24}))
        with mock.patch.object(recording, "MAX_JOURNAL_BYTES", boundary + recording.MAX_EXIT_EVENT_BYTES):
            journal.append("dimensions", columns=80, rows=24)
            assert journal.loss is None and journal.byte_count == boundary
            journal.bytes_event("output", b"a")
            assert journal.loss["reason"] == "limit_exceeded"
            journal.finish(-255)
            assert journal.byte_count <= recording.MAX_JOURNAL_BYTES
    assert len(journal.events) == 2 and json.loads(journal.events[-1])["code"] == -255
    too_small = recording.RecordingJournal()
    with mock.patch.object(too_small, "timestamp", return_value=too_small.started_at), mock.patch.object(recording, "MAX_JOURNAL_BYTES", boundary + recording.MAX_EXIT_EVENT_BYTES - 1):
        too_small.append("dimensions", columns=80, rows=24)
        assert too_small.events == [] and too_small.loss["reason"] == "limit_exceeded"
        too_small.finish(255)
        assert too_small.byte_count <= recording.MAX_JOURNAL_BYTES
    journal = recording.RecordingJournal()
    with mock.patch.object(recording, "MAX_JOURNAL_EVENTS", 2):
        journal.append("dimensions", columns=80, rows=24)
        journal.append("dimensions", columns=80, rows=24)
        assert len(journal.events) == 1 and journal.loss["reason"] == "limit_exceeded"
        journal.finish(7)
        assert len(journal.events) == recording.MAX_JOURNAL_EVENTS
    # Preserve the first loss and exact prefix. Finalization adds only one exit,
    # with the next retained sequence, even after loss, and never resumes data.
    for reason in (None, "limit_exceeded", "data_gap"):
        journal = recording.RecordingJournal()
        journal.append("dimensions", columns=80, rows=24)
        if reason is not None:
            journal.mark_loss(reason)
            journal.mark_loss("data_gap")
        loss = dict(journal.loss) if journal.loss else None
        prefix = list(journal.events)
        if reason is not None:
            journal.bytes_event("input", b"ignored")
            journal.bytes_event("output", b"ignored")
            journal.append("dimensions", columns=90, rows=30)
            assert journal.events == prefix
        journal.finish(7)
        ended = list(journal.events)
        journal.finish(0)
        journal.bytes_event("output", b"ignored")
        journal.bytes_event("input", b"ignored")
        journal.append("dimensions", columns=90, rows=30)
        assert journal.events == ended and ended[:-1] == prefix
        assert journal.loss == loss and journal.shell_state == "exited"
        exit_event = json.loads(ended[-1])
        assert exit_event["type"] == "exit" and exit_event["code"] == 7
        assert exit_event["sequence"] == len(prefix) + 1
        if loss:
            assert exit_event["recordedAt"] >= loss["occurredAt"]
        assert journal.byte_count == sum(len(event) for event in journal.events)
    # Concurrent finalizers and a reader must never expose exited without exit.
    journal = recording.RecordingJournal()
    journal.append("dimensions", columns=80, rows=24)
    journal.mark_loss("data_gap")
    snapshots = []
    start = threading.Barrier(5)

    def finish_and_read():
        start.wait(timeout=2)
        journal.finish(7)
        snapshots.append(journal.page(journal.source, 0))

    threads = [threading.Thread(target=finish_and_read) for _ in range(4)]
    for thread in threads:
        thread.start()
    start.wait(timeout=2)
    for thread in threads:
        thread.join(2)
        assert not thread.is_alive()
    assert len(snapshots) == 4
    for snapshot in snapshots:
        assert snapshot["shellState"] == "exited"
        assert [event["type"] for event in snapshot["events"]] == ["dimensions", "exit"]
        assert snapshot["latestSequence"] == snapshot["nextSequence"] == 2
    # Maximum sequence and signed exit-code width fit the fixed reserve.
    for code in (-255, -1, 0, 255):
        assert len(recording.encode({"sequence": recording.MAX_JOURNAL_EVENTS, "recordedAt": "9999-12-31T23:59:59.999Z", "type": "exit", "code": code})) <= recording.MAX_EXIT_EVENT_BYTES
    journal = recording.RecordingJournal()
    journal.append("dimensions", columns=80, rows=24)
    for _ in range(102):
        journal.bytes_event("input", b"x" * terminal.MAX_INPUT_BYTES)
    result = journal.page(journal.source, 0)
    assert len(recording.encode(result)) + 1 <= recording.MAX_FRAME_BYTES
    assert result["nextSequence"] == 2  # Initial dimensions plus one maximal input.
    assert journal.page(journal.source, 0)["events"] == result["events"]
    journal = recording.RecordingJournal()
    for _ in range(101):
        journal.append("dimensions", columns=80, rows=24)
    assert len(journal.page(journal.source, 0)["events"]) == 100
    previous = journal.timestamp()
    with mock.patch.object(recording.time, "time_ns", return_value=0):
        assert journal.timestamp() >= previous
    with mock.patch.object(recording.time, "monotonic_ns", side_effect=[
        journal.monotonic_origin_ns + 123_000_000,
        journal.monotonic_origin_ns + 124_000_000,
    ]):
        journal.append("dimensions", columns=80, rows=24)
        snapshot = journal.ready()
    assert snapshot["observedAt"] > json.loads(journal.events[-1])["recordedAt"]
    for after in (len(journal.events) + 1,):
        try:
            journal.page(journal.source, after)
            assert False, "future cursor was accepted"
        except ValueError as error:
            assert str(error) == "INVALID_CURSOR"

    state = terminal.TerminalState.__new__(terminal.TerminalState)
    state.proposals = terminal.ProposalLedger()
    state.lock = threading.RLock()
    state.input_lock = threading.Lock()
    state.recording = recording.RecordingJournal()
    state.child_exit_detected = threading.Event()
    state.shell_exited = threading.Event()
    state.shell_exit_code = None
    state.master_fd = 0
    owner = object()
    state.active = owner
    state.generation = 1
    with mock.patch.object(terminal.select, "select", return_value=([], [0], [])), mock.patch.object(
        terminal.os, "write", side_effect=[BlockingIOError(), 2, OSError()]
    ):
        assert state.input(owner, 1, b"abcdef") == "INPUT_UNCERTAIN"
    assert len(state.recording.events) == 1
    assert base64.b64decode(json.loads(state.recording.events[0])["data"]) == b"ab"
    with mock.patch.object(state, "_set_size", side_effect=OSError()):
        assert state.resize(owner, 1, 90, 30) == "SHELL_EXITED"
    assert len(state.recording.events) == 1
    state.recording.shell_state = "exiting"
    with mock.patch.object(terminal.select, "select", return_value=([], [0], [])), mock.patch.object(terminal.os, "write") as write, mock.patch.object(state, "_set_size") as resize:
        assert state.input(owner, 1, b"a") is terminal.SHELL_EXIT_PENDING
        assert state.resize(owner, 1, 90, 30) is terminal.SHELL_EXIT_PENDING
        write.assert_not_called()
        resize.assert_not_called()
    state.recording.shell_state = "running"
    # The reader can drain output while input is waiting with input_lock held.
    state.input_lock.acquire()
    try:
        completed = threading.Event()
        with mock.patch.object(terminal, "read_master", return_value=b"drained"):
            thread = threading.Thread(target=lambda: (state._observe_output(), completed.set()))
            thread.start()
            assert completed.wait(1), "PTY reader waited on the input-operation lock"
            thread.join(1)
    finally:
        state.input_lock.release()
    assert json.loads(state.recording.events[-1])["type"] == "output"

    # Full live queue + an input thread waiting for writable PTY must still allow
    # a nonblocking PTY read and recorder snapshot to complete.
    state.output_condition = threading.Condition(state.lock)
    state.stopping = threading.Event()
    state.pending_output = terminal.collections.deque()
    state.pending_output_bytes = 0
    chunk = b"x" * terminal.MAX_OUTPUT_BYTES
    for _ in range(terminal.MAX_PENDING_OUTPUT_FRAMES):
        assert state._queue_output(("output", chunk), len(chunk))
    entered = threading.Event()
    release = threading.Event()
    observed = threading.Event()
    queued = threading.Event()

    def waiting_select(*_args):
        entered.set()
        assert release.wait(2)
        return [], [0], []

    def read_then_queue():
        state._observe_output()
        observed.set()
        state._queue_output(("output", b"drain"), 5)
        queued.set()

    with mock.patch.object(terminal.select, "select", side_effect=waiting_select), mock.patch.object(
        terminal.os, "write", return_value=1
    ), mock.patch.object(terminal, "read_master", return_value=b"drain"):
        written_results = []
        writer = threading.Thread(target=lambda: written_results.append(state.input(owner, 1, b"a")))
        writer.start()
        assert entered.wait(1)
        reader = threading.Thread(target=read_then_queue)
        reader.start()
        assert observed.wait(1), "reader could not drain PTY while input waited"
        state.recording.ready()
        release.set()
        writer.join(1)
        assert not writer.is_alive() and written_results == [None]
        assert not queued.is_set()
        with state.output_condition:
            _, size = state.pending_output.popleft()
            state.pending_output_bytes -= size
            state.output_condition.notify_all()
        assert queued.wait(1)
        reader.join(1)
        assert not reader.is_alive()

    # Once exit is known, full queue waiting has a fixed deadline and records loss.
    state.child_exit_at = time.monotonic() - terminal.EXIT_TAIL_SECONDS
    state.child_exit_detected.set()
    assert not state._queue_output(("output", chunk), len(chunk))
    assert state.recording.loss["reason"] == "data_gap"

    # A real blocked recording send holds neither the journal nor PTY operation lock.
    left, right = socket.socketpair()
    left.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
    connection = terminal.Connection(left)
    result = []
    blocked_frame = {"type": "recording_page", "data": "x" * 24000}
    started = time.monotonic()
    sender = threading.Thread(target=lambda: result.append(connection.send(blocked_frame)))
    sender.start()
    state.child_exit_detected.clear()
    with mock.patch.object(terminal, "read_master", return_value=b"still-drains"):
        assert state._observe_output() == b"still-drains"
    state.recording.ready()
    sender.join(2)
    assert result == [False] and time.monotonic() - started < 2
    connection.close()
    right.close()

    # All reads after detected exit share the same byte counter and deadline,
    # including a read racing the normal-loop exit check.
    state.child_exit_at = time.monotonic()
    state.exit_tail_bytes = terminal.MAX_EXIT_TAIL_BYTES - 3
    state.child_exit_detected.set()
    state.recording = recording.RecordingJournal()
    with mock.patch.object(terminal, "read_master", return_value=b"abc") as read:
        assert state._observe_output() == b"abc"
        read.assert_called_once_with(0, 3)
        assert state._observe_output() == b""
        assert read.call_count == 1
    assert state.recording.loss["reason"] == "data_gap"
    state.exit_tail_bytes = 0
    state.child_exit_at = time.monotonic() - terminal.EXIT_TAIL_SECONDS
    with mock.patch.object(terminal, "read_master") as read:
        assert state._observe_output() == b""
        read.assert_not_called()


def run():
    helpers()
    first, ready = recorder()
    second, second_ready = recorder()
    assert ready["source"] == second_ready["source"]
    initial = page(first, ready["source"], 0)
    assert initial["events"][0]["type"] == "dimensions"
    assert initial["events"][0]["columns"] == 80
    interactive = Client()
    interactive.send({"type": "attach", "version": 1, "mode": "interactive", "generation": 1, "columns": 93, "rows": 31})
    assert interactive.receive()["type"] == "ready"
    command = b"stty -echo; printf 'recording-start'; sleep 0.3; printf '\\001\\377recording-away'; printf '\\n'\n"
    input_frame(interactive, 1, command)
    output_until(interactive, b"recording-start")
    interactive.close()
    time.sleep(0.6)
    events, current = history(first, ready["source"])
    output = b"".join(base64.b64decode(event["data"]) for event in events if event["type"] == "output")
    assert b"\x01\xffrecording-away" in output
    assert b"".join(base64.b64decode(event["data"]) for event in events if event["type"] == "input") == command
    assert any(event["type"] == "dimensions" and event["columns"] == 93 for event in events)
    other, _ = history(second, ready["source"])
    assert other == events
    first.close()
    first, resumed = recorder()
    assert resumed["source"] == ready["source"]
    assert page(first, ready["source"], current["nextSequence"])["events"] == []
    interactive = Client()
    interactive.send({"type": "attach", "version": 1, "mode": "interactive", "generation": 2, "columns": 93, "rows": 31})
    assert interactive.receive()["type"] == "ready"
    input_frame(interactive, 2, b"stty size; printf 'reconnected-recording\\n'\n")
    observed = output_until(interactive, b"reconnected-recording")
    assert b"31 93" in observed
    # Recorders have not stolen ownership, changed generation, or resized the shell.
    interactive.send({"type": "heartbeat", "generation": 2})
    while interactive.receive()["type"] != "heartbeat":
        pass

    invalid = [
        ({"type": "read", "source": ready["source"], "after": -1}, "INVALID_FRAME"),
        ({"type": "read", "source": ready["source"], "after": True}, "INVALID_FRAME"),
        ({"type": "read", "source": ready["source"], "after": 2**53}, "INVALID_FRAME"),
        ({"type": "read", "source": ready["source"], "after": 100001}, "INVALID_CURSOR"),
        ({"type": "read", "source": "another-source", "after": 0}, "SOURCE_MISMATCH"),
        ({"type": "input", "generation": 2, "data": "YQ=="}, "INVALID_FRAME"),
        ({"type": "read", "source": ready["source"], "after": 0, "extra": True}, "INVALID_FRAME"),
    ]
    for request, code in invalid:
        rejected, _ = recorder()
        rejected.send(request)
        assert rejected.receive() == {"type": "error", "code": code}
        rejected.close()
    rejected, _ = recorder()
    rejected.socket.sendall(b'{"type":"read","type":"read","after":0,"source":"x"}\n')
    assert rejected.receive() == {"type": "error", "code": "INVALID_FRAME"}
    rejected.close()
    rejected, _ = recorder()
    rejected.socket.sendall(b"x" * 1024 + b"\n")
    assert rejected.receive() == {"type": "error", "code": "FRAME_TOO_LARGE"}
    rejected.close()
    rejected, _ = recorder()
    for _ in range(10):
        page(rejected, ready["source"], 0)
    rejected.send({"type": "read", "source": ready["source"], "after": 0})
    assert rejected.receive() == {"type": "error", "code": "RATE_LIMITED"}
    rejected.close()

    # Stop consuming one recording socket. Its send deadline must not block PTY work.
    stalled, _ = recorder()
    stalled.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    input_frame(interactive, 2, b"head -c 16000000 /dev/zero; touch /tmp/recording-overflow-done\n")
    interactive.close()
    deadline = time.monotonic() + 15
    while not os.path.exists("/tmp/recording-overflow-done"):
        assert time.monotonic() < deadline
        time.sleep(0.1)
    time.sleep(1.1)
    result = page(first, ready["source"], 0)
    assert result["loss"]["reason"] == "limit_exceeded"
    frozen = result["latestSequence"]
    interactive = Client()
    interactive.send({"type": "attach", "version": 1, "mode": "interactive", "generation": 3, "columns": 80, "rows": 24})
    assert interactive.receive()["type"] == "ready"
    input_frame(interactive, 3, b"printf 'usable-after-recording-limit\\n'\n")
    output_until(interactive, b"usable-after-recording-limit")
    time.sleep(0.11)
    assert page(first, ready["source"], frozen)["latestSequence"] == frozen
    input_frame(interactive, 3, b"exit 7\n")
    while interactive.receive()["type"] != "exit":
        pass
    time.sleep(0.11)
    final = page(first, ready["source"], frozen)
    assert final["shellState"] == "exited" and final["loss"] == result["loss"]
    assert final["latestSequence"] == frozen + 1
    assert len(final["events"]) == 1
    assert final["events"][0]["type"] == "exit" and final["events"][0]["code"] == 7
    time.sleep(0.11)
    assert page(first, ready["source"], frozen + 1)["events"] == []
    for client in (first, second, stalled, interactive):
        client.close()
    for path in ("/var/log/supervisor/terminal.log", "/var/log/supervisor/supervisord.log"):
        with open(path, encoding="utf-8") as log:
            assert "recording-away" not in log.read(), "raw terminal data leaked into logs"
    print("terminal recording checks passed")


def exit_case(mode="exit"):
    flood = mode == "flood"
    client, ready = recorder()
    interactive = Client()
    interactive.send({"type": "attach", "version": 1, "mode": "interactive", "generation": 1, "columns": 80, "rows": 24})
    assert interactive.receive()["type"] == "ready"
    command = b"(trap '' HUP; while :; do printf flood; done) & disown; exit 7\n" if flood else b"printf 'recording-exit-tail\\n'; exit 7\n"
    if mode == "quiet":
        command = b"sleep 300 & printf 'recording-exit-tail\\n'; exit 7\n"
    started = time.monotonic()
    input_frame(interactive, 1, command)
    while True:
        frame = interactive.receive()
        if frame["type"] == "exit":
            assert frame["code"] == 7
            break
    assert time.monotonic() - started < 8
    events, result = history(client, ready["source"])
    assert result["shellState"] == "exited"
    assert events[-1]["type"] == "exit" and events[-1]["code"] == 7
    assert sum(event["type"] == "exit" for event in events) == 1
    if flood:
        # A writer can pause before the limit. Empty-read finalization is valid;
        # the controlled real-PTY helper below proves actual bound loss.
        if result["loss"] is not None:
            assert result["loss"]["reason"] == "data_gap"
            assert events[-1]["recordedAt"] >= result["loss"]["occurredAt"]
            assert all(event["recordedAt"] <= result["loss"]["occurredAt"] for event in events[:-1])
    else:
        assert result["loss"] is None, result
        assert b"recording-exit-tail\r\n" in b"".join(base64.b64decode(event["data"]) for event in events if event["type"] == "output")
    client.close()
    client, resumed = recorder()
    assert resumed["source"] == ready["source"] and resumed["shellState"] == "exited"
    rejected = Client()
    rejected.send({"type": "attach", "version": 1, "mode": "interactive", "generation": 2, "columns": 80, "rows": 24})
    assert rejected.receive() == {"type": "error", "code": "SHELL_EXITED"}
    assert subprocess.run(["opsreplay-check-startup"], capture_output=True).returncode == 1
    for connection in (client, interactive, rejected):
        connection.close()
    print("terminal recording exit checks passed")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in ("exit", "quiet", "flood"):
        exit_case(sys.argv[1])
    else:
        run()
