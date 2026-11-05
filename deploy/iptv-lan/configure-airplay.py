#!/usr/bin/env python3
"""Install the owned, on-demand 720p H.264/AAC profile for native AirPlay."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NAME = 'IPTV AirPlay compatibility'
PARAMETERS = (
    '-hide_banner -loglevel error -threads 2 -filter_threads 1 -i pipe:0 '
    '-map 0:v:0? -map 0:a:0? -vf scale=1280:-2,fps=25 '
    '-c:v libx264 -preset ultrafast -tune zerolatency -profile:v baseline '
    '-pix_fmt yuv420p -crf 25 -g 50 -keyint_min 50 -sc_threshold 0 -threads 2 '
    '-c:a aac -b:a 128k -ac 2 -ar 48000 -mpegts_flags +resend_headers '
    '-avoid_negative_ts make_zero -f mpegts pipe:1'
)


def main():
    spec = importlib.util.spec_from_file_location('dispatch_setup', ROOT / 'configure-dispatcharr.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    credentials = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines()
                       if line and not line.startswith('#'))
    api.TOKEN = api.call('/api/accounts/token/', {
        'username': credentials['DISPATCHARR_ADMIN_USERNAME'],
        'password': credentials['DISPATCHARR_ADMIN_PASSWORD'],
    })['access']
    payload = {'name': NAME, 'command': 'ffmpeg', 'parameters': PARAMETERS, 'is_active': True}
    existing = next((p for p in api.listing('/api/core/outputprofiles/') if p['name'] == NAME), None)
    if existing and existing.get('locked'):
        raise RuntimeError('AirPlay profile is protected; leave it unchanged')
    if existing:
        profile = api.call(f"/api/core/outputprofiles/{existing['id']}/", payload, 'PATCH') if any(
            existing.get(key) != value for key, value in payload.items()) else existing
    else:
        profile = api.call('/api/core/outputprofiles/', payload)
    print(json.dumps({'profile_id': profile['id'], 'name': NAME, 'active': profile['is_active']}))


if __name__ == '__main__':
    main()
