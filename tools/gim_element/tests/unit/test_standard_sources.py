"""Pure function contracts only: no GIM archives, model folders or engineering samples."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
_ROOT=Path(__file__).resolve().parents[4]
_TEMP=_ROOT/'tmp/tests/python-pure'
_TEMP.mkdir(parents=True,exist_ok=True)
os.environ.update(TEMP=str(_TEMP),TMP=str(_TEMP),TMPDIR=str(_TEMP),GIM_READER_LOG_PATH=str(_TEMP/'gim-reader.log'))
tempfile.tempdir=str(_TEMP)
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))

from standard_sources import ifc_string,split_args,read_ifc,Reader
from unittest.mock import patch

class IfcTextContracts(unittest.TestCase):
    def test_family_pointer_aliases_share_the_document_cache(self):
        from support import MemoryFile
        for key in ('BASEFAMILY','BASEFAMILY1','BASEFAMILYPOINTER','BASEFAM0','FAMILYFILE0'):
            with self.subTest(key=key):
                files={'part.cbm':MemoryFile(key+'=part.fam'),'part.fam':MemoryFile('[设计参数]\n类型=类型=散热器')}
                reader=Reader(_TEMP,files)
                self.assertEqual(reader.families('part.cbm')[0]['value'],'散热器')
                self.assertEqual(reader.families('part.cbm')[0]['path'],'part.fam')
                self.assertTrue(all(f.reads==1 for f in files.values()))
    def test_adjacent_unicode_segments_remain_adjacent(self):
        slash=chr(92)
        field=(slash+'X2'+slash+'4E3B'+slash+'X0'+slash+slash+'X2'+slash+'53D8'+slash+'X0'+slash).encode('ascii')
        self.assertEqual(ifc_string(field.decode('ascii')), '主变')

    def test_name_is_not_concatenated_with_description(self):
        line=b"#1=IFCBUILDINGELEMENTPROXY('0000000000000000000001',$,'Main O''Brien','Description',$,$,$,$,$);"
        self.assertEqual(ifc_string(split_args(line.decode('ascii').split('(',1)[1].rsplit(')',1)[0])[2]), "Main O'Brien")

    def test_empty_name_is_not_invented(self):
        self.assertEqual(ifc_string('$'),'')

    def test_geometry_arguments_are_not_materialized_and_quoted_boundaries_are_retained(self):
        text="/* #7=IFCWALL('ignored'); */#1=IFCCARTESIANPOINT((1.,2.,3.));#2=IFCWALL('0000000000000000000001',$,'Main; #4=IFCWALL(''fake'')',$,$,$,$,$);"
        with patch('standard_sources.split_args',wraps=split_args) as split:
            rows=read_ifc(text,'wall.ifc')
        self.assertEqual(split.call_count,1)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['name'],"Main; #4=IFCWALL('fake')")
