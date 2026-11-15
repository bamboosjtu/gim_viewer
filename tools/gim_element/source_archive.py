"""Semantic-only archive input owned by the standalone tool."""
import io,os,zipfile

EXTENSIONS=('.cbm','.dev','.fam','.ifc')
MAGIC_7Z=b'7z\xbc\xaf\x27\x1c'

class MemorySource:
    def __init__(self,buffer):self.buffer=buffer
    def read_bytes(self):
        self.buffer.seek(0);return self.buffer.read()

class PayloadFile(io.RawIOBase):
    """Seekable view of the existing GIMPKG payload, without a temporary copy."""
    def __init__(self,file,offset):self.file=file;self.offset=offset;file.seek(offset)
    def read(self,size=-1):return self.file.read(size)
    def readable(self):return True
    def seekable(self):return True
    def tell(self):return self.file.tell()-self.offset
    def seek(self,offset,whence=os.SEEK_SET):
        self.file.seek(offset+self.offset if whence==os.SEEK_SET else offset,whence);return self.tell()

def read_archive(path):
    with open(path,'rb') as file:
        head=file.read(8192);file.seek(0)
        if head.startswith(b'PK'):
            with zipfile.ZipFile(file) as archive:
                entries=[info for info in archive.infolist() if not info.is_dir()];names=[info.filename for info in entries]
                return 'zip',{name:MemorySource(io.BytesIO(archive.read(name))) for name in names if name.lower().endswith(EXTENSIONS)},len(names)
        kind='raw7z' if head.startswith(MAGIC_7Z) else 'gimpkg' if head.startswith(b'GIMPKG') else 'unknown'
        if kind=='unknown':raise ValueError('无法识别的容器格式（既非 GIMPKG 头也非 7z/zip）')
        offset=head.find(MAGIC_7Z)
        if offset<0:raise ValueError('未找到 7z 签名，容器可能损坏或加密')
        import py7zr
        from py7zr.io import BytesIOFactory
        with py7zr.SevenZipFile(PayloadFile(file,offset)) as archive:
            if archive.needs_password():raise ValueError('压缩包已加密，暂不支持')
            names=[info.filename for info in archive.list() if not info.is_directory];selected=[name for name in names if name.lower().endswith(EXTENSIONS)]
            factory=BytesIOFactory(limit=2**63-1)
            archive.extract(targets=selected,factory=factory)
            return kind,{name:MemorySource(factory.get(name)) for name in selected},len(names)
