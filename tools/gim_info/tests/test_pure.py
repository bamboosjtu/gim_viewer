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

import gimbrowse as core

class TextContracts(unittest.TestCase):
    def test_encoding_fallback_preserves_chinese(self):
        for encoding in ['utf-8-sig','gb18030','utf-16']:
            self.assertEqual(core._decode('名称=主变'.encode(encoding))[0],'名称=主变')

    def test_kv_keeps_equals_in_values(self):
        self.assertEqual(core._strict_kv([' NAME=A=B ', 'TYPE=Device']), {'NAME':'A=B','TYPE':'Device'})

    def test_step_and_xml_are_not_kv(self):
        for lines in [["#1=IFCPROJECT('id');"],['<?xml version="1.0"?>'],['plain text']]:
            self.assertIsNone(core._strict_kv(lines))
