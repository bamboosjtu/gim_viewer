"""Display identity from source metadata, independent of sample/file aliases."""
import hashlib
from pathlib import Path
import re
from archive_index import archive_index
from extract_gim import parse_kv, read_text

EMPTY={'','/','-','null','none','unknown','未命名','无','工程名称','项目名称','变电工程','变电站','project','unnamed'}
def clean(value):
    text=' '.join(str(value or '').replace('\x00',' ').split()).strip()
    return '' if text.casefold() in EMPTY else text
def voltage(value, numeric=False):
    text=clean(value)
    m=re.search(r'(\d+(?:\.\d+)?)\s*(千伏|kv|伏|v)(?![a-z])',text,re.I) if text else None
    if m:
        n=float(m[1]);return n/1000 if m[2].lower() in ('v','伏') else n
    if numeric and re.fullmatch(r'\d+(?:\.\d+)?',text):return float(text)
    return None
def header_segments(raw):
    if raw[:7] not in (b'GIMPKGS',b'GIMPKGT'):return []
    offset=raw.find(bytes.fromhex('377abcaf271c'))
    if offset<7:return []
    result=[]
    for part in re.split(b'\x00+',raw[7:offset].lstrip(b'\0'),maxsplit=12):
        if not part:continue
        try:text=part.decode('utf-8-sig')
        except UnicodeDecodeError:text=part.decode('gb18030','replace')
        result.append(clean(text))
    return result
def looks_like_project(text):
    if not text or re.search(r'设计院|设计公司|勘测院|有限公司|QGDW|^\d{4}[-/]\d',text,re.I):return False
    if re.fullmatch(r'(?:\d+(?:\.\d+)?\s*(?:kV|千伏)\s*)?(?:变电站|工程|变电工程)',text,re.I):return False
    return bool(re.search(r'变电站|工程|项目|电站|substation|project|station|站$',text,re.I))
def describe_project(source, extract=None, *, source_sha256=None):
    source=Path(source)
    # Import already hashes while copying. Metadata only needs the container
    # header, so reuse that identity instead of reading/hashing the GIM again.
    with source.open('rb') as stream:
        raw=bytearray()
        while block:=stream.read(4096):
            raw.extend(block)
            if bytes.fromhex('377abcaf271c') in raw:break
    raw=bytes(raw)
    if source_sha256 is None:
        with source.open('rb') as stream:source_sha256=hashlib.file_digest(stream,'sha256').hexdigest()
    digest=source_sha256
    fields=header_segments(raw);name='';name_source=None;kv=None;kv_source=None
    # These GIMPKGS layouts place the descriptive project text first. Do not
    # blindly take the second segment: it can be the design organization.
    if fields and looks_like_project(fields[0]):name=fields[0];name_source='container-project-text'
    elif len(fields)>1 and re.fullmatch(r'[A-Za-z0-9_.-]+',fields[0]) and looks_like_project(fields[1]):
        name=fields[1];name_source='container-id-and-project-text'
    if extract:
        index=archive_index(str(Path(extract).resolve()))
        project=index.resolve('project.cbm')
        root={}
        if project:
            for line in read_text(project).splitlines():
                if '=' in line:
                    key,value=line.split('=',1);root[key.strip().upper()]=value.strip()
        for key in ('工程名称','项目名称','PROJECTNAME','ENGINEERINGNAME','PROJECT.NAME','PROJECT_NAME','NAME'):
            candidate=clean(root.get(key))
            if candidate:name=candidate;name_source='project.cbm:'+key;break
        for key in ('电压等级','额定电压','VOLTAGE','VOLTAGELEVEL','VOLTAGE_LEVEL'):
            kv=voltage(root.get(key),numeric=True)
            if kv is not None:kv_source='project.cbm:'+key;break
        if kv is None and fields:
            kv=voltage(fields[0]);kv_source='container-project-text' if kv is not None else None
        if kv is None and not name:
            values=[]
            for paths in index.exact.values():
                for p in paths:
                    if p.suffix.casefold()!='.cbm':continue
                    data=parse_kv(read_text(p))
                    if not re.fullmatch(r'F[123]System',data.get('ENTITYNAME',''),re.I):continue
                    for key,value in data.items():
                        if key.startswith('SYSTEMNAME'):
                            v=voltage(value)
                            if v is not None:values.append(v)
            if values:kv=max(values);kv_source='highest-explicit-system-voltage'
    elif fields:
        kv=voltage(fields[0]);kv_source='container-project-text' if kv is not None else None
    prefix=(f'{kv:g}千伏' if kv is not None else '未知电压')+'变电站'
    return {'projectName':name or None,'displayName':name or f'{prefix}#{digest[:6]}',
        'nameSource':name_source or 'voltage-and-source-sha256','voltageKv':kv,'voltageSource':kv_source,'sourceSha256':digest}
