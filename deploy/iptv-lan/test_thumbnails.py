"""Regression checks for capture scheduling, source identity, and stale frames."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('thumbnails', Path(__file__).with_name('update-thumbnails.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

UUID = '12345678-1234-1234-1234-123456789abc'


class ThumbnailsTest(unittest.TestCase):
    def setUp(self):
        self.row = {'url': 'https://example.test/live', 'headers': {}, 'tested_at': 100,
                    'result_key': 'abc', 'source_hash': 'source-a'}

    def test_only_actual_first_stream_and_valid_measurement_match(self):
        channels = [{'uuid': UUID, 'streams': [2, 1]},
                    {'uuid': '23456789-1234-1234-1234-123456789abc', 'streams': [1], 'hidden_from_output': True}]
        streams = [{'id': 1, 'url': self.row['url']}, {'id': 2, 'url': 'https://example.test/other'}]
        self.assertEqual(worker.candidates(channels, streams, {self.row['url']: self.row}), {})
        channels[0]['streams'] = [1, 2]
        result = worker.candidates(channels, streams, {self.row['url']: self.row})
        self.assertEqual(list(result), [UUID])
        self.assertEqual(result[UUID]['url'], self.row['url'])

    def test_new_measurement_triggers_once_and_failures_are_bounded(self):
        previous = worker.refresh_record({}, self.row, 200, True)
        self.assertFalse(worker.due(previous, self.row, 3000, True))
        newer = {**self.row, 'tested_at': 101}
        self.assertTrue(worker.due(previous, newer, 200, True))
        previous = worker.refresh_record(previous, newer, 300, False)
        self.assertFalse(worker.due(previous, newer, 400, True))
        self.assertTrue(worker.due(previous, newer, 1200, True))
        for now in (1200, 2100):
            previous = worker.refresh_record(previous, newer, now, False)
        self.assertEqual(previous['failures'], 3)
        self.assertFalse(worker.due(previous, newer, 10000, True))

    def test_failed_refresh_preserves_last_good_picture_but_source_change_does_not(self):
        success = worker.refresh_record({}, self.row, 200, True)
        failed = worker.refresh_record(success, {**self.row, 'tested_at': 101}, 300, False)
        self.assertEqual(failed['captured_at'], 200)
        self.assertEqual(failed['captured_tested_at'], 100)
        changed = worker.refresh_record(failed, {**self.row, 'source_hash': 'source-b'}, 400, False)
        self.assertNotIn('captured_at', changed)

    def test_public_manifest_excludes_urls_headers_and_wrong_source_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            (output / f'{UUID}.jpg').write_bytes(b'jpeg')
            record = worker.refresh_record({}, self.row, 200, True)
            worker.publish(output, {UUID: record}, {UUID: self.row})
            raw = (output / 'index.json').read_text()
            result = json.loads(raw)['channels']
            self.assertEqual(result[UUID]['captured_at'], 200)
            self.assertNotIn('example.test', raw)
            self.assertNotIn('headers', raw)
            worker.publish(output, {UUID: record}, {UUID: {**self.row, 'source_hash': 'changed'}})
            self.assertEqual(json.loads((output / 'index.json').read_text())['channels'], {})


if __name__ == '__main__':
    unittest.main()
