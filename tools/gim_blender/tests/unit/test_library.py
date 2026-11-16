import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
from urllib.request import urlopen
from urllib.error import HTTPError

TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent.parent
sys.path.insert(0, str(TOOL))
from library import Library, DemoServer, write_json

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

    def test_http_only_serves_ready_web_and_escapes_titles(self):
        rec, source = self.record()
        server = DemoServer(self.library)
        url = server.start()
        try:
            self.assertEqual(server.start(), url)
            body = urlopen(url).read().decode()
            self.assertIn('&lt;img', body)
            self.assertNotIn('<img src=x', body)
            self.assertEqual(urlopen(url+rec['id']+'/index.html').read(), b'test DTO')
            self.assertIn(b'prepareStaticModel', urlopen(url+rec['id']+'/js/main.js').read(), 'cached projects use the installed runtime')
            for route in ['data/projects/', rec['id']+'/source.gim', rec['id']+'/%2e%2e/source.gim', rec['id']+'/%5c..%5csource.gim']:
                with self.assertRaises(HTTPError) as error:
                    urlopen(url+route)
                self.assertEqual(error.exception.code, 404)
        finally:
            server.stop()

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
            helper = Mock()
            helper.poll.return_value = 0
            with patch('app.subprocess.Popen', return_value=helper) as opened:
                window.start_demo()
                command = opened.call_args.args[0]
                self.assertIn('--open-browser', command)
                self.assertTrue(command[command.index('--open-browser')+1].startswith('http://127.0.0.1:'))
                write_json(window.browser_result, {'ok':True})
                window.server.page_requested.set()
                window.poll_browser(helper)
                self.assertIn('已打开默认浏览器', window.message.get())
            window.server.stop()
            item = window.tree.get_children()[0]
            window.tree.selection_set(item)
            with patch('tkinter.messagebox.askyesno', return_value=True):
                window.delete_file()
            self.assertFalse(window.tree.get_children())
        finally:
            root.destroy()

if __name__=='__main__':
    unittest.main()
