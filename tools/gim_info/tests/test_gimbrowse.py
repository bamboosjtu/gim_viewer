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
from fixtures import information_sources, write_sources
from gimbrowse import Index


class PointerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = write_sources(self.temp.name, information_sources())
        self.ix = Index(str(self.root))

    def test_ambiguous_pointer_has_all_candidates_and_no_selected_target(self):
        result = self.ix.resolve('PHM/assembly.phm', 'shared.fam')
        self.assertEqual(result.status, 'ambiguous')
        self.assertEqual(result.target, '')
        self.assertEqual(result.candidates, ('DEV/shared.fam', 'MOD/shared.fam'))
        self.assertEqual(tuple(result), ('', 'ambiguous'))
        pointer = next(p for p in self.ix.pointers('PHM/assembly.phm') if p.key == 'BASEFAMILY0')
        self.assertEqual(pointer.as_dict()['candidates'], list(result.candidates))

    def test_conventional_directory_does_not_break_a_tie(self):
        write_sources(self.root, {'DEV/body.mod': '<Device/>'})
        result = Index(str(self.root)).resolve('PHM/assembly.phm', 'body.mod')
        self.assertEqual(result.status, 'ambiguous')
        self.assertEqual(result.candidates, ('DEV/body.mod', 'MOD/body.mod'))

    def test_explicit_case_insensitive_path_beats_local_and_basename_candidates(self):
        write_sources(self.root, {'PHM/body.mod': '<Device/>', 'DEV/body.mod': '<Device/>'})
        ix = Index(str(self.root))
        self.assertEqual(ix.resolve('PHM/assembly.phm', 'mod\\BODY.MOD').target, 'MOD/body.mod')
        self.assertEqual(ix.resolve('PHM/assembly.phm', './BODY.mod').target, 'PHM/body.mod')
        self.assertEqual(ix.resolve('PHM/assembly.phm', '../MOD/body.mod').target, 'MOD/body.mod')

    def test_back_refs_do_not_promote_candidates_to_confirmed_relationships(self):
        self.ix.build_refs(workers=1)
        for path in ['DEV/shared.fam', 'MOD/shared.fam']:
            self.assertEqual(self.ix.back_refs(path), [])
            possible = self.ix.possible_back_refs(path)
            self.assertEqual(len(possible), 2)
            self.assertTrue(all(pointer.status == 'ambiguous' for _, pointer in possible))

    def test_repeated_geometry_references_retain_keys_and_placements(self):
        edges = [edge for edge in self.ix.edges('PHM/assembly.phm') if edge[2] == 'MOD/body.mod']
        self.assertEqual([edge[1] for edge in edges], ['SOLIDMODEL0', 'SOLIDMODEL1'])
        kv = self.ix.read('PHM/assembly.phm')
        self.assertNotEqual(kv['TRANSFORMMATRIX0'], kv['TRANSFORMMATRIX1'])
        self.ix.build_refs(workers=1)
        self.assertEqual(len(self.ix.back_refs('MOD/body.mod')), 2)
        files = self.ix.chain_files('PHM/assembly.phm')
        self.assertEqual(sum(row[0] == 'MOD/body.mod' for row in files), 1)
        self.assertNotIn('', [row[0] for row in files])

    def test_repeated_cbm_references_are_edges_but_files_are_unique(self):
        self.assertEqual(len(self.ix.cbm_edges('CBM/project.cbm')), 2)
        self.assertEqual(len(self.ix.edges('CBM/project.cbm')), 2)
        rows = self.ix.chain_files('CBM/project.cbm')
        self.assertEqual(sum(row[0] == 'CBM/child.cbm' for row in rows), 1)

    def test_missing_pointer_keeps_download_hint(self):
        result = self.ix.resolve('PHM/assembly.phm', 'missing.mod')
        self.assertEqual((result.target, result.status), ('MOD/missing.mod', 'missing'))
        self.assertIn(('MOD/missing.mod', 1, '几何装配', 'SOLIDMODEL2', False), self.ix.chain_files('PHM/assembly.phm'))

    def test_main_chain_stops_at_ambiguity(self):
        write_sources(self.root, {'CBM/source.cbm': 'OBJECTMODELPOINTER=shared.dev\nBASEFAMILY=MOD/shared.fam',
                                 'DEV/shared.dev': '', 'PHM/shared.dev': ''})
        ix = Index(str(self.root))
        self.assertIsNone(ix.model_ptr('CBM/source.cbm'))
        self.assertEqual(len(ix.chain('CBM/source.cbm')), 1)


if __name__ == '__main__':
    unittest.main()
