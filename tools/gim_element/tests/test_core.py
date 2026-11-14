from pathlib import Path
import os
_TEST_TEMP = Path(__file__).resolve().parents[3] / 'tmp/tests/python'
_TEST_TEMP.mkdir(parents=True, exist_ok=True)
os.environ.update(TEMP=str(_TEST_TEMP), TMP=str(_TEST_TEMP), TMPDIR=str(_TEST_TEMP), GIM_READER_LOG_PATH=str(_TEST_TEMP / 'gim-reader.log'))
import sys
import tempfile
tempfile.tempdir = str(_TEST_TEMP)
import unittest

TOOL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(TOOL), str(TOOL.parent / 'tests')]
import element_core as core
from fixtures import element_sources, write_sources, write_zip


class ElementCoreTests(unittest.TestCase):
    def check_entities(self, result):
        self.assertEqual(list(result['totals']), ['设备', '装置性材料', '构件', '其他'])
        self.assertEqual(result['totals']['设备']['台数'], 1)
        self.assertEqual(result['totals']['设备']['附件并入'], 0)
        self.assertEqual(len(result['recognition']['snapshot']['pending']), 1)
        self.assertEqual(result['totals']['构件']['ifc'], 1)

    def test_folder_classification_preserves_transformer_and_internal_accessory(self):
        with tempfile.TemporaryDirectory() as directory:
            self.check_entities(core.scan(str(write_sources(directory, element_sources()))))

    def test_zip_matches_folder_results(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = write_sources(root / 'source', element_sources())
            packed = core.scan(str(write_zip(root / 'fixture.gim', element_sources())))
            self.check_entities(packed)
            self.assertEqual(packed['totals'], core.scan(str(folder))['totals'])

    def test_html_report_escapes_model_text(self):
        with tempfile.TemporaryDirectory() as directory:
            result = core.scan(str(write_sources(directory, element_sources())))
            result['meta']['source'] = '<script>alert(1)</script>'
            result['rows'][0]['template'] = '<img src=x onerror="alert(1)">'
            html = core.build_html(result)
            self.assertNotIn('<script>alert(1)</script>', html)
            self.assertIn('&lt;script&gt;', html)
            self.assertNotIn('<img src=x', html)
            self.assertIn('&lt;img src=x', html)
