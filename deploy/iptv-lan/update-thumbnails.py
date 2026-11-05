#!/usr/bin/env python3
"""Capture selected, successfully tested streams using Dispatcharr's FFmpeg.

The collector DB is read-only. Public output contains channel UUIDs and snapshot
times, never upstream URLs, request headers, credentials, or access tokens.
"""
import argparse
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parent
BASE = 'http://192.168.50.84:9191'
PUBLIC = '/static/channel-thumbnails/'
LOG = logging.getLogger('iptv-thumbnails')
REFRESH_SECONDS = 30 * 60


class Dispatcharr:
    def __init__(self):
        values = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines()
                      if line and not line.startswith('#'))
        self.token = None
        self.token = self.call('/api/accounts/token/', {
            'username': values['DISPATCHARR_ADMIN_USERNAME'],
            'password': values['DISPATCHARR_ADMIN_PASSWORD'],
        })['access']

    def call(self, path, data=None):
        url = path if path.startswith('http') else BASE + path
        if urlsplit(url).netloc != urlsplit(BASE).netloc:
            raise ValueError('Unexpected API pagination origin')
        headers = {'Accept': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, headers=headers,
                                         data=json.dumps(data).encode() if data is not None else None)
        with urllib.request.urlopen(request, timeout=25) as response:
            return json.load(response)

    def listing(self, path):
        rows = []
        while path:
            data = self.call(path)
            if isinstance(data, list):
                return rows + data
            rows.extend(data.get('results', []))
            path = data.get('next')
        return rows


def measurements(db_path):
    # mode=ro protects the collector database; WAL readers may need a shared-memory file.
    with sqlite3.connect(db_path.resolve().as_uri() + '?mode=ro', uri=True, timeout=10) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('''SELECT url, headers, result_key, tested_at FROM channel_results
                             WHERE valid=1 AND selected_rank=1 AND tested_at IS NOT NULL
                             ORDER BY tested_at DESC''').fetchall()
    by_url = {}
    for row in rows:
        item = dict(row)
        item['url'] = item['url'].partition('$')[0]
        item['headers'] = json.loads(item['headers']) if item['headers'] else {}
        by_url.setdefault(item['url'], item)
    return by_url


def candidates(channels, streams, tested):
    streams = {row['id']: row for row in streams}
    found = {}
    for channel in channels:
        if channel.get('hidden_from_output') or channel.get('effective_is_radio', channel.get('is_radio')):
            continue
        # The picture must correspond to the first stream that will actually play.
        ids = channel.get('streams') or []
        stream = streams.get(ids[0]) if ids else None
        row = tested.get(stream.get('url')) if stream else None
        if row is None:
            continue
        channel_uuid = str(UUID(channel['uuid']))
        source_hash = hashlib.sha256(json.dumps(
            [row['url'], row['headers']], sort_keys=True).encode()).hexdigest()
        found[channel_uuid] = {**row, 'source_hash': source_hash}
    return found


def due(previous, candidate, now, image_exists):
    if not previous or previous.get('source_hash') != candidate['source_hash']:
        return True
    if candidate['tested_at'] > previous.get('tested_at', 0):
        return True
    if previous.get('status') == 'success' and image_exists:
        return now - previous.get('captured_at', 0) >= REFRESH_SECONDS
    retry_after = 900 if previous.get('failures', 0) < 3 else 3600
    return now - previous.get('attempted_at', 0) >= retry_after


def atomic_write(path, data, mode=0o644):
    descriptor, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            os.fchmod(handle.fileno(), mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def publish(output, state, active):
    channels = {}
    for channel_uuid, candidate in active.items():
        record = state.get(channel_uuid, {})
        if (record.get('source_hash') == candidate['source_hash']
                and record.get('captured_at') and (output / f'{channel_uuid}.jpg').is_file()):
            channels[channel_uuid] = {
                'url': f"{PUBLIC}{channel_uuid}.jpg?v={record['captured_at']}",
                'captured_at': record['captured_at'],
                'tested_at': record.get('captured_tested_at'),
                'last_attempt_ok': record.get('status') == 'success',
            }
    atomic_write(output / 'index.json', (json.dumps({
        'updated_at': int(time.time()), 'channels': channels,
    }, separators=(',', ':')) + '\n').encode())


def capture(candidate, timeout):
    try:
        result = subprocess.run(
            ['docker', 'exec', '-i', 'dispatcharr', 'python', '/opt/iptv-tools/capture-thumbnail.py'],
            input=json.dumps({'url': candidate['url'], 'headers': candidate['headers'],
                              'timeout': timeout}).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout + 8, check=False)
    except subprocess.TimeoutExpired:
        return None
    data = result.stdout
    if result.returncode or len(data) < 512 or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        return None
    return data


def refresh_record(previous, candidate, now, ok):
    same_source = previous.get('source_hash') == candidate['source_hash']
    same_measurement = same_source and previous.get('tested_at') == candidate['tested_at']
    record = dict(previous) if same_source else {}
    record.update(source_hash=candidate['source_hash'], tested_at=candidate['tested_at'],
                  attempted_at=now, status='success' if ok else 'error',
                  failures=0 if ok else (previous.get('failures', 0) if same_measurement else 0) + 1)
    if ok:
        record.update(captured_at=int(now), captured_tested_at=candidate['tested_at'])
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--limit', type=int, default=8)
    parser.add_argument('--timeout', type=float, default=15)
    options = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    output = ROOT / 'thumbnails'
    output.mkdir(exist_ok=True)
    state_path = ROOT / 'thumbnail-state.json'
    with (ROOT / 'thumbnail-worker.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        api = Dispatcharr()
        active = candidates(api.listing('/api/channels/channels/?page_size=200'),
                            api.listing('/api/channels/streams/?page_size=200'),
                            measurements(ROOT / 'iptv-api/output/data/channel_results.db'))
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        # Preserve cached frames across transient collector/playlist refreshes.
        # publish() still exposes only currently eligible, matching sources.
        publish(output, state, active)
        pending = [key for key, candidate in active.items()
                   if due(state.get(key), candidate, time.time(), (output / f'{key}.jpg').is_file())]
        pending.sort(key=lambda key: (bool(state.get(key, {}).get('captured_at')),
                                      state.get(key, {}).get('attempted_at', 0), key))
        count = 0
        for channel_uuid in pending[:max(0, options.limit)]:
            candidate = active[channel_uuid]
            data = capture(candidate, min(40, max(3, options.timeout)))
            if data:
                atomic_write(output / f'{channel_uuid}.jpg', data)
                count += 1
            state[channel_uuid] = refresh_record(state.get(channel_uuid, {}), candidate, time.time(), bool(data))
            atomic_write(state_path, (json.dumps(state) + '\n').encode(), mode=0o600)
            publish(output, state, active)
            LOG.info('channel=%s snapshot=%s', channel_uuid, 'ok' if data else 'unavailable')
        LOG.info('eligible=%d attempted=%d captured=%d remaining=%d',
                 len(active), min(len(pending), max(0, options.limit)), count,
                 max(0, len(pending) - options.limit))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
