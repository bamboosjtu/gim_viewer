"""Keep frozen smoke-test diagnostics available without opening a console."""
import sys
from pathlib import Path

if '--smoke' in sys.argv:
    index = sys.argv.index('--smoke')
    if len(sys.argv) > index + 2:
        log = open(Path(sys.argv[index + 2] + '.log'), 'w', encoding='utf-8', buffering=1)
        sys.stdout = log
        sys.stderr = log
