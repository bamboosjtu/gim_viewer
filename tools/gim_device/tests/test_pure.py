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

import collections
import gim_core as core

class MatrixContracts(unittest.TestCase):
    def test_column_major_multiplication_keeps_order(self):
        scale=core._identity();scale[0]=2
        offset=core._identity();offset[12]=3
        self.assertEqual(core.mat_mul(scale,offset)[12],6)
        self.assertEqual(core.mat_mul(offset,scale)[12],3)

    def test_invalid_matrix_falls_back_with_diagnostic(self):
        for value in ['bad','1,2,3',','.join(['0']*16)]:
            notes=collections.Counter()
            self.assertEqual(core.parse_matrix(value,notes),core._identity())
            self.assertTrue(notes)

    def test_nonfinite_translation_is_rejected(self):
        for value in [float('nan'),float('inf'),float('-inf')]:
            matrix=core._identity();matrix[12]=value
            self.assertFalse(core.is_affine(matrix))
            self.assertEqual(core.parse_matrix(','.join(map(str,matrix))),core._identity())
