"""Resolve configured IPTV redirectors before the upstream HLS speed sampler."""
import asyncio
import json
import logging
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request

LOG = logging.getLogger('iptv.provider_compat')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def resolve_playlist(url, headers=None, timeout=8):
    """Follow a bounded chain with fresh connections and require an HLS body."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    deadline = time.monotonic() + timeout
    current = urllib.parse.quote(url.partition('$')[0], safe=':/?&=;%+#@[]!,$*()-_.~')
    for _ in range(6):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Playlist redirect deadline exceeded')
        request = urllib.request.Request(current, headers={**(headers or {}), 'Connection': 'close'})
        try:
            with opener.open(request, timeout=remaining) as response:
                if response.status != 200:
                    raise ValueError('Playlist returned a non-success status')
                prefix = response.read(512).lstrip(b'\xef\xbb\xbf\r\n\t ')
                if not prefix.startswith(b'#EXTM3U'):
                    raise ValueError('Resolved response is not an HLS playlist')
                return response.url
        except urllib.error.HTTPError as error:
            try:
                location = error.headers.get('Location')
                if error.code not in (301, 302, 303, 307, 308) or not location:
                    raise
                current = urllib.parse.urljoin(current, location)
                if urllib.parse.urlsplit(current).scheme not in ('http', 'https'):
                    raise ValueError('Unexpected playlist redirect scheme')
            finally:
                error.close()
    raise ValueError('Too many playlist redirects')


def wrap_get_result(original, endpoints):
    async def get_result(url, headers=None, *args, **kwargs):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.hostname, parsed.path) in endpoints:
            timeout = kwargs.get('timeout', args[2] if len(args) > 2 else 8)
            limit = kwargs.get('http_semaphore')
            async def resolve():
                return await asyncio.to_thread(resolve_playlist, url, headers, min(12, max(2, timeout)))
            try:
                if limit is not None:
                    async with limit:
                        resolved = await resolve()
                else:
                    resolved = await resolve()
                return await original(resolved, headers, *args, **kwargs)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                LOG.warning('Playlist compatibility resolution failed: %s', type(error).__name__)
        return await original(url, headers, *args, **kwargs)
    return get_result


def install(path=Path('config/provider-compat.json')):
    if not path.exists():
        return
    from utils import speed
    entries = json.loads(path.read_text())['playlist_redirectors']
    endpoints = {(entry['host'], entry['path']) for entry in entries}
    speed.get_result = wrap_get_result(speed.get_result, endpoints)
    LOG.info('Enabled playlist compatibility for %d configured redirectors', len(endpoints))
