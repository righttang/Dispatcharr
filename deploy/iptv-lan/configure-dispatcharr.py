#!/usr/bin/env python3
"""Initialize the trial and connect Dispatcharr to the tested IPTV-API playlist."""
import json
import os
from pathlib import Path
import secrets
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
BASE = 'http://192.168.50.84:9191'
PLAYLIST = 'http://iptv-api:8080/m3u'
TOKEN = None


def call(path, data=None, method=None):
    headers = {'Accept': 'application/json'}
    if TOKEN:
        headers['Authorization'] = 'Bearer ' + TOKEN
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(
        path if path.startswith('http') else BASE + path,
        data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = response.read()
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'{req.method} {req.full_url}: {error.code} '
                           f'{error.read(1200).decode(errors="replace")}') from None


def listing(path):
    rows = []
    while path:
        data = call(path)
        if isinstance(data, list):
            return rows + data
        rows.extend(data.get('results', []))
        path = data.get('next')
    return rows


def wait_refresh(account_id, previous_update=None, timeout=40):
    deadline = time.monotonic() + timeout
    while True:
        account = call(f'/api/m3u/accounts/{account_id}/')
        terminal = account.get('status') in ('success', 'error', 'pending_setup')
        fresh = not previous_update or account.get('updated_at') != previous_update
        if terminal and fresh:
            return account
        if time.monotonic() >= deadline:
            return account
        time.sleep(2)


def refresh(account_id):
    previous = call(f'/api/m3u/accounts/{account_id}/').get('updated_at')
    call(f'/api/m3u/refresh/{account_id}/', {})
    time.sleep(1)
    return wait_refresh(account_id, previous)


def main():
    global TOKEN
    credentials = ROOT / '.env'
    if not credentials.exists():
        descriptor = os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write('DISPATCHARR_ADMIN_USERNAME=admin\n')
            stream.write('DISPATCHARR_ADMIN_PASSWORD=' + secrets.token_urlsafe(18) + '\n')
    values = dict(line.split('=', 1) for line in credentials.read_text().splitlines()
                  if line and not line.startswith('#'))
    login = {'username': values['DISPATCHARR_ADMIN_USERNAME'],
             'password': values['DISPATCHARR_ADMIN_PASSWORD']}
    status = call('/api/accounts/initialize-superuser/')
    if not status['superuser_exists']:
        call('/api/accounts/initialize-superuser/', login)
        print('Administrator initialized; credentials saved in iptv/.env', flush=True)
    TOKEN = call('/api/accounts/token/', login)['access']

    profiles = listing('/api/core/streamprofiles/')
    proxy = next(p for p in profiles if p['name'].lower() == 'proxy')
    settings = listing('/api/core/settings/')
    for setting in settings:
        key = setting['key'].replace('_', '-')
        if key not in ('stream-settings', 'proxy-settings'):
            continue
        value = setting['value']
        was_string = isinstance(value, str)
        value = json.loads(value) if isinstance(value, str) else dict(value or {})
        if key == 'stream-settings':
            value.update(default_stream_profile=proxy['id'], default_output_format='mpegts')
        else:
            value.update(channel_shutdown_delay=30, new_client_behind_seconds=2)
        call(f"/api/core/settings/{setting['id']}/",
             {'value': json.dumps(value) if was_string else value}, 'PATCH')

    accounts = listing('/api/m3u/accounts/')
    account = next((a for a in accounts if a['name'] == 'IPTV-API'), None)
    payload = {
        'name': 'IPTV-API', 'server_url': PLAYLIST, 'account_type': 'STD',
        'is_active': True, 'max_streams': 4, 'refresh_interval': 1,
        'stream_profile': proxy['id'], 'enable_vod': False,
        'auto_enable_new_groups_live': True, 'stale_stream_days': 1,
        'hash_key': 'name,m3u_id,group',
    }
    if account is None:
        account = call('/api/m3u/accounts/', payload)
    else:
        account = call(f"/api/m3u/accounts/{account['id']}/", payload, 'PATCH')
    account_id = account['id']
    account = refresh(account_id)
    groups = account.get('channel_groups') or []
    if not groups:
        print(json.dumps({'status': 'waiting_for_playlist', 'account_id': account_id,
                          'provider_status': account.get('status'),
                          'message': account.get('last_message')}, ensure_ascii=False), flush=True)
        return 0
    group_settings = []
    for group in groups:
        props = group.get('custom_properties') or {}
        props = json.loads(props) if isinstance(props, str) else dict(props)
        props['channel_numbering_mode'] = 'next_available'
        group_settings.append({'channel_group': group['channel_group'],
                               'enabled': True, 'auto_channel_sync': True,
                               'custom_properties': props})
    call(f'/api/m3u/accounts/{account_id}/group-settings/',
         {'group_settings': group_settings}, 'PATCH')
    refresh(account_id)
    channels = listing('/api/channels/channels/')
    result = {'account_id': account_id, 'groups': len(groups),
              'channels': len(channels), 'playlist': PLAYLIST,
              'web': BASE, 'samples': [c['name'] for c in channels[:12]]}
    (ROOT / 'evidence' / 'integration.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
