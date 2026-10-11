"""Bounded, process-local terminal history. No persistence or learner secrets."""

import base64
import datetime
import json
import threading
import time
import uuid


MAX_JOURNAL_BYTES = 20_000_000
MAX_JOURNAL_EVENTS = 100_000
# Includes the maximum sequence, millisecond timestamp, and signed shell exit code.
MAX_EXIT_EVENT_BYTES = 128
MAX_PAGE_EVENTS = 100
MAX_FRAME_BYTES = 24 * 1024
MAX_REQUEST_BYTES = 1024
MAX_READS_PER_SECOND = 10
POST_EXIT_SECONDS = 60
INITIAL_COLUMNS = 80
INITIAL_ROWS = 24


def encode(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("ascii")


class RecordingJournal:
    def __init__(self):
        # The PTY reader never takes the input-operation lock. This short lock covers
        # only a nonblocking PTY operation and its event, or a bounded page snapshot.
        self.lock = threading.RLock()
        self.source = str(uuid.uuid4())
        self.wall_origin_ms = time.time_ns() // 1_000_000
        self.monotonic_origin_ns = time.monotonic_ns()
        self.started_at = self.timestamp()
        self.events = []
        self.byte_count = 0
        self.loss = None
        self.shell_state = "running"

    def timestamp(self):
        elapsed_ms = (time.monotonic_ns() - self.monotonic_origin_ns) // 1_000_000
        instant = datetime.datetime.fromtimestamp(
            (self.wall_origin_ms + elapsed_ms) / 1000, datetime.timezone.utc
        )
        return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def mark_loss(self, reason):
        with self.lock:
            if self.loss is None:
                self.loss = {"reason": reason, "occurredAt": self.timestamp()}

    def append(self, event_type, **payload):
        with self.lock:
            if self.loss is not None or self.shell_state == "exited":
                return
            event = {
                "sequence": len(self.events) + 1,
                "recordedAt": self.timestamp(),
                "type": event_type,
                **payload,
            }
            encoded = encode(event)
            if (
                len(self.events) >= MAX_JOURNAL_EVENTS - 1
                or self.byte_count + len(encoded) > MAX_JOURNAL_BYTES - MAX_EXIT_EVENT_BYTES
            ):
                self.loss = {"reason": "limit_exceeded", "occurredAt": event["recordedAt"]}
                return
            self.events.append(encoded)
            self.byte_count += len(encoded)

    def finish(self, exit_code):
        with self.lock:
            if self.shell_state == "exited":
                return
            # Exit is a control observation, not resumed data or proof the gap was
            # filled. Data appends reserve its bytes and one sequence slot.
            event = encode({
                "sequence": len(self.events) + 1,
                "recordedAt": self.timestamp(),
                "type": "exit",
                "code": exit_code,
            })
            if len(event) > MAX_EXIT_EVENT_BYTES:
                raise ValueError("terminal exit event exceeds reserved capacity")
            self.events.append(event)
            self.byte_count += len(event)
            self.shell_state = "exited"

    def bytes_event(self, event_type, data):
        self.append(event_type, data=base64.b64encode(data).decode("ascii"))

    def metadata(self, frame_type):
        # Caller holds lock so observation time, loss, and sequence form one snapshot.
        return {
            "type": frame_type,
            "version": 1,
            "source": self.source,
            "startedAt": self.started_at,
            "initialColumns": INITIAL_COLUMNS,
            "initialRows": INITIAL_ROWS,
            "latestSequence": len(self.events),
            "observedAt": self.timestamp(),
            "shellState": self.shell_state,
            "loss": self.loss,
        }

    def ready(self):
        with self.lock:
            return self.metadata("recording_ready")

    def page(self, source, after):
        with self.lock:
            if source != self.source:
                raise ValueError("SOURCE_MISMATCH")
            if after > len(self.events):
                raise ValueError("INVALID_CURSOR")
            frame = self.metadata("recording_page")
            frame.update({"events": [], "nextSequence": after})
            # Reserve the maximum cursor width. Encoded event bytes are already in
            # memory, so reads visit at most 100 events, never the full journal.
            size = len(encode({**frame, "nextSequence": MAX_JOURNAL_EVENTS})) + 1
            for index in range(after, min(len(self.events), after + MAX_PAGE_EVENTS)):
                event = self.events[index]
                added = len(event) + (1 if frame["events"] else 0)
                if size + added > MAX_FRAME_BYTES:
                    break
                frame["events"].append(json.loads(event))
                frame["nextSequence"] = index + 1
                size += added
            return frame
