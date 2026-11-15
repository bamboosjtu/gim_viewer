"""Shared immutable path inventory; materialization never re-scans a package."""
from functools import lru_cache
from pathlib import Path, PurePosixPath
import posixpath


class ArchiveIndex:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.exact = {}
        self.basenames = {}
        self.scan_count = 1
        for p in sorted(self.root.rglob('*')):
            if not p.is_file():
                continue
            if p.is_symlink():
                raise ValueError('archive symlink is not an ordinary source entry')
            key = p.relative_to(self.root).as_posix().casefold()
            self.exact.setdefault(key, []).append(p)
            self.basenames.setdefault(p.name.casefold(), []).append(p)

    def resolve(self, reference):
        key = posixpath.normpath(str(reference).replace('\\', '/')).lstrip('./').casefold()
        matches = self.exact.get(key) or self.basenames.get(PurePosixPath(key).name) or []
        if len(matches) > 1:
            raise ValueError(f'ambiguous archive reference: {reference}')
        return str(matches[0]) if matches else None


@lru_cache(maxsize=8)
def archive_index(root):
    return ArchiveIndex(root)
