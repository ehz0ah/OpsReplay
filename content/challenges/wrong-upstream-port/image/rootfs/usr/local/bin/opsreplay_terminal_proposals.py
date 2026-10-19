"""Bounded confirmation receipts for the existing shell. Never re-send a token."""
import base64
import json
import os
import re
import time

DIRECTORY = "/run/opsreplay-terminal"
REQUEST = DIRECTORY + "/proposal.json"
RECEIPT = DIRECTORY + "/proposal.receipt"
TRIGGER = b"\x1b[99~"
UUID = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def valid(frame):
    return (isinstance(frame.get("command"), str) and 0 < len(frame["command"]) <= 1000
            and not re.search(r"[\x00-\x1f\x7f]", frame["command"])
            and isinstance(frame.get("token"), str) and UUID.fullmatch(frame["token"])
            and isinstance(frame.get("proposalId"), str) and UUID.fullmatch(frame["proposalId"]))


class ProposalLedger:
    def __init__(self):
        self.receipts = {}
        self.prompt_ready = False
        self.awaiting_command = False
        self.control = bytearray()

    def input(self, data):
        if b'\r' in data or b'\n' in data:
            self.prompt_ready = False
            self.awaiting_command = True

    def output(self, data):
        self.control.extend(data)
        while True:
            at = self.control.find(b'\x1b]133;')
            if at < 0:
                self.control[:] = self.control[-6:]
                return
            end = self.control.find(b'\x07', at)
            if end < 0:
                self.control[:] = self.control[at:][-2400:]
                return
            marker = bytes(self.control[at + 6:end])
            del self.control[:end + 1]
            if marker.startswith(b'C;'):
                self.awaiting_command = False
                self.prompt_ready = False
            elif marker == b'B' and not self.awaiting_command:
                self.prompt_ready = True
            elif marker == b'A' or marker.startswith(b'D;'):
                self.prompt_ready = False

    def status(self, token):
        old = self.receipts.get(token)
        if not old:
            return "unknown"
        if old[1] == "unknown":
            try:
                with open(RECEIPT, encoding="utf-8") as file:
                    value = json.load(file)
                if value.get("token") == token and value.get("status") in ("accepted", "busy"):
                    self.receipts[token] = (old[0], value["status"])
            except (OSError, ValueError):
                pass
        return self.receipts[token][1]

    def dispatch(self, state, connection, generation, frame):
        token = frame["token"]
        with state.input_lock:
            with state.lock:
                failure = state._validate_owner(connection, generation)
                if failure is not None:
                    return "unknown"
                old = self.receipts.get(token)
                identity = (frame["proposalId"], frame["command"])
                if old:
                    return self.status(token) if old[0] == identity else "unknown"
                # An unresolved binding trigger must not consume a later request.
                if any(self.status(saved_token) == "unknown" for saved_token in self.receipts):
                    return "busy"
                if len(self.receipts) >= 100:
                    return "busy"
                if not self.prompt_ready:
                    return "busy"
                # Only the foreground Bash line editor may handle the binding.
                try:
                    if os.tcgetpgrp(state.master_fd) != state.child_pid:
                        return "busy"
                except OSError:
                    return "busy"
                self.receipts[token] = (identity, "unknown")
            with open(REQUEST, "w", encoding="utf-8") as file:
                json.dump({"token": token, "proposalId": frame["proposalId"], "command": base64.b64encode(frame["command"].encode()).decode(), "expiresAt": time.time() + 1}, file)
            try:
                os.unlink(RECEIPT)
            except FileNotFoundError:
                pass
            # Only a binding trigger enters the PTY. The binding checks READLINE_LINE
            # and executes the supplied command only after recording acceptance.
            try:
                with state.recording.lock:
                    written = os.write(state.master_fd, TRIGGER)
                    if written:
                        state.recording.bytes_event("input", TRIGGER[:written])
            except OSError:
                return "unknown"
            if written != len(TRIGGER):
                return "unknown"
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    with open(RECEIPT, encoding="utf-8") as file:
                        value = json.load(file)
                    if value.get("token") == token and value.get("status") in ("accepted", "busy"):
                        status = value["status"]
                        self.receipts[token] = (identity, status)
                        return status
                except (OSError, ValueError):
                    pass
                time.sleep(0.01)
            return "unknown"
