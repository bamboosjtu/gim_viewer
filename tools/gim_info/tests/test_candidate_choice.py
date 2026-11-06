import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PySide6 import QtCore, QtWidgets
from browse_gui import choose_pointer_candidate


class CandidateChoiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])

    def choose(self, row):
        errors = []

        def act():
            dialog = self.app.activeModalWidget()
            try:
                paths = dialog.findChild(QtWidgets.QListWidget, 'pointer-candidates')
                buttons = dialog.findChild(QtWidgets.QDialogButtonBox, 'pointer-candidate-actions')
                button = buttons.button(QtWidgets.QDialogButtonBox.Open)
                self.assertEqual(paths.currentRow(), -1)
                self.assertFalse(button.isEnabled())
                self.assertEqual([paths.item(i).text() for i in range(paths.count())], ['DEV/a.fam', 'MOD/a.fam'])
                if row is None:
                    dialog.reject()
                else:
                    paths.setCurrentRow(row)
                    self.assertTrue(button.isEnabled())
                    button.click()
            except BaseException as error:
                errors.append(error)
                dialog.reject()

        QtCore.QTimer.singleShot(0, act)
        result = choose_pointer_candidate(None, ('DEV/a.fam', 'MOD/a.fam'))
        if errors:
            raise errors[0]
        return result

    def test_cancel_does_not_select_the_first_candidate(self):
        self.assertIsNone(self.choose(None))

    def test_user_can_choose_the_second_candidate(self):
        self.assertEqual(self.choose(1), 'MOD/a.fam')
