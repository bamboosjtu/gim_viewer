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
import gim_core as core
from fixtures import device_sources, write_gim7z, write_zip


class DeviceCoreTests(unittest.TestCase):
    def check_assembly(self, path, work):
        result = core.load(str(path), str(work))
        self.assertEqual(result['meta']['instances'], 2)
        self.assertEqual(result['meta']['entityCount'], 2)
        self.assertEqual({e['type'] for e in result['entities']}, {'Cuboid'})
        self.assertEqual(sorted(e['wm'][12] for e in result['entities']), [150, 1150])
        self.assertEqual(len({e['id'] for e in result['entities']}), 2)
        self.assertEqual({e['oid'] for e in result['entities']}, {1})

    def test_zip_container_preserves_repeated_mod_occurrences(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.check_assembly(write_zip(root / 'fixture.gim', device_sources()), root / 'unpacked')

    def test_gimpkg_7z_uses_same_assembly_semantics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = write_gim7z(root / 'fixture.gim', device_sources(), root / 'source')
            self.assertEqual(core.sniff(str(path))[0], 'gimpkg')
            self.check_assembly(path, root / 'unpacked')

    def test_unknown_container_fails_explicitly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'invalid.gim'
            path.write_bytes(b'invalid input')
            with self.assertRaises(ValueError):
                core.unpack(str(path), str(Path(directory) / 'unpacked'))
