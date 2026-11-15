from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import support
from element_core import source_file_paths

class SourceFileDisplayContracts(unittest.TestCase):
    def test_source_file_lines_preserve_real_filename_characters_and_deduplicate_occurrences(self):
        self.assertEqual(source_file_paths(['DEV/a#1.ifc#12','DEV/a#1.ifc#13','DEV/a; b.dev','DEV/a; b.dev']),['DEV/a#1.ifc','DEV/a; b.dev'])
