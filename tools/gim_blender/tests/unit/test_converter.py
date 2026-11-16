from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import patch

TOOL=Path(__file__).resolve().parents[2]
REPO=TOOL.parent.parent
sys.path[:0]=[str(TOOL),str(TOOL/'assets/scripts')]
from converter import nav_bounds,convert
from library import demo_runtime,node_runtime
from project_identity import describe_project

class ImportTests(unittest.TestCase):
    def test_large_station_is_not_rejected_or_cropped(self):
        self.assertEqual(nav_bounds({'files':[{'file':'layout.ifc','bounds':[-340,-307,-21,366,154,44]}]},[]),[-360,-327,386,174])

    def test_frozen_resources_never_fall_back_to_old_internal_paths(self):
        with patch('library.sys.frozen',True,create=True),patch('library.application_home',return_value=Path('bundle')):
            self.assertEqual(demo_runtime(),Path('bundle/demo'))
            self.assertEqual(node_runtime(),Path('bundle/runtime/node.exe'))

    def test_identity_reuses_import_sha_without_reading_payload_again(self):
        base=REPO/'tmp/gim-blender-import-unit';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            source=Path(directory)/'metadata.gim'
            source.write_bytes(b'GIMPKGS\0'+ '110kV'.encode()+b'\0'+bytes.fromhex('377abcaf271c')+b'ordinary metadata DTO')
            with patch('project_identity.hashlib.file_digest',side_effect=AssertionError('second source digest')):
                result=describe_project(source,source_sha256='a'*64)
            self.assertEqual(result['sourceSha256'],'a'*64)
            self.assertEqual(result['displayName'],'110千伏变电站#aaaaaa')

    def test_missing_web_template_fails_before_geometry_work(self):
        base=REPO/'tmp/gim-blender-import-unit';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            home=Path(directory);source=home/'metadata.gim';source.write_bytes(b'cache identity DTO')
            with patch('converter.demo_runtime',return_value=home/'missing-demo'),patch('converter.find_blender') as engine:
                with self.assertRaisesRegex(FileNotFoundError,'demo/index.html'):convert(home,source)
                engine.assert_not_called()

if __name__=='__main__':unittest.main()
