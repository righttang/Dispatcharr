#!/usr/bin/env python3
"""Apply provider-specific FFmpeg playback profiles to tested dynamic HLS sources."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import sqlite3
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent


def url_key(url):
    parsed = urlsplit(url.partition('$')[0])
    return parsed.netloc, parsed.path, tuple(sorted(parse_qsl(parsed.query)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-refresh', action='store_true')
    options = parser.parse_args()
    spec = importlib.util.spec_from_file_location('dispatch_setup', ROOT / 'configure-dispatcharr.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    credentials = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines()
                       if line and not line.startswith('#'))
    api.TOKEN = api.call('/api/accounts/token/', {
        'username': credentials['DISPATCHARR_ADMIN_USERNAME'],
        'password': credentials['DISPATCHARR_ADMIN_PASSWORD'],
    })['access']
    account = next(a for a in api.listing('/api/m3u/accounts/') if a['name'] == 'IPTV-API')
    if not options.no_refresh:
        api.refresh(account['id'])
    with sqlite3.connect((ROOT / 'iptv-api/output/data/channel_results.db').as_uri() + '?mode=ro', uri=True) as db:
        rows = db.execute('''SELECT url, headers FROM channel_results
                             WHERE valid=1 AND selected_rank=1 ORDER BY tested_at DESC''').fetchall()
    tested = {}
    for url, headers in rows:
        tested.setdefault(url_key(url), json.loads(headers) if headers else {})
    endpoints = {(r['host'], r['path']) for r in json.loads(
        (ROOT / 'iptv-api/config/provider-compat.json').read_text())['playlist_redirectors']}
    profiles = api.listing('/api/core/streamprofiles/')
    template = next(p for p in profiles if p['name'] == 'FFmpeg' and p['locked'])
    by_name = {p['name']: p for p in profiles}
    managed_ids = {p['id'] for p in profiles if p['name'].startswith('IPTV Dynamic ')}
    streams = {s['id']: s for s in api.listing('/api/channels/streams/')}
    channels = api.listing('/api/channels/channels/')
    backup_path = ROOT / 'evidence/channel-diagnosis/playback-overrides-before.json'
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    backups = json.loads(backup_path.read_text()) if backup_path.exists() else {}
    configured = []
    for channel in channels:
        ids = channel.get('streams') or []
        stream = streams.get(ids[0]) if ids else None
        if not stream:
            continue
        parsed = urlsplit(stream['url'])
        key = url_key(stream['url'])
        if (parsed.hostname, parsed.path) not in endpoints or key not in tested:
            continue
        override = channel.get('override') or {}
        current = override.get('stream_profile_id')
        if current and current not in managed_ids:
            continue
        headers = tested[key]
        ua = headers.get('User-Agent', 'Mozilla/5.0')
        extra = {k: v for k, v in headers.items() if k.lower() != 'user-agent'}
        browser_h264 = channel['name'] == '湖南卫视'
        fingerprint = hashlib.sha256(json.dumps(
            [headers, 'h264-720p' if browser_h264 else 'copy'], sort_keys=True).encode()).hexdigest()[:8]
        name = 'IPTV Dynamic ' + fingerprint
        parameters = template['parameters'].replace('{userAgent}', shlex.quote(ua))
        if extra:
            serialized = ''.join(f'{key}: {value}\r\n' for key, value in extra.items())
            parameters = parameters.replace('-i {streamUrl}', '-headers ' + shlex.quote(serialized) + ' -i {streamUrl}')
        if browser_h264:
            parameters = (
                '-threads 2 -filter_threads 1 ' + parameters
            ).replace('-map 0 ', '-map 0:v:0 -map 0:a:0? ').replace(
                '-c copy ', '-vf scale=-2:720:flags=fast_bilinear,fps=25 '
                '-c:v libx264 -preset ultrafast -tune zerolatency -crf 25 -threads 2 '
                '-c:a aac -b:a 128k -ac 2 '
            )
        profile = by_name.get(name)
        if profile is None:
            profile = api.call('/api/core/streamprofiles/', {
                'name': name, 'command': template['command'], 'parameters': parameters,
                'is_active': True, 'user_agent': None,
            })
            by_name[name] = profile
            managed_ids.add(profile['id'])
        if current != profile['id']:
            backups.setdefault(str(channel['id']), {'name': channel['name'], 'override': channel.get('override')})
            backup_path.write_text(json.dumps(backups, ensure_ascii=False, indent=2) + '\n')
            api.call(f"/api/channels/channels/{channel['id']}/", {
                'override': {'stream_profile_id': profile['id']},
            }, 'PATCH')
        configured.append({'id': channel['id'], 'name': channel['effective_name'], 'profile_id': profile['id']})
    result = {'web_channels': len(channels), 'configured': configured}
    (ROOT / 'evidence/channel-diagnosis/playback-profiles.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
