"""GIM picker implemented with Tk widgets; never starts a Windows Shell dialog.

Directory I/O runs in daemon workers. Only the Tk thread touches widgets, and
generation tokens discard late results after navigation or closing the picker.
"""
from __future__ import annotations
import os
from pathlib import Path
from queue import Empty, Queue
import threading
import tkinter as tk
from tkinter import ttk


def absolute_path(text: str, directory: str) -> str:
    value = os.path.expandvars(os.path.expanduser(text.strip().strip('"')))
    return os.path.abspath(value if os.path.isabs(value) else os.path.join(directory, value))


def scan_directory(directory: str):
    rows = []
    with os.scandir(directory) as entries:
        for entry in entries:
            try:
                is_dir = entry.is_dir()
            except OSError:
                continue
            if is_dir or Path(entry.name).suffix.casefold() == '.gim':
                rows.append((entry.name, is_dir))
    return sorted(rows, key=lambda row: (not row[1], row[0].casefold(), row[0]))


def scan_worker(jobs, results, stopped):
    # No Tk object is captured by worker threads, including a blocked network scan.
    while not stopped.is_set():
        try:
            job = jobs.get(timeout=.2)
        except Empty:
            continue
        generation, directory = job
        try:
            result = scan_directory(directory)
            message = (generation, 'scan', directory, result, None)
        except NotADirectoryError as exc:
            if Path(directory).suffix.casefold() == '.gim' and Path(directory).is_file():
                message = (generation, 'file', directory, None, None)
            else:
                message = (generation, 'scan', directory, [], str(exc))
        except OSError as exc:
            message = (generation, 'scan', directory, [], str(exc))
        if not stopped.is_set():
            results.put(message)


def validate_file(path, generation, results, stopped):
    try:
        if not Path(path).is_file():
            raise ValueError('文件不存在，请检查文件名或完整路径。')
        error = None
    except (OSError, ValueError) as exc:
        error = str(exc)
    if not stopped.is_set():
        results.put((generation, 'file', path, None, error))


