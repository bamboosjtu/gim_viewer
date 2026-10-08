"""Read six source packages, extract text fixtures into ignored output; never alter demo."""
from pathlib import Path
import hashlib,io,json,py7zr
from py7zr.io import BytesIOFactory
root=Path(__file__).resolve().parents[2]
out=root/'output/mobile-samples'
out.mkdir(parents=True,exist_ok=True)
for i in range(1,7):
    sid=f'line{i:02}'
    data=(root/f'demo/{sid}.gim').read_bytes()
    assert data.startswith(b'GIMPKGT'),sid
    offset=data[:1024*1024].find(b'7z\xbc\xaf\x27\x1c')
    assert offset>0
    factory=BytesIOFactory(64*1024*1024)
    with py7zr.SevenZipFile(io.BytesIO(data[offset:])) as archive:
        names=archive.getnames()
        targets=[n for n in names if Path(n).suffix.lower() in ('.cbm','.fam','.dev','.phm','.mod')]
        archive.extract(targets=targets,factory=factory)
    files=[{'path':name,'text':factory.get(name).read().decode('utf-8-sig')} for name in targets]
    (out/f'{sid}.json').write_text(json.dumps({'identity':{'id':sid,'name':sid,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)},'files':files},ensure_ascii=False),encoding='utf-8')
    print(sid,len(names),len(files),hashlib.sha256(data).hexdigest(),flush=True)
