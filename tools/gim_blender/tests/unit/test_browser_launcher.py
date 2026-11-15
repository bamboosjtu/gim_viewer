import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

TOOL = Path(__file__).resolve().parents[2]
REPO = TOOL.parent.parent
sys.path.insert(0, str(TOOL))
from browser_launcher import local_demo_url, command_for_url, split_windows_command, open_demo


class BrowserTests(unittest.TestCase):
    def test_only_local_demo_url(self):
        self.assertEqual(local_demo_url('http://127.0.0.1:12345/'), 'http://127.0.0.1:12345/')
        for url in ['https://example.com/','file:///C:/file','http://127.0.0.1/','http://user:password@127.0.0.1:123/']:
            with self.assertRaises(ValueError):
                local_demo_url(url)

    @unittest.skipUnless(sys.platform=='win32', 'Windows command parser')
    def test_default_browser_command_quoting(self):
        argv = split_windows_command('"C:\\Program Files\\Browser\\browser.exe" --single-argument %1')
        self.assertEqual(command_for_url(argv, 'http://127.0.0.1:5555/'),
                         ['C:\\Program Files\\Browser\\browser.exe','--single-argument','http://127.0.0.1:5555/'])
        self.assertEqual(command_for_url(['browser'], 'http://127.0.0.1:5555/'), ['browser','http://127.0.0.1:5555/'])

    def test_failed_launch_is_visible_in_main_window(self):
        import tkinter as tk
        from app import Window
        root_dir = REPO/'tmp/gim-blender-browser-unit'
        root_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root_dir) as directory:
            root = tk.Tk();root.withdraw()
            window = Window(root, Path(directory))
            helper = Mock();helper.poll.return_value = 1
            try:
                with patch('app.subprocess.Popen', return_value=helper):
                    window.start_demo()
                window.poll_browser(helper)
                self.assertFalse(window.browser_outcome['ok'])
                self.assertIn('浏览器未打开', window.message.get())
                self.assertTrue(window.demo_url.get().startswith('http://127.0.0.1:'))
            finally:
                window.server.stop();root.destroy()

    def test_invalid_url_result_is_failure(self):
        root_dir = REPO/'tmp/gim-blender-browser-unit'
        root_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root_dir) as directory:
            result = Path(directory)/'result.json'
            self.assertEqual(open_demo('https://example.com/', result), 1)
            self.assertFalse(json.loads(result.read_text(encoding='utf-8'))['ok'])

    def test_waiting_browser_helper_keeps_tk_responsive_and_times_out(self):
        import tkinter as tk
        from app import Window
        root_dir = REPO/'tmp/gim-blender-browser-unit'
        root_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root_dir) as directory:
            root = tk.Tk();root.withdraw();window = Window(root, Path(directory))
            helper = Mock();helper.poll.return_value = None
            try:
                with patch('app.subprocess.Popen', return_value=helper):
                    window.start_demo()
                ticks=[];root.after(0,lambda:ticks.append(True));root.update()
                self.assertEqual(ticks,[True])
                window.browser_deadline=0
                window.poll_browser(helper)
                helper.kill.assert_called_once()
                self.assertFalse(window.browser_outcome['ok'])
                self.assertIn('超时',window.message.get())
            finally:
                window.server.stop();root.destroy()

    def test_process_success_without_page_request_is_not_reported_as_open(self):
        import tkinter as tk
        from app import Window
        from library import write_json
        root_dir=REPO/'tmp/gim-blender-browser-unit';root_dir.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root_dir) as directory:
            root=tk.Tk();root.withdraw();window=Window(root,Path(directory))
            helper=Mock();helper.poll.return_value=0
            try:
                with patch('app.subprocess.Popen',return_value=helper):window.start_demo()
                write_json(window.browser_result,{'ok':True})
                window.browser_deadline=0;window.poll_browser(helper)
                self.assertFalse(window.browser_outcome['ok'])
                self.assertIn('没有访问',window.message.get())
            finally:window.server.stop();root.destroy()

if __name__=='__main__':
    unittest.main()
