#!/usr/bin/env python3
"""Run this project with the image digests approved by the host scan gate."""
import hashlib
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
suffix = hashlib.sha256(('iptv\0' + str(root)).encode()).hexdigest()[:12]
override = Path('/var/lib/wiz-container-updater/overrides') / f'iptv-{suffix}.json'
if not override.is_file():
    sys.exit(f'Missing scanned image override: {override}')
os.execvp('docker', ['docker', 'compose', '--project-name', 'iptv',
                    '--project-directory', str(root), '-f', str(root / 'compose.yml'),
                    '-f', str(override), *sys.argv[1:]])
