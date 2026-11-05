"""Run inside Dispatcharr's existing Python environment; no database needed."""
import importlib.util
import os
import unittest

from django.conf import settings

if not settings.configured:
    settings.configure(DEFAULT_CHARSET='utf-8')

spec = importlib.util.spec_from_file_location('hls_ranges', os.environ.get(
    'IPTV_RANGE_MODULE', '/tmp/iptv-http-range.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
serve = module.segment_response


class HlsRanges(unittest.TestCase):
    def test_regular_response(self):
        r = serve(b'0123456789')
        self.assertEqual((r.status_code, r.content), (200, b'0123456789'))
        self.assertEqual(r['Accept-Ranges'], 'bytes')
        self.assertEqual(r['Content-Length'], '10')

    def test_open_ended_range(self):
        r = serve(b'0123456789', 'bytes=3-')
        self.assertEqual((r.status_code, r.content), (206, b'3456789'))
        self.assertEqual(r['Content-Range'], 'bytes 3-9/10')
        self.assertEqual(r['Content-Length'], '7')

    def test_full_range_is_partial_response(self):
        r = serve(b'0123456789', 'bytes=0-')
        self.assertEqual((r.status_code, r.content), (206, b'0123456789'))

    def test_suffix_and_end_clamping(self):
        self.assertEqual(serve(b'0123456789', 'bytes=-3').content, b'789')
        self.assertEqual(serve(b'0123456789', 'bytes=8-99').content, b'89')

    def test_unsatisfiable_range(self):
        for header in ['bytes=10-', 'bytes=8-3', 'bytes=-0']:
            r = serve(b'0123456789', header)
            self.assertEqual(r.status_code, 416)
            self.assertEqual(r['Content-Range'], 'bytes */10')
            self.assertEqual(r.content, b'')

    def test_unhandled_range_is_ignored(self):
        for header in ['bytes=0-3,5-8', 'bytes=-', 'items=0-1', 'invalid']:
            self.assertEqual(serve(b'0123456789', header).status_code, 200)

    def test_if_range_without_validator_uses_full_response(self):
        self.assertEqual(serve(b'0123456789', 'bytes=2-', '"other"').status_code, 200)


if __name__ == '__main__':
    unittest.main()
