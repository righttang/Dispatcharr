"""Single byte-range responses for immutable live media segments."""
import re

from django.http import HttpResponse


def segment_response(data, range_header='', if_range=''):
    size = len(data)
    start, end, status = 0, size - 1, 200
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header.strip())
    if match and any(match.groups()) and not if_range:
        first, last = match.groups()
        if first:
            start = int(first)
            end = min(int(last), size - 1) if last else size - 1
        else:
            count = int(last)
            start = max(0, size - count) if count else size
        status = 206 if 0 <= start <= end < size else 416

    response = HttpResponse(
        memoryview(data)[start:end + 1] if status != 416 else b'',
        status=status, content_type='video/mp2t',
    )
    response['Accept-Ranges'] = 'bytes'
    response['Content-Length'] = str(len(response.content))
    response['Cache-Control'] = 'no-cache'
    if status == 206:
        response['Content-Range'] = f'bytes {start}-{end}/{size}'
    elif status == 416:
        response['Content-Range'] = f'bytes */{size}'
    return response
