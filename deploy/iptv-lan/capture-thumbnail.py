#!/usr/bin/env python3
"""Run inside Dispatcharr: one bounded FFmpeg decode, JPEG on stdout only."""
import json
import subprocess
import sys
from urllib.parse import urlsplit


def capture(request):
    url = request['url']
    if urlsplit(url).scheme not in ('http', 'https'):
        return 2
    timeout = min(40, max(3, float(request.get('timeout', 15))))
    args = ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-threads', '1', '-filter_threads', '1', '-rw_timeout', '8000000',
            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36']
    headers = request.get('headers') or {}
    if headers:
        # A header must remain one header, including when imported from a playlist.
        if any('\r' in str(v) or '\n' in str(v) for pair in headers.items() for v in pair):
            return 2
        args += ['-headers', ''.join(f'{key}: {value}\r\n' for key, value in headers.items())]
    args += ['-i', url, '-map', '0:v:0', '-frames:v', '1', '-an',
             '-vf', 'scale=min(480\\,iw):-2', '-q:v', '5', '-threads', '1',
             '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1']
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return 3
    data = result.stdout
    if result.returncode or len(data) < 512 or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        return 4
    sys.stdout.buffer.write(data)
    return 0


if __name__ == '__main__':
    raise SystemExit(capture(json.load(sys.stdin)))
