"""Local cold-import integration entry, using the frozen app's own Tk actions."""
import json
from pathlib import Path
import time
import tkinter as tk


def run(home, source, result):
    from app import Window
    source, result = Path(source).absolute(), Path(result).absolute()
    root = tk.Tk()
    window = Window(root, home)
    if window.library.entries():
        root.destroy()
        raise ValueError('Cold-import check requires an empty project library')
    window.import_directory = source.parent
    started = time.monotonic()
    report = {'passed':False, 'initialProjectCount':0, 'heartbeats':0, 'selection':False,
              'freshConversion':False, 'browserRequested':False, 'errors':[]}
    status = {'phase':'picker', 'until':started+2400}

    def write():
        result.parent.mkdir(parents=True, exist_ok=True)
        staging = result.with_suffix('.staging')
        staging.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        staging.replace(result)

    def finish(error=None):
        if error:
            report['errors'].append(str(error))
        report['passed'] = not report['errors'] and report['freshConversion'] and report['browserRequested']
        report['seconds'] = time.monotonic()-started
        write()
        window.server.stop()
        if window.picker:
            window.picker.cancel()
        root.destroy()

    def exception(kind, value, traceback):
        finish(value)
    root.report_callback_exception = exception

    def heartbeat():
        report['heartbeats'] += 1
        root.after(50, heartbeat)

    def browser_visit(request):
        # A genuine default browser request, before Playwright validation starts.
        if request['userAgent'].startswith('Mozilla/'):
            report['browserRequested'] = True
            report['defaultBrowserRequest'] = request
    window.server.on_html_request = browser_visit

    def tick():
        if time.monotonic() > status['until']:
            finish('integration phase timed out: '+status['phase'])
            return
        if status['phase']=='picker':
            picker = window.picker
            if picker and not picker.loading:
                key = next((k for k, row in picker.entries.items() if row==(source.name, False)), None)
                if key is None:
                    finish('source not listed in picker')
                    return
                picker.tree.selection_set(key);picker.selection_changed();picker.open_button.invoke()
                report['selection'] = True
                status['phase'] = 'conversion'
                write()
        elif status['phase']=='conversion' and window.picker is None and window.process is None:
            if window.progress['value']!=8:
                finish(window.message.get())
                return
            rows = window.library.entries()
            if len(rows)!=1 or not window.library.ready(rows[0]):
                finish('converted result is not ready')
                return
            text = window.log_path.read_text(encoding='utf-8')
            if '该文件已导入，使用现有结果' in text:
                finish('conversion reused a cache')
                return
            report.update(freshConversion=True, conversionSeconds=time.monotonic()-started,
                          sourceSha256=rows[0]['id'], counts=rows[0]['counts'],
                          geometry=rows[0]['geometry'], importLog=str(window.log_path))
            status['phase'] = 'browser'
            status['until'] = time.monotonic()+45
            window.start_button.invoke()
            report['url'] = window.demo_url.get()
            write()
        elif status['phase']=='browser':
            if window.browser_outcome:
                report['browserOutcome'] = window.browser_outcome
                if not window.browser_outcome.get('ok'):
                    finish(window.message.get())
                    return
            if report['browserRequested'] and window.browser_outcome and window.browser_outcome.get('ok'):
                # Leave the service live for the separate browser validation.
                report['readyForBrowserValidation'] = True
                status['phase'] = 'validation'
                status['until'] = time.monotonic()+900
                write()
        elif status['phase']=='validation' and result.with_suffix('.done').exists():
            finish()
            return
        root.after(100, tick)

    root.after(0, heartbeat)
    root.after(20, window.import_button.invoke)
    root.after(50, tick)
    root.mainloop()
    return 0 if report['passed'] else 1
