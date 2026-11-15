import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import tkinter as tk
import unittest
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent.parent
sys.path.insert(0, str(TOOL))
from file_picker import GimFilePicker, absolute_path, scan_directory


class PickerTests(unittest.TestCase):
    def setUp(self):
        base = REPO/'tmp/gim-blender-picker-unit'
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.folder = Path(self.temp.name)
        self.root = tk.Tk()
        self.root.withdraw()
        self.selected = []
        self.closed = []
        self.picker = None

    def tearDown(self):
        if self.picker and not self.picker.closed:
            self.picker.cancel()
        self.root.destroy()
        self.temp.cleanup()

    def open(self, directory=None):
        self.picker = GimFilePicker(self.root, directory or self.folder,
                                    self.selected.append, lambda:self.closed.append(True))
        return self.picker

    def pump(self, predicate, timeout=3):
        deadline = time.monotonic()+timeout
        while not predicate() and time.monotonic()<deadline:
            self.root.update()
            time.sleep(.005)
        self.assertTrue(predicate(), 'Tk test did not reach the expected state')

    def test_unicode_filter_and_selection_without_native_dialog(self):
        source = self.folder/'中文 空格.GIM'
        source.write_text('ordinary picker fixture', encoding='utf-8')
        (self.folder/'非工程.txt').write_text('not listed')
        (self.folder/'文件夹').mkdir()
        with patch('tkinter.filedialog.askopenfilename', side_effect=AssertionError('native dialog called')):
            p = self.open()
            self.pump(lambda:not p.loading)
            self.assertEqual(set(p.entries.values()), {('中文 空格.GIM', False), ('文件夹', True)})
            key = next(k for k, row in p.entries.items() if row[0] == source.name)
            p.tree.selection_set(key)
            p.selection_changed()
            p.open_button.invoke()
            self.pump(lambda:p.closed)
        self.assertEqual(self.selected, [str(source)])
        self.assertEqual(self.closed, [True])

    def test_slow_scan_keeps_event_loop_alive_and_late_result_is_discarded(self):
        slow = self.folder/'slow'
        fast = self.folder/'fast'
        slow.mkdir(); fast.mkdir()
        (fast/'new.gim').write_text('ordinary name fixture')
        started = threading.Event()
        release = threading.Event()
        def scan(directory):
            if directory == str(slow):
                started.set()
                release.wait(3)
                return [('late.gim', False)]
            return scan_directory(directory)
        try:
            with patch('file_picker.scan_directory', side_effect=scan):
                p = self.open(slow)
                self.pump(started.is_set)
                heartbeat = []
                self.root.after(0, lambda:heartbeat.append(True))
                self.pump(lambda:bool(heartbeat))
                p.navigate(str(fast))
                self.pump(lambda:not p.loading)
                self.assertEqual(list(p.entries.values()), [('new.gim', False)])
                release.set()
                p.results.put((p.generation-1, 'scan', str(slow), [('late.gim', False)], None))
                p.poll()
                self.assertEqual(list(p.entries.values()), [('new.gim', False)])
        finally:
            release.set()

    def test_cancel_during_scan_and_reopen(self):
        release = threading.Event()
        try:
            with patch('file_picker.scan_directory', side_effect=lambda p:(release.wait(3) and [])):
                p = self.open()
                p.cancel()
                self.assertTrue(p.closed)
                self.assertEqual(self.selected, [])
            release.set()
            p = self.open()
            self.pump(lambda:not p.loading)
            p.cancel()
            self.assertEqual(len(self.closed), 2)
        finally:
            release.set()

    def test_full_path_missing_file_and_invalid_extension(self):
        source = self.folder/'输入 文件.gim'
        source.write_text('ordinary picker fixture')
        p = self.open()
        self.pump(lambda:not p.loading)
        p.filename.set('not-a-gim.txt'); p.accept()
        self.assertIn('.gim', p.status.get())
        p.filename.set('missing.gim'); p.accept()
        self.pump(lambda:not p.validating)
        self.assertIn('不存在', p.status.get())
        p.filename.set('"'+str(source)+'"'); p.accept()
        self.pump(lambda:p.closed)
        self.assertEqual(self.selected, [str(source)])

    def test_directory_with_gim_suffix_and_address_file_path(self):
        folder = self.folder/'folder.gim'
        folder.mkdir()
        source = folder/'file.gim'
        source.write_text('ordinary picker fixture')
        p = self.open()
        p.navigate(str(folder))
        self.pump(lambda:not p.loading)
        self.assertEqual(list(p.entries.values()), [('file.gim', False)])
        p.navigate(str(source))
        self.pump(lambda:p.closed)
        self.assertEqual(self.selected, [str(source)])

    def test_large_listing_is_inserted_in_batches(self):
        p = self.open()
        self.pump(lambda:not p.loading)
        p.loading = True
        rows = [(f'{i}.gim', False) for i in range(601)]
        p.insert_batch(p.generation, rows, 0)
        self.assertEqual(len(p.tree.get_children()), 200)
        self.pump(lambda:not p.loading)
        self.assertEqual(len(p.tree.get_children()), 601)

    def test_cancel_during_batched_render_cancels_all_timers(self):
        p = self.open()
        self.pump(lambda:not p.loading)
        p.loading = True
        p.insert_batch(p.generation, [(f'{i}.gim', False) for i in range(601)], 0)
        self.assertTrue(p.timers)
        p.cancel()
        self.root.update()
        self.assertEqual(p.timers, set())
        self.assertEqual(self.selected, [])

    def test_main_window_import_uses_picker_callback_once(self):
        from app import Window
        source = self.folder/'选择.gim'
        source.write_text('ordinary picker fixture')
        window = Window(self.root, self.folder)
        with patch.object(window, 'begin_import') as begin:
            with patch('tkinter.filedialog.askopenfilename', side_effect=AssertionError('native dialog called')):
                window.import_button.invoke()
                self.picker = window.picker
                window.import_file()
                self.assertIs(window.picker, self.picker, 'repeated import clicks reuse the existing picker')
                self.pump(lambda:not self.picker.loading)
                self.picker.filename.set(source.name)
                self.picker.accept()
                self.pump(lambda:self.picker.closed)
            begin.assert_called_once_with(str(source))
            self.assertIsNone(window.picker)

if __name__=='__main__':
    unittest.main()
