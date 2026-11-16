from pathlib import Path
import sys,tempfile,unittest
from unittest.mock import Mock,patch
TOOL=Path(__file__).resolve().parents[2];REPO=TOOL.parent.parent
sys.path.insert(0,str(TOOL))
from service_launcher import ServiceLauncher

class LaunchTests(unittest.TestCase):
    def test_gui_launches_only_independent_node_command(self):
        base=REPO/'tmp/gim-blender-service-unit';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            launcher=ServiceLauncher(Path(directory))
            with patch('service_launcher.subprocess.Popen',return_value=Mock()) as started:
                launcher.launch(open_browser=False)
            command=started.call_args.args[0]
            self.assertTrue(command[0].endswith('node.exe'))
            self.assertTrue(command[1].endswith('server.cjs'))
            self.assertNotIn(sys.executable,command)
            self.assertFalse(hasattr(launcher,'stop'),'GUI has no ownership of the running service')

    def test_status_and_url_are_visible_in_default_window(self):
        import tkinter as tk
        from app import Window
        base=REPO/'tmp/gim-blender-service-unit';base.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root=tk.Tk();window=Window(root,Path(directory));root.update_idletasks();root.update()
            try:
                self.assertGreater(window.url_entry.winfo_height(),15)
                self.assertLess(window.url_entry.winfo_rooty()+window.url_entry.winfo_height(),root.winfo_rooty()+root.winfo_height())
                with patch.object(window.service,'launch'),patch.object(window.service,'status',return_value={'url':'http://127.0.0.1:8767/','port':8767,'pid':12}):
                    window.start_demo();root.after_cancel(window.service_timer);window.poll_service()
                    self.assertIn('8767',window.service_state.get());self.assertEqual(window.demo_url.get(),'http://127.0.0.1:8767/')
                window.close()
            finally:
                try:root.destroy()
                except tk.TclError:pass

if __name__=='__main__':unittest.main()
