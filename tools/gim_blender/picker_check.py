"""Explicit local frozen-EXE smoke for the picker and its import handoff.

Uses the app's widgets and Tk event loop; no Windows UI automation or Shell
dialog. The caller supplies a workspace-staged source and an existing cache.
"""
import json
from pathlib import Path
import tkinter as tk


def run(home, source, result):
    from app import Window
    source = Path(source).absolute()
    result = Path(result).absolute()
    root = tk.Tk()
    window = Window(root, home)
    window.import_directory = source.parent
    report = {'passed': False, 'heartbeats': 0, 'pickerOpened': False,
              'selectedPath': None, 'importCompleted': False, 'errors': []}
    original_import = window.begin_import

    def observe_import(path):
        report['selectedPath'] = path
        original_import(path)
    window.begin_import = observe_import

    def finish(error=None):
        if error:
            report['errors'].append(str(error))
        if window.picker:
            window.picker.cancel()
        report['passed'] = (not report['errors'] and report['pickerOpened'] and
                            report['importCompleted'] and report['heartbeats'] > 1 and
                            Path(report['selectedPath'] or '').absolute() == source)
        result.parent.mkdir(parents=True, exist_ok=True)
        result.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        root.destroy()

    def callback_error(kind, value, traceback):
        finish(value)
    root.report_callback_exception = callback_error

    def heartbeat():
        report['heartbeats'] += 1
        root.after(10, heartbeat)

    def check():
        if report['selectedPath'] is None:
            picker = window.picker
            if picker and not picker.loading:
                report['pickerOpened'] = bool(picker.tree.winfo_exists())
                report['listedNames'] = [row[0] for row in picker.entries.values()]
                key = next((key for key, row in picker.entries.items() if row == (source.name, False)), None)
                if key is None:
                    finish('staged GIM was not listed')
                    return
                picker.tree.selection_set(key)
                picker.selection_changed()
                picker.open_button.invoke()
        elif window.process is None:
            report['importCompleted'] = (window.progress['value'] == 8 and
                                        any(row['status'] in ('ready', 'partial') for row in window.rows.values()))
            report['message'] = window.message.get()
            finish(None if report['importCompleted'] else report['message'])
            return
        root.after(30, check)

    root.after(10, heartbeat)
    root.after(20, window.import_button.invoke)
    root.after(50, check)
    root.after(15000, lambda:finish('picker check timed out'))
    root.mainloop()
    return 0 if report['passed'] else 1
