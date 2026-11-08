from pathlib import Path
import os
_TEST_TEMP = Path(__file__).resolve().parents[3] / 'tmp/tests/python'
_TEST_TEMP.mkdir(parents=True, exist_ok=True)
os.environ.update(TEMP=str(_TEST_TEMP), TMP=str(_TEST_TEMP), TMPDIR=str(_TEST_TEMP), GIM_READER_LOG_PATH=str(_TEST_TEMP / 'gim-reader.log'))
import contextlib
import io
import sys
import tempfile
tempfile.tempdir = str(_TEST_TEMP)
import unittest
from unittest.mock import patch

TOOL = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(TOOL), str(TOOL.parent / 'tests')]
import cli
from fixtures import information_sources, write_sources


class CliTests(unittest.TestCase):
    def test_chinese_smoke_output_works_with_a_cp1252_inherited_pipe(self):
        with tempfile.TemporaryDirectory() as directory:
            source = write_sources(directory, information_sources())
            output = io.BytesIO()
            stream = io.TextIOWrapper(output, encoding='cp1252', errors='strict')
            with patch.object(sys, 'argv', ['gim_reader.exe', '--smoke', str(source)]), contextlib.redirect_stdout(stream):
                self.assertIsNone(cli.main())
                stream.flush()
                text = output.getvalue().decode('utf-8')
                self.assertIn('目录:', text)
                self.assertIn('多义 2', text)
                self.assertIn('引用链清单:', text)

    def test_automated_failure_prints_utf8_and_returns_nonzero_without_raising(self):
        output = io.BytesIO()
        stream = io.TextIOWrapper(output, encoding='cp1252', errors='strict')
        with patch.object(sys, 'argv', ['gim_reader.exe', '--smoke', 'fixture']), \
                patch.object(cli, 'Index', side_effect=RuntimeError('模拟解析失败')), \
                patch.object(cli, '_log') as log, contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(stream):
            self.assertEqual(cli.main(), 1)
            stream.flush()
            self.assertIn('模拟解析失败', output.getvalue().decode('utf-8'))
            log.assert_called_once()

    def test_interactive_failures_are_not_silently_swallowed(self):
        with patch.object(sys, 'argv', ['gim_reader.exe', 'fixture']), \
                patch('browse_gui.run_browser', side_effect=RuntimeError('interactive failure')), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'interactive failure'):
                cli.main()

    def test_automation_exits_when_windowed_streams_are_missing_or_closed(self):
        closed = io.StringIO()
        closed.close()
        for stream in (None, closed):
            with self.subTest(stream=stream), \
                    patch.object(sys, 'argv', ['gim_reader.exe', '--smoke', 'fixture']), \
                    patch.object(cli, 'Index', side_effect=RuntimeError('模拟错误')), \
                    patch.object(cli, '_log') as log, \
                    contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                self.assertEqual(cli.main(), 1)
                log.assert_called_once()
