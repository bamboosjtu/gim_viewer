"""Pure function contracts only: no GIM archives, model folders or engineering samples."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
_ROOT=Path(__file__).resolve().parents[3]
_TEMP=_ROOT/'tmp/tests/python-pure'
_TEMP.mkdir(parents=True,exist_ok=True)
os.environ.update(TEMP=str(_TEMP),TMP=str(_TEMP),TMPDIR=str(_TEMP),GIM_READER_LOG_PATH=str(_TEMP/'gim-reader.log'))
tempfile.tempdir=str(_TEMP)
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

from standard_sources import ifc_string,split_args

class IfcTextContracts(unittest.TestCase):
    def test_adjacent_unicode_segments_remain_adjacent(self):
        slash=chr(92)
        field=(slash+'X2'+slash+'4E3B'+slash+'X0'+slash+slash+'X2'+slash+'53D8'+slash+'X0'+slash).encode('ascii')
        self.assertEqual(ifc_string(field.decode('ascii')), '主变')

    def test_name_is_not_concatenated_with_description(self):
        line=b"#1=IFCBUILDINGELEMENTPROXY('0000000000000000000001',$,'Main O''Brien','Description',$,$,$,$,$);"
        self.assertEqual(ifc_string(split_args(line.decode('ascii').split('(',1)[1].rsplit(')',1)[0])[2]), "Main O'Brien")

    def test_empty_name_is_not_invented(self):
        self.assertEqual(ifc_string('$'),'')
