#!/usr/bin/env python3
"""Scan the trial images with the host's existing Wiz gate before deployment."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SOURCES = {
    'iptv-api': 'guovern/iptv-api:latest',
    'dispatcharr': 'ghcr.io/dispatcharr/dispatcharr:latest',
}


def main():
    os.umask(0o027)
    spec = importlib.util.spec_from_file_location(
        'host_updater', '/usr/local/libexec/wiz-container-updater.py')
    host = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(host)
    config = json.loads(Path('/etc/wiz-container-updater/config.json').read_text())
    config['log_dir'] = str(ROOT / 'evidence' / 'scans')
    updater = host.Updater(config)
    sources = dict(item.split('=', 1) for item in sys.argv[1:]) if sys.argv[1:] else SOURCES
    summary_path = ROOT / 'evidence' / 'image-scan-summary.json'
    summary = json.loads(summary_path.read_text()) if summary_path.exists() else {}
    overrides = {'services': {}}
    blocked = False
    for name, source in sources.items():
        inspected = json.loads(subprocess.check_output(
            ['docker', 'image', 'inspect', source], text=True))[0]
        try:
            reference = host.pinned_reference(source, inspected)
        except host.GateError:
            if not source.startswith('local-'):
                raise
            reference = inspected['Id']
        candidate = {
            'image_id': inspected['Id'],
            'reference': reference,
        }
        result = updater.scan(candidate)
        summary[name] = {**candidate, **result}
        host.atomic_json(ROOT / 'evidence' / 'image-scan-summary.json', summary)
        if result['critical']:
            print(json.dumps({'service': name, 'status': 'blocked',
                              'critical': result['critical'],
                              'findings': result['critical_findings']}), flush=True)
            blocked = True
        overrides['services'][name] = {'image': candidate['reference']}
    if blocked:
        return 2
    for name in SOURCES:
        if name not in overrides['services']:
            prior = summary.get(name, {})
            if prior.get('critical') != 0 or not prior.get('no_publish_confirmed'):
                print(f'No passing scan for {name}', flush=True)
                return 2
            overrides['services'][name] = {'image': prior['reference']}
    suffix = hashlib.sha256(('iptv\0' + str(ROOT)).encode()).hexdigest()[:12]
    target = Path(config['state_dir']) / 'overrides' / f'iptv-{suffix}.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    host.atomic_json(target, overrides)
    host.atomic_json(ROOT / 'evidence' / 'images.lock.json', overrides)
    print(json.dumps({'status': 'passed', 'override': str(target)}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
