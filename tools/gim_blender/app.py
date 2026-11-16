"""Three-action desktop shell; conversion and browsing stay in owned processes."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from library import Library, application_home, resources, node_runtime, demo_runtime

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
        from service_launcher import ServiceLauncher
        self.service = ServiceLauncher(self.library.home)
        self.process = None
        self.delete_executor = None
        self.delete_future = None
        self.delete_timer = None
        self.picker = None
        self.import_directory = self.library.home
        self.service_starting = False
        self.service_timer = None
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
        frame.columnconfigure(0,weight=1)
        frame.rowconfigure(3,weight=1)
        ttk.Label(frame,text='GIM Blender',font=('Microsoft YaHei UI',22,'bold')).grid(row=0,column=0,sticky='w')
        ttk.Label(frame,text='导入转换与 HTML 服务独立运行；关闭本窗口不会停止服务。').grid(row=1,column=0,sticky='w',pady=(5,12))
        self.tree = ttk.Treeview(frame, columns=('status', 'file'), show='tree headings', selectmode='browse', height=6)
        self.tree.heading('#0', text='工程')
        self.tree.heading('status', text='状态')
        self.tree.heading('file', text='导入文件')
        self.tree.column('#0', width=360)
        self.tree.column('status', width=130, stretch=False)
        self.tree.column('file', width=220)
        self.tree.grid(row=3,column=0,sticky='nsew')
        actions = ttk.Frame(frame)
        actions.grid(row=4,column=0,sticky='ew',pady=(14,10))
        self.import_button = ttk.Button(actions, text='导入 GIM', command=self.import_file)
        self.delete_button = ttk.Button(actions, text='删除所选', command=self.delete_file)
        self.start_button = ttk.Button(actions, text='启动 HTML Demo', command=self.start_demo)
        for button in (self.import_button, self.delete_button, self.start_button):
            button.pack(side='left', padx=(0, 12), ipadx=12, ipady=5)
        self.progress = ttk.Progressbar(frame, maximum=8, mode='determinate')
        self.progress.grid(row=5,column=0,sticky='ew')
        self.message = tk.StringVar(value='选择 GIM 文件开始，模型缓存在程序旁 data/ 中。')
        ttk.Label(frame, textvariable=self.message, wraplength=820).grid(row=6,column=0,sticky='w',pady=(8,0))
        self.demo_url = tk.StringVar()
        self.service_state = tk.StringVar(value='独立服务未启动')
        status = ttk.Frame(frame)
        status.grid(row=2,column=0,sticky='ew',pady=(0,12))
        status.columnconfigure(1,weight=1)
        ttk.Label(status,textvariable=self.service_state).grid(row=0,column=0,columnspan=2,sticky='w')
        ttk.Label(status,text='服务地址：').grid(row=1,column=0,sticky='w',pady=(5,0))
        self.url_entry=ttk.Entry(status,textvariable=self.demo_url,state='readonly')
        self.url_entry.grid(row=1,column=1,sticky='ew',pady=(5,0))
        self.tree.bind('<<TreeviewSelect>>', lambda e:self.selection_message())
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        self.refresh()
        status = self.service.status()
        if status:
            self.show_service_status(status)

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
        busy = self.process is not None or self.delete_future is not None
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
        if self.process or self.delete_future:
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
        if self.process or self.delete_future:
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
        if not selected or self.process or self.delete_future:
            return
        ident = selected[0]
        if not messagebox.askyesno('删除已导入项目', '删除“'+self.rows[ident]['title']+'”的缓存和转换结果？\n原始导入文件不会被删除。', parent=self.root):
            return
        if self.delete_executor is None:
            self.delete_executor = ThreadPoolExecutor(max_workers=1)
        self.delete_future = self.delete_executor.submit(self.library.delete, ident)
        self.progress.configure(mode='indeterminate')
        self.progress.start(15)
        self.message.set('正在删除所选缓存…')
        self.refresh()
        self.delete_timer = self.root.after(100, self.poll_delete)

    def poll_delete(self):
        from tkinter import messagebox
        self.delete_timer = None
        if not self.delete_future.done():
            self.delete_timer = self.root.after(100, self.poll_delete)
            return
        completed, self.delete_future = self.delete_future, None
        self.progress.stop()
        self.progress.configure(mode='determinate', value=0)
        try:
            completed.result()
            self.message.set('已删除所选项目。')
        except Exception as exc:
            messagebox.showerror('删除失败', str(exc), parent=self.root)
        self.refresh()

    def start_demo(self):
        from tkinter import messagebox
        if self.service_starting:
            return
        try:
            self.service.launch(open_browser=True)
            self.service_starting=True
            self.service_deadline=time.monotonic()+12
            self.service_state.set('正在启动独立命令行服务…')
            self.message.set('服务启动后会显示端口；也可以双击 start_demo.cmd 单独运行。')
            self.service_timer=self.root.after(100,self.poll_service)
        except Exception as exc:
            messagebox.showerror('无法启动独立服务',str(exc),parent=self.root)

    def poll_service(self):
        self.service_timer=None
        status=self.service.status()
        if status:
            self.service_starting=False
            self.show_service_status(status)
            self.message.set('地址已就绪，已请求用 Chrome 打开。可复制上方地址；关闭本窗口服务仍运行。')
        elif time.monotonic()<self.service_deadline:
            self.service_timer=self.root.after(150,self.poll_service)
        else:
            self.service_starting=False
            self.service_state.set('独立服务未能启动')
            self.message.set('请查看 '+str(self.service.log_file))

    def show_service_status(self, status):
        self.demo_url.set(status['url'])
        self.service_state.set(f"独立服务运行中 · 端口 {status['port']} · PID {status['pid']}")

    def close(self):
        from tkinter import messagebox
        if self.picker is not None:
            self.picker.cancel()
        if self.service_timer is not None:
            self.root.after_cancel(self.service_timer)
            self.service_timer=None
        if self.delete_timer is not None:
            self.root.after_cancel(self.delete_timer)
            self.delete_timer=None
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
        if self.delete_executor:
            self.delete_executor.shutdown(wait=False)
        self.root.destroy()

def main():
    parser = argparse.ArgumentParser(description='GIM Blender desktop tool')
    parser.add_argument('--self-check', action='store_true')
    parser.add_argument('--worker-import', default='', help=argparse.SUPPRESS)
    parser.add_argument('--home', default='', help=argparse.SUPPRESS)
    parser.add_argument('--log', default='', help=argparse.SUPPRESS)
    args = parser.parse_args()
    home = Path(args.home).resolve() if args.home else application_home()
    if args.self_check:
        import tkinter as tk
        import numpy, py7zr
        assert all((resources()/name).is_file() for name in ['node/export_gim.mjs','node/export_ifc.cjs'])
        assert node_runtime().is_file() and (demo_runtime()/'index.html').is_file()
        root = tk.Tk()
        root.withdraw()
        root.update_idletasks()
        root.destroy()
        return 0
    setup_temp(home)
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
