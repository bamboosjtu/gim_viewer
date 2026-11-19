"""Verify only the converter's own frozen files and manifest."""
import hashlib
import json
from pathlib import Path

def verify_snapshot(root: Path) -> int:
    root = root.resolve()
    manifest = json.loads((root / 'snapshot.json').read_text(encoding='utf-8'))
    for row in manifest['files']:
        file = (root / row['path']).resolve()
        if not file.is_relative_to(root):
            raise ValueError(f"Snapshot path outside tool: {row['path']}")
        # The manifest hashes canonical LF source bytes on every checkout.
        lf_bytes = file.read_bytes().replace(b'\r\n', b'\n')
        if hashlib.sha256(lf_bytes).hexdigest() != row['sha256']:
            raise ValueError(f"Snapshot hash mismatch: {row['path']}")
    return len(manifest['files'])


if __name__ == '__main__':
    count = verify_snapshot(Path(__file__).resolve().parent)
    print(f'Verified {count} frozen converter files')
