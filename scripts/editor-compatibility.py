"""Check normal editor use inside one temporary Challenge test container."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


OPTIONS = ["-u", "NONE", "-U", "NONE", "-i", "NONE", "-n", "-N", "-X", "-e", "-s"]
ENVIRONMENT = {**os.environ, "LC_ALL": "C.UTF-8", "TERM": "xterm"}


def edit(directory, executable, commands):
    result = subprocess.run(
        [executable, *OPTIONS],
        input=commands,
        cwd=directory,
        env=ENVIRONMENT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, (executable, result.returncode, result.stderr)


with tempfile.TemporaryDirectory(prefix="opsreplay-editor-") as temporary:
    directory = Path(temporary)
    original = "service_port=8081\n# café 诊断\n"
    for executable in ("vi", "vim", "vim.tiny"):
        target = directory / "editor.txt"
        target.write_text(original, encoding="utf-8")
        edit(directory, executable, "edit editor.txt\n%s/8081/8080/g\nwq\n")
        assert target.read_text(encoding="utf-8") == original.replace("8081", "8080")

    # Vim creates this valid swap file from a normal edit. No external samples.
    target = directory / "normal.txt"
    target.write_text("original-content\n", encoding="utf-8")
    with (directory / "writer.log").open("wb") as log:
        writer = subprocess.Popen(
            ["vim.tiny", *[option for option in OPTIONS if option != "-n"], target.name],
            cwd=directory,
            env=ENVIRONMENT,
            stdin=subprocess.PIPE,
            stdout=log,
            stderr=log,
        )
        try:
            writer.stdin.write(b"set directory=.\n0append\nrecovered-edit\n.\npreserve\n")
            writer.stdin.flush()
            swap = directory / ".normal.txt.swp"
            deadline = time.monotonic() + 5
            while True:
                assert writer.poll() is None, (directory / "writer.log").read_text(errors="replace")
                if swap.exists():
                    saved_swap = swap.read_bytes()
                    if b"recovered-edit" in saved_swap:
                        break
                assert time.monotonic() < deadline, "Vim did not preserve the normal edit"
                time.sleep(0.02)
            writer.communicate(b"qa!\n", timeout=5)
            assert writer.returncode == 0
        finally:
            if writer.poll() is None:
                writer.terminate()
                try:
                    writer.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    writer.kill()
                    writer.wait(timeout=2)
            if writer.stdin and not writer.stdin.closed:
                writer.stdin.close()
    swap.write_bytes(saved_swap)
    edit(directory, "vim.tiny", "recover! normal.txt\nw restored.txt\nqa!\n")
    assert (directory / "restored.txt").read_text(encoding="utf-8") == "recovered-edit\noriginal-content\n"

    version = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", "vim-tiny"], text=True)
    assert version == "2:9.2.0858-1+opsreplay1", version
    common_version = subprocess.check_output(["dpkg-query", "-W", "-f=${Version}", "vim-common"], text=True)
    assert common_version == version
    verification = subprocess.check_output(["dpkg", "--verify", "vim-tiny"], text=True)
    assert verification == "", verification
    common_verification = subprocess.check_output(["dpkg", "--verify", "vim-common"], text=True)
    assert common_verification == "", common_verification
    subprocess.run(
        ["sha256sum", "--check", "/usr/share/doc/vim-tiny/opsreplay-binary.sha256"],
        cwd="/",
        stdout=subprocess.DEVNULL,
        check=True,
    )
    assert os.environ.get("EDITOR") == "nano"
    assert subprocess.check_output(["nano", "--version"], text=True)

print(json.dumps({"editingAliases": 3, "validSwapRecovery": True,
                  "packageVersion": version, "packageHashesVerified": True,
                  "defaultEditor": "nano"}))