class GimFilePicker:
    def __init__(self, parent, directory, on_selected, on_closed):
        self.on_selected = on_selected
        self.on_closed = on_closed
        self.closed = False
        self.loading = False
        self.validating = False
        self.generation = 0
        self.directory = os.path.abspath(str(directory))
        self.entries = {}
        self.timers = set()
        self.jobs = Queue(maxsize=1)
        self.results = Queue()
        self.stopped = threading.Event()
        self.window = tk.Toplevel(parent)
        self.window.title('导入变电站 GIM')
        self.window.geometry('860x540')
        self.window.minsize(660, 400)
        self.window.transient(parent)
        self.window.protocol('WM_DELETE_WINDOW', self.cancel)
        self.window.bind('<Escape>', lambda event: self.cancel())
        self.window.bind('<Control-l>', self.focus_address)
        content = ttk.Frame(self.window, padding=16)
        content.pack(fill='both', expand=True)
        bar = ttk.Frame(content)
        bar.pack(fill='x')
        ttk.Label(bar, text='文件夹').pack(side='left', padx=(0, 8))
        self.address = tk.StringVar(value=self.directory)
        self.address_entry = ttk.Entry(bar, textvariable=self.address)
        self.address_entry.pack(side='left', fill='x', expand=True)
        self.address_entry.bind('<Return>', lambda event: self.navigate(self.address.get()))
        ttk.Button(bar, text='前往', command=lambda:self.navigate(self.address.get())).pack(side='left', padx=(8, 0))
        ttk.Button(bar, text='上一级', command=self.up).pack(side='left', padx=(8, 0))
        listing = ttk.Frame(content)
        listing.pack(fill='both', expand=True, pady=(12, 8))
        self.tree = ttk.Treeview(listing, columns=('kind',), show='tree headings', selectmode='browse')
        self.tree.heading('#0', text='名称')
        self.tree.heading('kind', text='类型')
        self.tree.column('#0', width=560)
        self.tree.column('kind', width=100, stretch=False)
        scroll = ttk.Scrollbar(listing, orient='vertical', command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        scroll.pack(side='right', fill='y')
        self.tree.pack(side='left', fill='both', expand=True)
        self.tree.bind('<<TreeviewSelect>>', self.selection_changed)
        self.tree.bind('<Double-1>', self.open_selection)
        self.tree.bind('<Return>', self.open_selection)
        self.status = tk.StringVar()
        ttk.Label(content, textvariable=self.status, wraplength=800).pack(anchor='w', pady=(0, 8))
        bottom = ttk.Frame(content)
        bottom.pack(fill='x')
        ttk.Label(bottom, text='文件名').pack(side='left', padx=(0, 8))
        self.filename = tk.StringVar()
        self.filename_entry = ttk.Entry(bottom, textvariable=self.filename)
        self.filename_entry.pack(side='left', fill='x', expand=True)
        self.filename_entry.bind('<Return>', lambda event:self.accept())
        self.open_button = ttk.Button(bottom, text='导入', command=self.accept)
        self.open_button.pack(side='left', padx=(10, 0))
        ttk.Button(bottom, text='取消', command=self.cancel).pack(side='left', padx=(8, 0))
        ttk.Label(content, text='只显示文件夹和 .gim 文件；也可以直接粘贴 GIM 文件的完整路径。').pack(anchor='w', pady=(10, 0))
        for _ in range(2):
            threading.Thread(target=scan_worker, args=(self.jobs, self.results, self.stopped), daemon=True).start()
        self.schedule(30, self.poll)
        self.navigate(self.directory)
        self.window.grab_set()
        self.filename_entry.focus_set()

    def focus_address(self, event=None):
        self.address_entry.focus_set()
        self.address_entry.selection_range(0, 'end')
        return 'break'

    def schedule(self, delay, callback):
        token = None
        def fire():
            self.timers.discard(token)
            if not self.closed:
                callback()
        token = self.window.after(delay, fire)
        self.timers.add(token)
        return token

    def navigate(self, text):
        if self.closed:
            return
        path = absolute_path(text, self.directory)
        self.generation += 1
        self.validating = False
        self.open_button.configure(state='normal')
        self.directory = path
        self.address.set(path)
        self.filename.set('')
        self.entries = {}
        self.tree.delete(*self.tree.get_children())
        self.loading = True
        self.status.set('正在读取文件夹… 可取消或直接输入文件完整路径。')
        # Only retain the newest queued navigation while workers are busy.
        try:
            self.jobs.get_nowait()
        except Empty:
            pass
        self.jobs.put_nowait((self.generation, path))

    def up(self):
        self.navigate(os.path.dirname(self.directory))

    def selection_changed(self, event=None):
        selected = self.tree.selection()
        if selected and selected[0] in self.entries:
            name, is_dir = self.entries[selected[0]]
            self.filename.set('' if is_dir else name)

    def open_selection(self, event=None):
        selected = self.tree.selection()
        if selected and selected[0] in self.entries:
            name, is_dir = self.entries[selected[0]]
            if is_dir:
                self.navigate(os.path.join(self.directory, name))
            else:
                self.filename.set(name)
                self.accept()
        return 'break'

    def accept(self):
        if self.closed or self.validating:
            return
        filename = self.filename.get().strip()
        if not filename:
            self.status.set('请选择 .gim 文件，或输入完整路径。')
            self.filename_entry.focus_set()
            return
        path = absolute_path(filename, self.directory)
        if Path(path).suffix.casefold() != '.gim':
            self.status.set('请选择扩展名为 .gim 的文件。')
            return
        self.generation += 1
        self.loading = False
        self.validating = True
        self.open_button.configure(state='disabled')
        self.status.set('正在检查所选文件…')
        threading.Thread(target=validate_file, args=(path, self.generation, self.results, self.stopped), daemon=True).start()

    def poll(self):
        if self.closed:
            return
        for _ in range(8):
            try:
                generation, kind, path, rows, error = self.results.get_nowait()
            except Empty:
                break
            if generation != self.generation:
                continue
            if kind == 'file':
                self.validating = False
                self.open_button.configure(state='normal')
                if error:
                    self.status.set(error)
                else:
                    self.finish(path)
                    return
            elif error:
                self.loading = False
                self.status.set('无法读取文件夹：'+error+'　可以输入其他文件夹或文件完整路径。')
            else:
                self.insert_batch(generation, rows, 0)
        self.schedule(30, self.poll)

    def insert_batch(self, generation, rows, start):
        if self.closed or generation != self.generation:
            return
        end = min(start + 200, len(rows))
        for index in range(start, end):
            name, is_dir = rows[index]
            key = str(index)
            self.entries[key] = (name, is_dir)
            self.tree.insert('', 'end', iid=key, text=name, values=('文件夹' if is_dir else 'GIM 文件',))
        if end < len(rows):
            self.schedule(1, lambda:self.insert_batch(generation, rows, end))
        else:
            self.loading = False
            folders = sum(is_dir for name, is_dir in rows)
            self.status.set(f'{folders} 个文件夹 · {len(rows)-folders} 个 GIM 文件')

    def finish(self, path=None):
        if self.closed:
            return
        self.closed = True
        self.generation += 1
        self.stopped.set()
        for timer in self.timers:
            self.window.after_cancel(timer)
        self.timers.clear()
        self.window.grab_release()
        self.window.destroy()
        self.on_closed()
        if path is not None:
            self.on_selected(path)

    def cancel(self):
        self.finish()
