from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent.parent
sys.path.insert(0, str(TOOL))
from library import Library

class CacheTests(unittest.TestCase):
    def setUp(self):
        root = REPO/'tmp/gim-blender-unit'
        root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=root)
        self.path = Path(self.temp.name)
        self.library = Library(self.path/'程序')

    def tearDown(self):
        self.temp.cleanup()

    def record(self):
        source = self.path/'原始文件.gim'
        source.write_bytes(b'ordinary cache identity bytes, not an engineering package')
        rec, reused = self.library.cache(source)
        self.assertFalse(reused)
        result = self.library.project(rec['id'])/'result'
        for name in ['project.blend','web/index.html','web/assets/world.glb','web/assets/scene.json']:
            p = result/name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('{}' if name.endswith('.json') else 'test DTO', encoding='utf-8')
        rec.update(status='ready', title='<img src=x onerror=alert(1)>')
        self.library.save(rec)
        return rec, source

    def test_identity_reuse_delete_only_cached_copy(self):
        rec, source = self.record()
        again, reused = self.library.cache(source)
        self.assertTrue(reused)
        self.assertEqual(again['id'], rec['id'])
        self.assertEqual(len(self.library.entries()), 1)
        self.library.delete(rec['id'])
        self.assertEqual(self.library.entries(), [])
        self.assertTrue(source.exists())
        with self.assertRaises(ValueError):
            self.library.project('../escape')

    def test_three_ui_actions(self):
        import tkinter as tk
        from app import Window
        root = tk.Tk()
        root.withdraw()
        try:
            self.record()
            window = Window(root, self.library.home)
            labels = [b.cget('text') for b in [window.import_button,window.delete_button,window.start_button]]
            self.assertEqual(labels, ['导入 GIM','删除所选','启动 HTML Demo'])
            with patch.object(window.service,'launch') as launched, patch.object(window.service,'status',return_value={'url':'http://127.0.0.1:8768/','port':8768,'pid':123}):
                window.start_demo()
                window.root.after_cancel(window.service_timer)
                window.poll_service()
                launched.assert_called_once_with(open_browser=True)
                self.assertEqual(window.demo_url.get(),'http://127.0.0.1:8768/')
                self.assertIn('8768',window.service_state.get())
            item = window.tree.get_children()[0]
            window.tree.selection_set(item)
            with patch('tkinter.messagebox.askyesno', return_value=True):
                window.delete_file()
            window.delete_future.result(timeout=5)
            root.after_cancel(window.delete_timer)
            window.poll_delete()
            self.assertFalse(window.tree.get_children())
        finally:
            window.close()

    def test_cache_deletion_leaves_tk_event_loop_responsive(self):
        import tkinter as tk
        from app import Window
        rec,_=self.record();root=tk.Tk();root.withdraw()
        window=Window(root,self.library.home)
        entered,release=threading.Event(),threading.Event()
        delete=window.library.delete
        def slow_delete(identity):
            entered.set();release.wait(3);delete(identity)
        try:
            window.tree.selection_set(rec['id'])
            with patch.object(window.library,'delete',side_effect=slow_delete),patch('tkinter.messagebox.askyesno',return_value=True):
                window.delete_file()
                self.assertTrue(entered.wait(1))
                beats=[];root.after(0,lambda:beats.append(True));root.update()
                self.assertTrue(beats)
                self.assertFalse(window.delete_future.done())
                release.set();window.delete_future.result(timeout=5)
                root.after_cancel(window.delete_timer);window.poll_delete()
                self.assertFalse(window.tree.get_children())
        finally:
            release.set();window.close()

if __name__=='__main__':
    unittest.main()
