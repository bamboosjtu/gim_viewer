from hashlib import sha256
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

TOOL = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(TOOL))
from verify_snapshot import verify_snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        base = TOOL.parents[1] / 'tmp' / 'gim-blender-snapshot-unit'
        base.mkdir(parents=True, exist_ok=True)
        scratch = TemporaryDirectory(dir=base)
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.source = self.root / 'engine' / 'snapshot' / 'fixture.ts'
        self.source.parent.mkdir(parents=True)

    def record(self, contents: bytes):
        manifest = {'files': [{
            'path': self.source.relative_to(self.root).as_posix(),
            'sha256': sha256(contents).hexdigest(),
        }]}
        (self.root / 'snapshot.json').write_text(json.dumps(manifest), encoding='utf-8')

    def test_lf_digest_covers_windows_checkout_and_mixed_line_endings(self):
        lf = b'export const a = 1;\nexport const b = 2;\n'
        self.record(lf)
        for contents in (lf, lf.replace(b'\n', b'\r\n'), lf.replace(b'\n', b'\r\n', 1)):
            with self.subTest(contents=contents):
                self.source.write_bytes(contents)
                self.assertEqual(verify_snapshot(self.root), 1)

    def test_edits_and_noncanonical_manifest_digests_fail(self):
        self.record(b'export const a = 1;\n')
        edited = b'export const a = 2;\r\n'
        self.source.write_bytes(edited)
        with self.assertRaisesRegex(ValueError, 'Snapshot hash mismatch'):
            verify_snapshot(self.root)

        self.record(edited)
        with self.assertRaisesRegex(ValueError, 'Snapshot hash mismatch'):
            verify_snapshot(self.root)
