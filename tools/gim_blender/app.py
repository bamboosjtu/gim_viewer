"""Three-action desktop shell; conversion and browsing stay in owned processes."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid
from library import Library, DemoServer, application_home, resources, read_json

STATUS = {'ready':'可漫游', 'partial':'可漫游 · 部分表示', 'converting':'转换中', 'error':'导入失败'}

def setup_temp(home):
    import tempfile
    folder = home/'data/tmp'
    folder.mkdir(parents=True, exist_ok=True)
    os.environ.update(TEMP=str(folder), TMP=str(folder), TMPDIR=str(folder), PYTHONDONTWRITEBYTECODE='1')
    tempfile.tempdir = str(folder)

class Window:
    def __init__(self, root, home):
        import tkinter as tk
        from tkinter import ttk
        self.root = root
        self.library = Library(home)
        self.server = DemoServer(self.library)
        self.process = None
        self.picker = None
        self.import_directory = self.library.home
        self.browser_process = None
        self.browser_outcome = None
        self.browser_timer = None
        self.log_offset = 0
        self.log_buffer = ''
        self.root.title('GIM Blender · 变电站漫游')
        self.root.geometry('900x560')
        self.root.minsize(720, 430)
        style = ttk.Style()
        if 'vista' in style.theme_names():
            style.theme_use('vista')
        style.configure('Treeview', rowheight=32)
        frame = ttk.Frame(root, padding=24)
        frame.pack(fill='both', expand=True)
        ttk.Label(frame, text='GIM Blender', font=('Microsoft YaHei UI', 22, 'bold')).pack(anchor='w')
        ttk.Label(frame, text='导入变电站 GIM，自动生成 Blender 与 HTML，在浏览器中第一人称巡视。').pack(anchor='w', pady=(5, 20))
        self.tree = ttk.Treeview(frame, columns=('status', 'file'), show='tree headings', selectmode='browse')
        self.tree.heading('#0', text='工程')
        self.tree.heading('status', text='状态')
        self.tree.heading('file', text='导入文件')
        self.tree.column('#0', width=360)
        self.tree.column('status', width=130, stretch=False)
        self.tree.column('file', width=220)
        self.tree.pack(fill='both', expand=True)
        actions = ttk.Frame(frame)
        actions.pack(fill='x', pady=(18, 12))
        self.import_button = ttk.Button(actions, text='导入 GIM', command=self.import_file)
        self.delete_button = ttk.Button(actions, text='删除所选', command=self.delete_file)
        self.start_button = ttk.Button(actions, text='启动 HTML Demo', command=self.start_demo)
        for button in (self.import_button, self.delete_button, self.start_button):
            button.pack(side='left', padx=(0, 12), ipadx=12, ipady=5)
        self.progress = ttk.Progressbar(frame, maximum=8, mode='determinate')
        self.progress.pack(fill='x')
        self.message = tk.StringVar(value='选择 GIM 文件开始；已导入项目会保存在程序旁 data/ 中。')
        ttk.Label(frame, textvariable=self.message, wraplength=820).pack(anchor='w', pady=(9, 0))
        self.demo_url = tk.StringVar()
        url_label = ttk.Label(frame, textvariable=self.demo_url, foreground='#176a89', cursor='hand2')
        url_label.pack(anchor='w', pady=(4, 0))
        url_label.bind('<Button-1>', lambda event:self.start_demo())
        self.tree.bind('<<TreeviewSelect>>', lambda e:self.selection_message())
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        self.refresh()

    def refresh(self):
        selected = self.tree.selection()
        self.rows = {r['id']:r for r in self.library.entries()}
        for ident in self.tree.get_children():
            if ident not in self.rows:
                self.tree.delete(ident)
        for ident, rec in self.rows.items():
            values = (STATUS.get(rec['status'], rec['status']), rec['sourceName'])
            if self.tree.exists(ident):
                self.tree.item(ident, text=rec['title'], values=values)
            else:
                self.tree.insert('', 'end', iid=ident, text=rec['title'], values=values)
        if selected and self.tree.exists(selected[0]):
            self.tree.selection_set(selected[0])
        busy = self.process is not None
        self.import_button.configure(state='disabled' if busy else 'normal')
        self.delete_button.configure(state='disabled' if busy else 'normal')
        self.start_button.configure(state='normal' if any(self.library.ready(r) for r in self.rows.values()) else 'disabled')

    def selection_message(self):
        selected = self.tree.selection()
        if not self.process and selected:
            rec = self.rows[selected[0]]
            if rec.get('error'):
                self.message.set(rec['error'])

    def import_file(self):
        if self.process:
            return
        if self.picker is not None:
            self.picker.window.lift()
            return
        from file_picker import GimFilePicker
        self.picker = GimFilePicker(self.root, self.import_directory,
                                   self.selected_file, self.picker_closed)

    def picker_closed(self):
        self.picker = None

    def selected_file(self, source):
        self.import_directory = Path(source).parent
        self.begin_import(source)

    def begin_import(self, source):
        if self.process:
            return
        self.log_path = self.library.data/'tmp'/('import-'+uuid.uuid4().hex+'.log')
        args = [sys.executable]
        if not getattr(sys, 'frozen', False):
            args.append(str(Path(__file__).resolve()))
        args += ['--worker-import', str(source), '--home', str(self.library.home), '--log', str(self.log_path)]
        flags = subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        self.process = subprocess.Popen(args, creationflags=flags, env=os.environ.copy(), cwd=self.library.home)
        self.log_offset = 0
        self.log_buffer = ''
        self.progress['value'] = 0
        self.message.set('正在缓存 GIM…')
        self.refresh()
        self.root.after(150, self.poll)

    def poll(self):
        if self.log_path.exists():
            with self.log_path.open('r', encoding='utf-8', errors='replace') as stream:
                stream.seek(self.log_offset)
                self.log_buffer += stream.read()
                self.log_offset = stream.tell()
            lines = self.log_buffer.split('\n')
            self.log_buffer = lines.pop()
            for line in lines:
                if line.startswith('@progress '):
                    try:
                        event = json.loads(line[10:])
                        self.progress['value'] = event['step']
                        self.message.set(event['text'])
                    except (ValueError, KeyError):
                        pass
        code = self.process.poll()
        if code is None:
            self.root.after(200, self.poll)
            return
        self.process = None
        self.refresh()
        if code:
            errors = [r for r in self.rows.values() if r['status']=='error']
            self.message.set((max(errors, key=lambda r:r.get('updatedAt','')).get('error') if errors else None) or f'导入失败，请查看 {self.log_path}')

    def delete_file(self):
        from tkinter import messagebox
        selected = self.tree.selection()
        if not selected or self.process:
            return
        ident = selected[0]
        if not messagebox.askyesno('删除已导入项目', '删除“'+self.rows[ident]['title']+'”的缓存和转换结果？\n原始导入文件不会被删除。', parent=self.root):
            return
        try:
            self.server.stop()
            self.library.delete(ident)
            self.message.set('已删除所选项目。')
            self.refresh()
        except Exception as exc:
            messagebox.showerror('删除失败', str(exc), parent=self.root)

    def start_demo(self):
        from tkinter import messagebox
        if self.browser_process is not None:
            return
        try:
            url = self.server.start()
            self.server.page_requested.clear()
            self.demo_url.set(url)
            self.message.set('漫游服务已启动，正在打开默认浏览器…')
            self.browser_outcome = None
            self.browser_result = self.library.data/'tmp'/('browser-'+uuid.uuid4().hex+'.json')
            args = [sys.executable]
            if not getattr(sys, 'frozen', False):
                args.append(str(Path(__file__).resolve()))
            args += ['--open-browser', url, '--browser-result', str(self.browser_result)]
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            process = subprocess.Popen(args, creationflags=flags, cwd=self.library.home, env=os.environ.copy())
            self.browser_process = process
            self.browser_deadline = time.monotonic()+15
            self.browser_timer = self.root.after(100, lambda:self.poll_browser(process))
        except Exception as exc:
            messagebox.showerror('无法启动 Demo', str(exc), parent=self.root)

    def poll_browser(self, process):
        if self.browser_timer is not None:
            self.root.after_cancel(self.browser_timer)
            self.browser_timer = None
        if self.browser_process is not process:
            return
        if process.poll() is None and time.monotonic() < self.browser_deadline:
            self.browser_timer = self.root.after(100, lambda:self.poll_browser(process))
            return
        if process.poll() is None:
            process.kill()
            process.wait()
            outcome = {'ok': False, 'error': '打开浏览器超时'}
        else:
            try:
                outcome = read_json(self.browser_result)
            except (OSError, ValueError):
                outcome = {'ok': False, 'error': '浏览器启动进程未返回结果'}
        if outcome.get('ok') and not self.server.page_requested.is_set():
            if time.monotonic() < self.browser_deadline:
                self.browser_timer = self.root.after(100, lambda:self.poll_browser(process))
                return
            outcome = {**outcome, 'ok':False, 'error':'浏览器没有访问 Demo 页面'}
        self.browser_process = None
        self.browser_outcome = outcome
        if outcome.get('ok'):
            self.message.set('已打开默认浏览器。关闭本窗口会停止漫游服务。')
        else:
            self.message.set('服务已启动，浏览器未打开：'+outcome.get('error', '未知错误')+'。点击下方地址重试。')

    def close(self):
        from tkinter import messagebox
        if self.picker is not None:
            self.picker.cancel()
        if self.browser_timer is not None:
            self.root.after_cancel(self.browser_timer)
            self.browser_timer = None
        if self.browser_process is not None:
            if self.browser_process.poll() is None:
                self.browser_process.kill()
                self.browser_process.wait()
            self.browser_process = None
        if self.process:
            if not messagebox.askyesno('退出 GIM Blender', '正在导入。退出会中止本次转换，之后可重新导入。', parent=self.root):
                return
            if os.name=='nt' and self.process.poll() is None:
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'], creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True)
            elif self.process.poll() is None:
                self.process.terminate()
            self.process.wait(timeout=10)
            # Mark the interrupted import explicitly instead of reporting ready.
            for rec in self.library.entries():
                if rec['status']=='converting':
                    rec.update(status='error', error='转换已中止，请重新导入。')
                    self.library.save(rec)
        self.server.stop()
        self.root.destroy()

def main():
    parser = argparse.ArgumentParser(description='GIM Blender desktop tool')
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--worker-import', default='', help=argparse.SUPPRESS)
    parser.add_argument('--home', default='', help=argparse.SUPPRESS)
    parser.add_argument('--log', default='', help=argparse.SUPPRESS)
    parser.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--url-file', default='', help=argparse.SUPPRESS)
    parser.add_argument('--picker-check', default='', help=argparse.SUPPRESS)
    parser.add_argument('--check-result', default='', help=argparse.SUPPRESS)
    parser.add_argument('--open-browser', default='', help=argparse.SUPPRESS)
    parser.add_argument('--browser-result', default='', help=argparse.SUPPRESS)
    parser.add_argument('--flow-check', default='', help=argparse.SUPPRESS)
    args = parser.parse_args()
    home = Path(args.home).resolve() if args.home else application_home()
    if args.self_check:
        import tkinter as tk
        import numpy, py7zr
        assert all((resources()/name).is_file() for name in ['node/export_gim.mjs','node/export_ifc.cjs','runtime/node.exe','web/index.html'])
        root = tk.Tk()
        root.withdraw()
        root.update_idletasks()
        root.destroy()
        return 0
    setup_temp(home)
    if args.open_browser:
        from browser_launcher import open_demo
        return open_demo(args.open_browser, args.browser_result)
    if args.flow_check:
        from flow_check import run
        return run(home, args.flow_check, args.check_result)
    if args.picker_check:
        from picker_check import run
        return run(home, args.picker_check, args.check_result)
    if args.worker_import:
        stream = open(args.log, 'w', encoding='utf-8', buffering=1) if args.log else sys.stdout
        sys.stdout = sys.stderr = stream
        from converter import convert
        try:
            convert(home, args.worker_import)
        except BaseException:
            import traceback
            traceback.print_exc()
            return 1
        return 0
    if args.serve:
        server = DemoServer(Library(home))
        url = server.start()
        if args.url_file:
            Path(args.url_file).write_text(url, encoding='utf-8')
        try:
            while True:
                time.sleep(.25)
        except KeyboardInterrupt:
            server.stop()
        return 0
    import tkinter as tk
    root = tk.Tk()
    try:
        Window(root, home)
        root.mainloop()
    except Exception as exc:
        from tkinter import messagebox
        messagebox.showerror('GIM Blender', str(exc), parent=root)
        return 1
    return 0

if __name__=='__main__':
    try:
        code = main()
    except Exception:
        if '--self-check' not in sys.argv:
            raise
        import traceback
        (Path(os.environ['TEMP'])/'gim-blender-startup-error.txt').write_text(traceback.format_exc(), encoding='utf-8')
        code = 1
    raise SystemExit(code)
