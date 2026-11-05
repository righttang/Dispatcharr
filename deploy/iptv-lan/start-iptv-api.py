"""Supervise the upstream updater and HTTP service without the RTMP stack."""
import os
import signal
import subprocess
import sys
import time

children = []
stopping = False


def stop(signum=signal.SIGTERM, frame=None):
    global stopping
    stopping = True
    for process in children:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
updater = 'run-updater.py' if os.path.isfile('run-updater.py') else 'main.py'
for command in ([sys.executable, '-u', updater],
                [sys.executable, '-m', 'gunicorn', 'service.app:app',
                 '--bind', '0.0.0.0:8080', '--workers', '1', '--threads', '4',
                 '--timeout', '120', '--access-logfile', '-']):
    children.append(subprocess.Popen(command, start_new_session=True))
try:
    while not stopping:
        failed = next((p for p in children if p.poll() is not None), None)
        if failed is not None:
            print(f'Child exited with status {failed.returncode}; stopping service', flush=True)
            break
        time.sleep(1)
finally:
    stop()
    deadline = time.monotonic() + 8
    for process in children:
        try:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
