"""Shared source DTOs and workspace temporary directory for this tool's tests."""
from pathlib import Path
import os,sys,tempfile
TOOL=Path(__file__).resolve().parents[1]
TEMP=TOOL.parents[1]/'tmp/tests/gim-element';TEMP.mkdir(parents=True,exist_ok=True)
os.environ.update(TEMP=str(TEMP),TMP=str(TEMP),TMPDIR=str(TEMP));tempfile.tempdir=str(TEMP)
sys.path.insert(0,str(TOOL))
def record(source):return {'id':source['id'],'name':source.get('name',source['id']),'source_type':source['type'],'parent':source.get('parent',''),'source':source['id']+'.dev','track':'dev','attributeOnly':source.get('attributeOnly',False),'relations':source.get('relations',[]),'declaredHosts':[r['targetSourceId'] for r in source.get('relations',[])],'declaredHostEvidence':{r['targetSourceId']:r['evidence'] for r in source.get('relations',[])},'properties':[{'keys':[k],'value':v,'path':'attributes.fam','line':i} for i,(k,v) in enumerate(source.get('props',{}).items(),1)]}
class MemoryFile:
    def __init__(self,text):self.text=text;self.reads=0
    def read_bytes(self):self.reads+=1;return self.text.encode('utf-8')
