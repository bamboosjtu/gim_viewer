"""Verify only the converter's own frozen files and manifest."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
manifest = json.loads((ROOT / 'snapshot.json').read_text(encoding='utf-8'))
for row in manifest['files']:
    file = (ROOT / row['path']).resolve()
    if not file.is_relative_to(ROOT):
        raise ValueError(f"Snapshot path outside tool: {row['path']}")
    raw = file.read_bytes()
    recorded = row['sha256']
    # Git on Windows may check text out with CRLF.
    if recorded not in (
        hashlib.sha256(raw).hexdigest(),
        hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest(),
    ):
        raise ValueError(f"Snapshot hash mismatch: {row['path']}")
print(f"Verified {len(manifest['files'])} frozen converter files")
