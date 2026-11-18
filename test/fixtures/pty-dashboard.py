"""Owned PTY driver for actual guest terminal attachment and dashboard return."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

mode, log_path, *command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, dict(os.environ, TERM="xterm-256color"))
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
output = bytearray()
attached = detached = dashboard = closed = False
status = None
try:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if select.select([fd], [], [], 0.05)[0]:
            try:
                chunk = os.read(fd, 65536)
            except OSError as exc:
                if exc.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output.extend(chunk)
        if not attached and b"Synthetic" in output:
            attached = True
            print(json.dumps({"event": "attached"}), flush=True)
        if attached and mode == "manual" and not detached:
            os.write(fd, b"\x02q")
            detached = True
        if not dashboard and b"Vultr worker >" in output:
            dashboard = True
            os.write(fd, b"q\n")
        if b"WORKER_DASHBOARD_CLOSED" in output:
            closed = True
        result, value = os.waitpid(pid, os.WNOHANG)
        if result:
            status = value
            break
    # PTY EOF can precede waitpid visibility by a scheduling tick.
    while status is None and time.monotonic() < deadline:
        result, value = os.waitpid(pid, os.WNOHANG)
        if result:
            status = value
        else:
            time.sleep(0.01)
    passed = attached and dashboard and closed and status is not None and os.waitstatus_to_exitcode(status) == 0
    print(json.dumps({"event": "finished", "mode": mode, "attached": attached, "dashboardReturned": dashboard, "closed": closed, "status": status}), flush=True)
    sys.exit(0 if passed else 1)
finally:
    with open(log_path, "wb") as capture:
        capture.write(output)
    if status is None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
